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

export class InMemoryEventBus {
  readonly #handlers = new Set<EventHandler>();

  publish(event: CoreEvent): Effect.Effect<void> {
    return Effect.fn("InMemoryEventBus.publish")(() =>
      Effect.all(
        [...this.#handlers].map((handler) => handler(event)),
        {
          concurrency: "unbounded",
          discard: true,
        },
      ),
    )();
  }

  subscribe(handler: EventHandler): EventSubscription {
    this.#handlers.add(handler);
    return {
      unsubscribe: () =>
        Effect.sync(() => {
          this.#handlers.delete(handler);
        }),
    };
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
