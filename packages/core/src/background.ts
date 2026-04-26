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

      self.#jobs.set(job.id, job);
      if (self.#audit) {
        yield* self.#audit.record({
          type: "background.job.created",
          jobId: job.id,
          status: job.status,
        });
      }
      return job;
    })();
  }

  cancel(jobId: string): Effect.Effect<boolean> {
    const self = this;
    return Effect.fn("BackgroundJobScheduler.cancel")(function* () {
      const job = self.#jobs.get(jobId);
      if (!job || job.status !== "scheduled") {
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
}
