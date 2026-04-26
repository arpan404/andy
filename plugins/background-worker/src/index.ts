import {
  optionalNumber,
  optionalString,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonValue } from "@andy/types";
import { Effect } from "effect";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

type BackgroundJob = {
  id: string;
  status: "queued" | "scheduled" | "running" | "cancelled";
  taskName: string;
  payload: JsonValue;
  toolName?: string;
  runAt?: string;
  createdAt: string;
  updatedAt: string;
};

const environment = process.env as {
  ANDY_PLUGIN_STORAGE_ROOT?: string;
};

const storageRoot = environment.ANDY_PLUGIN_STORAGE_ROOT ?? process.cwd();
const jobsPath = join(storageRoot, "background-jobs.json");

startWorkerPlugin((request) =>
  Effect.fn("background-worker.handleRequest")(function* () {
    switch (request.toolName) {
      case "background.run":
        return yield* runJob(request.input);
      case "background.schedule":
        return yield* scheduleJob(request.input);
      case "background.cancel":
        return yield* cancelJob(request.input);
      default:
        return yield* Effect.fail(
          new Error(`Unknown background-worker tool '${request.toolName}'.`),
        );
    }
  })(),
);

function runJob(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("background-worker.run")(function* () {
    const parsed = requireObject(input, "background.run");
    const taskName = requireString(parsed, "taskName");
    const { payload } = parsed as { payload?: JsonValue };
    const jobs = yield* loadJobs();
    const now = new Date().toISOString();
    const toolName = optionalString(parsed, "toolName");
    const job: BackgroundJob = {
      id: optionalString(parsed, "id") ?? randomUUID(),
      status: "queued",
      taskName,
      payload: payload ?? {},
      createdAt: now,
      updatedAt: now,
    };
    if (toolName) {
      job.toolName = toolName;
    }
    jobs.push(job);
    yield* saveJobs(jobs);
    return job;
  })();
}

function scheduleJob(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("background-worker.schedule")(function* () {
    const parsed = requireObject(input, "background.schedule");
    const taskName = requireString(parsed, "taskName");
    const { payload } = parsed as { payload?: JsonValue };
    const delayMs = optionalNumber(parsed, "delayMs");
    const runAt =
      optionalString(parsed, "runAt") ??
      new Date(Date.now() + Math.max(0, delayMs ?? 0)).toISOString();
    const jobs = yield* loadJobs();
    const now = new Date().toISOString();
    const toolName = optionalString(parsed, "toolName");
    const job: BackgroundJob = {
      id: optionalString(parsed, "id") ?? randomUUID(),
      status: "scheduled",
      taskName,
      payload: payload ?? {},
      runAt,
      createdAt: now,
      updatedAt: now,
    };
    if (toolName) {
      job.toolName = toolName;
    }
    jobs.push(job);
    yield* saveJobs(jobs);
    return job;
  })();
}

function cancelJob(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("background-worker.cancel")(function* () {
    const parsed = requireObject(input, "background.cancel");
    const id = requireString(parsed, "id");
    const jobs = yield* loadJobs();
    const job = jobs.find((candidate) => candidate.id === id);
    if (!job) {
      return yield* Effect.fail(new Error(`Unknown background job '${id}'.`));
    }
    job.status = "cancelled";
    job.updatedAt = new Date().toISOString();
    yield* saveJobs(jobs);
    return job;
  })();
}

function loadJobs(): Effect.Effect<BackgroundJob[], unknown> {
  return Effect.tryPromise(async () => {
    try {
      const raw = await readFile(jobsPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isBackgroundJob) : [];
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  });
}

function saveJobs(jobs: readonly BackgroundJob[]): Effect.Effect<void, unknown> {
  return Effect.tryPromise(async () => {
    await mkdir(storageRoot, { recursive: true });
    await writeFile(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
  });
}

function isBackgroundJob(value: unknown): value is BackgroundJob {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<BackgroundJob>;
  return typeof record.id === "string" && typeof record.taskName === "string";
}
