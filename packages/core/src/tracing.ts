import { Effect } from "effect";
import type { InMemoryEventBus } from "./events.js";

export interface TraceContext {
  traceId: string;
  parentTraceId?: string;
  name: string;
  startedAt: Date;
}

export class TraceManager {
  readonly #eventBus: InMemoryEventBus;

  constructor(options: { eventBus: InMemoryEventBus }) {
    this.#eventBus = options.eventBus;
  }

  start(input: { name: string; parentTraceId?: string }): Effect.Effect<TraceContext> {
    const self = this;
    return Effect.fn("TraceManager.start")(function* () {
      const trace: TraceContext = {
        traceId: crypto.randomUUID(),
        name: input.name,
        startedAt: new Date(),
      };
      if (input.parentTraceId) {
        trace.parentTraceId = input.parentTraceId;
      }
      const event = {
        type: "trace.started" as const,
        traceId: trace.traceId,
        name: trace.name,
        ...(trace.parentTraceId ? { parentTraceId: trace.parentTraceId } : {}),
      };
      yield* self.#eventBus.publish({
        ...event,
      });
      return trace;
    })();
  }

  complete(trace: TraceContext): Effect.Effect<void> {
    return Effect.fn("TraceManager.complete")(() =>
      this.#eventBus.publish({
        type: "trace.completed",
        traceId: trace.traceId,
        name: trace.name,
        ...(trace.parentTraceId ? { parentTraceId: trace.parentTraceId } : {}),
      }),
    )();
  }
}
