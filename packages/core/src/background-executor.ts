import type { AuditSink } from "@andy/audit";
import { Effect } from "effect";
import type { BackgroundJob, BackgroundJobScheduler } from "./background.js";
import type { AgentRuntime, ToolExecutionContext } from "./runtime.js";
import type { AgentRuntimeError } from "./errors.js";
import type { ToolExecutionResult } from "./types.js";

export interface BackgroundJobExecutorOptions {
  audit: AuditSink;
  scheduler: BackgroundJobScheduler;
  runtime: AgentRuntime;
  saveState?: () => Effect.Effect<void, unknown>;
}

export class BackgroundJobExecutor {
  readonly #audit: AuditSink;
  readonly #scheduler: BackgroundJobScheduler;
  readonly #runtime: AgentRuntime;
  readonly #saveState: (() => Effect.Effect<void, unknown>) | undefined;

  constructor(options: BackgroundJobExecutorOptions) {
    this.#audit = options.audit;
    this.#scheduler = options.scheduler;
    this.#runtime = options.runtime;
    this.#saveState = options.saveState;
  }

  runDue(
    now = new Date(),
  ): Effect.Effect<readonly ToolExecutionResult[], AgentRuntimeError> {
    const self = this;
    return Effect.fn("BackgroundJobExecutor.runDue")(function* () {
      const jobs = yield* self.#scheduler.due(now);
      const results: ToolExecutionResult[] = [];
      for (const job of jobs) {
        const result = yield* self.runJob(job);
        results.push(result);
      }
      return results;
    })();
  }

  runJob(job: BackgroundJob): Effect.Effect<ToolExecutionResult, AgentRuntimeError> {
    const self = this;
    return Effect.fn("BackgroundJobExecutor.runJob")(function* () {
      yield* self.#scheduler.updateStatus(job.id, "running");
      yield* self.#persist();
      const context = createBackgroundContext(job);
      const result = yield* self.#runtime
        .executeTool(job.toolName, job.input, context)
        .pipe(Effect.tapError(() => self.#scheduler.updateStatus(job.id, "failed")));
      yield* self.#scheduler.updateProgress(job.id, {
        completed: true,
        runId: result.runId,
      });
      yield* self.#scheduler.updateStatus(job.id, "completed");
      yield* self.#audit.record({
        type: "background.job.updated",
        jobId: job.id,
        status: "completed",
        traceId: job.traceId,
      });
      yield* self.#persist();
      return result;
    })();
  }

  #persist(): Effect.Effect<void> {
    return this.#saveState ? this.#saveState().pipe(Effect.ignore) : Effect.void;
  }
}

function createBackgroundContext(job: BackgroundJob): ToolExecutionContext {
  return {
    taskId: job.id,
    ...(job.traceId ? { traceId: job.traceId } : {}),
    ...(job.cancellationTokenId
      ? { cancellationTokenId: job.cancellationTokenId }
      : {}),
  };
}
