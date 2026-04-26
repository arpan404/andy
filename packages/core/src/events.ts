import type { AuditEvent } from "@andy/audit";
import { Effect } from "effect";

export type CoreEvent =
  | AuditEvent
  | {
      type: "trace.started" | "trace.completed";
      traceId: string;
      parentTraceId?: string;
      name: string;
    };

export interface EventSubscription {
  unsubscribe(): Effect.Effect<void>;
}

export type EventHandler = (event: CoreEvent) => Effect.Effect<void>;

export interface EventEnvelope {
  sequence: number;
  event: CoreEvent;
  publishedAt: Date;
}

export class InMemoryEventBus {
  readonly #handlers = new Set<EventHandler>();
  readonly #events: EventEnvelope[] = [];
  readonly #maxReplayEvents: number;
  #nextSequence = 1;

  constructor(options: { maxReplayEvents?: number } = {}) {
    this.#maxReplayEvents = options.maxReplayEvents ?? 10_000;
  }

  publish(event: CoreEvent): Effect.Effect<void> {
    return Effect.fn("InMemoryEventBus.publish")(() =>
      Effect.sync(() => {
        this.#events.push({
          sequence: this.#nextSequence,
          event,
          publishedAt: new Date(),
        });
        this.#nextSequence += 1;
        while (this.#events.length > this.#maxReplayEvents) {
          this.#events.shift();
        }
      }).pipe(
        Effect.zipRight(
          Effect.all(
            [...this.#handlers].map((handler) => handler(event)),
            {
              concurrency: 16,
              discard: true,
            },
          ),
        ),
      ),
    )();
  }

  subscribe(
    handler: EventHandler,
    options: { replayFromSequence?: number } = {},
  ): EventSubscription {
    this.#handlers.add(handler);
    if (options.replayFromSequence !== undefined) {
      for (const envelope of this.replay(options.replayFromSequence)) {
        Effect.runPromise(handler(envelope.event));
      }
    }
    return {
      unsubscribe: () =>
        Effect.sync(() => {
          this.#handlers.delete(handler);
        }),
    };
  }

  replay(fromSequence = 1): readonly EventEnvelope[] {
    return this.#events.filter((event) => event.sequence >= fromSequence);
  }

  hydrate(events: readonly EventEnvelope[]): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#events.length = 0;
      this.#events.push(
        ...events
          .map((event) => ({
            ...event,
            publishedAt: new Date(event.publishedAt),
          }))
          .sort((a, b) => a.sequence - b.sequence)
          .slice(-this.#maxReplayEvents),
      );
      this.#nextSequence =
        Math.max(0, ...this.#events.map((event) => event.sequence)) + 1;
    });
  }
}

export class EventBusAuditSink {
  readonly #eventBus: InMemoryEventBus;

  constructor(eventBus: InMemoryEventBus) {
    this.#eventBus = eventBus;
  }

  record(event: AuditEvent): Effect.Effect<void> {
    return this.#eventBus.publish(event);
  }
}
