import type { PluginRuntimeRecord } from "./runtime.js";
import type { AgentSession } from "./types.js";
import type { ApprovalRequest } from "./approvals.js";
import type { BackgroundJob } from "./background.js";
import type { TraceContext } from "./tracing.js";
import type { EventEnvelope } from "./events.js";
import type { SecretReference } from "./secrets.js";
import type { ApprovalActionDescriptor } from "./approval-resume.js";
import { Effect } from "effect";
import { stringifyCause } from "./utils.js";
import { CoreStateStoreError } from "./errors.js";
import { AtomicJsonFileStore } from "./transactional-store.js";

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
  readonly #store: AtomicJsonFileStore<CoreStateSnapshot>;

  constructor(path: string) {
    this.#path = path;
    this.#store = new AtomicJsonFileStore({
      path,
      schemaVersion: 1,
      parse: normalizeCoreStateSnapshot,
    });
  }

  save(snapshot: CoreStateSnapshot): Effect.Effect<void, CoreStateStoreError> {
    return Effect.fn("JsonFileCoreStateStore.save")(() =>
      this.#store.save(snapshot).pipe(
        Effect.mapError(
          (cause) =>
            new CoreStateStoreError({
              path: this.#path,
              message: `Failed to save core state to '${this.#path}'.`,
              cause: stringifyCause(cause),
            }),
        ),
      ),
    )();
  }

  load(): Effect.Effect<CoreStateSnapshot | undefined, CoreStateStoreError> {
    return Effect.fn("JsonFileCoreStateStore.load")(() =>
      this.#store.load().pipe(
        Effect.mapError(
          (cause) =>
            new CoreStateStoreError({
              path: this.#path,
              message: `Failed to load core state from '${this.#path}'.`,
              cause: stringifyCause(cause),
            }),
        ),
      ),
    )();
  }
}

function normalizeCoreStateSnapshot(value: unknown): CoreStateSnapshot {
  const record =
    typeof value === "object" && value !== null
      ? (value as Partial<CoreStateSnapshot>)
      : {};
  return {
    plugins: Array.isArray(record.plugins) ? record.plugins : [],
    sessions: Array.isArray(record.sessions) ? record.sessions : [],
    approvals: Array.isArray(record.approvals) ? record.approvals : [],
    backgroundJobs: Array.isArray(record.backgroundJobs) ? record.backgroundJobs : [],
    ...(Array.isArray(record.auditTraces) ? { auditTraces: record.auditTraces } : {}),
    ...(Array.isArray(record.events) ? { events: record.events } : {}),
    ...(record.config && typeof record.config === "object"
      ? { config: record.config as Record<string, unknown> }
      : {}),
    ...(Array.isArray(record.secretReferences)
      ? { secretReferences: record.secretReferences }
      : {}),
    ...(Array.isArray(record.approvalActions)
      ? { approvalActions: record.approvalActions }
      : {}),
  };
}
