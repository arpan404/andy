import type { PluginRuntimeRecord } from "./runtime.js";
import type { AgentSession } from "./types.js";
import type { ApprovalRequest } from "./approvals.js";
import type { BackgroundJob } from "./background.js";
import type { TraceContext } from "./tracing.js";
import type { EventEnvelope } from "./events.js";
import type { SecretReference } from "./secrets.js";
import type { ApprovalActionDescriptor } from "./approval-resume.js";
import { Effect } from "effect";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stringifyCause } from "./utils.js";
import { CoreStateStoreError } from "./errors.js";

export interface CoreStateSnapshot {
  plugins: readonly PluginRuntimeRecord[];
  sessions: readonly AgentSession[];
  approvals: readonly ApprovalRequest[];
  backgroundJobs: readonly BackgroundJob[];
  auditTraces?: readonly TraceContext[];
  events?: readonly EventEnvelope[];
  config?: Record<string, unknown>;
  secretReferences?: readonly Omit<SecretReference, "value">[];
  approvalActions?: readonly {
    approval: ApprovalRequest;
    descriptor: ApprovalActionDescriptor;
  }[];
}

export interface CoreStateStore {
  save(snapshot: CoreStateSnapshot): Effect.Effect<void, CoreStateStoreError>;
  load(): Effect.Effect<CoreStateSnapshot | undefined, CoreStateStoreError>;
}

export class InMemoryCoreStateStore implements CoreStateStore {
  #snapshot: CoreStateSnapshot | undefined;

  save(snapshot: CoreStateSnapshot): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#snapshot = snapshot;
    });
  }

  load(): Effect.Effect<CoreStateSnapshot | undefined> {
    return Effect.succeed(this.#snapshot);
  }
}

export class JsonFileCoreStateStore implements CoreStateStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  save(snapshot: CoreStateSnapshot): Effect.Effect<void, CoreStateStoreError> {
    return Effect.fn("JsonFileCoreStateStore.save")(() =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(this.#path), { recursive: true });
          await writeFile(this.#path, JSON.stringify(snapshot, null, 2), "utf8");
        },
        catch: (cause) =>
          new CoreStateStoreError({
            path: this.#path,
            message: `Failed to save core state to '${this.#path}'.`,
            cause: stringifyCause(cause),
          }),
      }),
    )();
  }

  load(): Effect.Effect<CoreStateSnapshot | undefined, CoreStateStoreError> {
    return Effect.fn("JsonFileCoreStateStore.load")(() =>
      Effect.tryPromise({
        try: async () => {
          try {
            const text = await readFile(this.#path, "utf8");
            return JSON.parse(text) as CoreStateSnapshot;
          } catch (cause) {
            if (isFileNotFound(cause)) {
              return undefined;
            }
            throw cause;
          }
        },
        catch: (cause) =>
          new CoreStateStoreError({
            path: this.#path,
            message: `Failed to load core state from '${this.#path}'.`,
            cause: stringifyCause(cause),
          }),
      }),
    )();
  }
}

function isFileNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}
