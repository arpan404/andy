import { Effect } from "effect";
import type { JsonValue } from "@andy/types";
import type { AuditSink } from "@andy/audit";

export type BackgroundJobStatus =
  | "scheduled"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export interface BackgroundJob {
  id: string;
  pluginId: string;
  toolName: string;
  input: JsonValue;
  status: BackgroundJobStatus;
  createdAt: Date;
  updatedAt: Date;
  runAfter?: Date;
  progress?: JsonValue;
  traceId?: string;
  cancellationTokenId?: string;
}

export class BackgroundJobScheduler {
  readonly #audit: AuditSink | undefined;
  readonly #jobs = new Map<string, BackgroundJob>();

  constructor(options: { audit?: AuditSink } = {}) {
    this.#audit = options.audit;
  }

  schedule(
    input: Omit<BackgroundJob, "id" | "status" | "createdAt" | "updatedAt">,
  ): Effect.Effect<BackgroundJob> {
    const self = this;
    return Effect.fn("BackgroundJobScheduler.schedule")(function* () {
      const job: BackgroundJob = {
        id: crypto.randomUUID(),
        pluginId: input.pluginId,
        toolName: input.toolName,
        input: input.input,
        status: "scheduled",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      if (input.runAfter) {
        job.runAfter = input.runAfter;
      }
      if (input.traceId) {
        job.traceId = input.traceId;
      }
      if (input.cancellationTokenId) {
        job.cancellationTokenId = input.cancellationTokenId;
      }

      self.#jobs.set(job.id, job);
      if (self.#audit) {
        yield* self.#audit.record({
          type: "background.job.created",
          jobId: job.id,
          status: job.status,
          traceId: job.traceId,
        });
      }
      return job;
    })();
  }

  cancel(jobId: string): Effect.Effect<boolean> {
    const self = this;
    return Effect.fn("BackgroundJobScheduler.cancel")(function* () {
      const job = self.#jobs.get(jobId);
      if (!job || (job.status !== "scheduled" && job.status !== "running")) {
        return false;
      }

      const cancelled: BackgroundJob = {
        ...job,
        status: "cancelled",
        updatedAt: new Date(),
      };
      self.#jobs.set(jobId, cancelled);
      if (self.#audit) {
        yield* self.#audit.record({
          type: "background.job.updated",
          jobId,
          status: cancelled.status,
          traceId: cancelled.traceId,
        });
      }
      return true;
    })();
  }

  updateStatus(
    jobId: string,
    status: BackgroundJobStatus,
  ): Effect.Effect<BackgroundJob | undefined> {
    const self = this;
    return Effect.fn("BackgroundJobScheduler.updateStatus")(function* () {
      const job = self.#jobs.get(jobId);
      if (!job) {
        return undefined;
      }

      const updated: BackgroundJob = {
        ...job,
        status,
        updatedAt: new Date(),
      };
      self.#jobs.set(jobId, updated);
      if (self.#audit) {
        yield* self.#audit.record({
          type: "background.job.updated",
          jobId,
          status,
          traceId: updated.traceId,
        });
      }
      return updated;
    })();
  }

  due(now = new Date()): Effect.Effect<readonly BackgroundJob[]> {
    return Effect.fn("BackgroundJobScheduler.due")(() =>
      Effect.sync(() =>
        [...this.#jobs.values()]
          .filter(
            (job) =>
              job.status === "scheduled" &&
              (!job.runAfter || job.runAfter.getTime() <= now.getTime()),
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      ),
    )();
  }

  list(): Effect.Effect<readonly BackgroundJob[]> {
    return Effect.fn("BackgroundJobScheduler.list")(() =>
      Effect.sync(() =>
        [...this.#jobs.values()].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        ),
      ),
    )();
  }

  updateProgress(
    jobId: string,
    progress: JsonValue,
  ): Effect.Effect<BackgroundJob | undefined> {
    const self = this;
    return Effect.fn("BackgroundJobScheduler.updateProgress")(function* () {
      const job = self.#jobs.get(jobId);
      if (!job) {
        return undefined;
      }

      const updated: BackgroundJob = {
        ...job,
        progress,
        updatedAt: new Date(),
      };
      self.#jobs.set(jobId, updated);
      if (self.#audit) {
        yield* self.#audit.record({
          type: "background.job.progress",
          jobId,
          progress,
          traceId: updated.traceId,
        });
      }
      return updated;
    })();
  }

  hydrate(jobs: readonly BackgroundJob[]): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#jobs.clear();
      for (const job of jobs) {
        this.#jobs.set(job.id, normalizeJobDates(job));
      }
    });
  }
}

function normalizeJobDates(job: BackgroundJob): BackgroundJob {
  return {
    ...job,
    createdAt: new Date(job.createdAt),
    updatedAt: new Date(job.updatedAt),
    ...(job.runAfter ? { runAfter: new Date(job.runAfter) } : {}),
  };
}
