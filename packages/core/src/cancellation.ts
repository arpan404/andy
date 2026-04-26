import { Effect } from "effect";
import type { DurationInput } from "effect/Duration";

export type CancellationStatus = "active" | "cancelled";

export interface CancellationToken {
  id: string;
  status: CancellationStatus;
  reason?: string;
  createdAt: Date;
  cancelledAt?: Date;
}

export class CancellationRegistry {
  readonly #tokens = new Map<string, CancellationToken>();
  readonly #listeners = new Map<string, Set<(token: CancellationToken) => void>>();

  create(): Effect.Effect<CancellationToken> {
    return Effect.fn("CancellationRegistry.create")(() =>
      Effect.sync(() => {
        const token: CancellationToken = {
          id: crypto.randomUUID(),
          status: "active",
          createdAt: new Date(),
        };
        this.#tokens.set(token.id, token);
        return token;
      }),
    )();
  }

  cancel(id: string, reason: string): Effect.Effect<CancellationToken | undefined> {
    return Effect.fn("CancellationRegistry.cancel")(() =>
      Effect.sync(() => {
        const token = this.#tokens.get(id);
        if (!token) {
          return undefined;
        }

        const cancelled: CancellationToken = {
          ...token,
          status: "cancelled",
          reason,
          cancelledAt: new Date(),
        };
        this.#tokens.set(id, cancelled);
        for (const listener of this.#listeners.get(id) ?? []) {
          listener(cancelled);
        }
        this.#listeners.delete(id);
        return cancelled;
      }),
    )();
  }

  get(id: string): CancellationToken | undefined {
    return this.#tokens.get(id);
  }

  waitForCancellation(id: string): Effect.Effect<CancellationToken> {
    return Effect.async<CancellationToken>((resume) => {
      const existing = this.#tokens.get(id);
      if (existing?.status === "cancelled") {
        resume(Effect.succeed(existing));
        return;
      }

      const listener = (token: CancellationToken) => resume(Effect.succeed(token));
      const listeners = this.#listeners.get(id) ?? new Set();
      listeners.add(listener);
      this.#listeners.set(id, listeners);
      return Effect.sync(() => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.#listeners.delete(id);
        }
      });
    });
  }
}

export function withTimeout<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeout: DurationInput,
): Effect.Effect<A, E | TimeoutError, R> {
  return effect.pipe(
    Effect.timeoutFail({
      duration: timeout,
      onTimeout: () =>
        new TimeoutError({
          message: `Operation timed out after ${String(timeout)}.`,
        }),
    }),
  );
}

export class TimeoutError {
  readonly _tag = "TimeoutError";
  readonly message: string;

  constructor(input: { message: string }) {
    this.message = input.message;
  }
}
