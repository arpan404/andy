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
  readonly #traces = new Map<string, TraceContext>();

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
      self.#traces.set(trace.traceId, trace);
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

  child(input: { parent: TraceContext; name: string }): Effect.Effect<TraceContext> {
    return this.start({
      name: input.name,
      parentTraceId: input.parent.traceId,
    });
  }

  list(): readonly TraceContext[] {
    return [...this.#traces.values()].sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
    );
  }

  hydrate(traces: readonly TraceContext[]): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#traces.clear();
      for (const trace of traces) {
        this.#traces.set(trace.traceId, {
          ...trace,
          startedAt: new Date(trace.startedAt),
        });
      }
    });
  }
}
