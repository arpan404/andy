import type { PluginRuntimeRecord } from "./runtime.js";
import type { AgentSession } from "./types.js";
import type { ApprovalRequest } from "./approvals.js";
import type { BackgroundJob } from "./background.js";
import type { TraceContext } from "./tracing.js";
import type { EventEnvelope } from "./events.js";
import type { SecretReference } from "./secrets.js";
import type { ApprovalActionDescriptor } from "./approval-resume.js";
import type { DurableTaskSnapshot } from "./tasks.js";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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
  durableTasks?: DurableTaskSnapshot;
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

type SnapshotDomain =
  | "plugins"
  | "sessions"
  | "approvals"
  | "background_jobs"
  | "audit_traces"
  | "events"
  | "config"
  | "secret_references"
  | "approval_actions"
  | "durable_tasks";

const snapshotDomains: readonly SnapshotDomain[] = [
  "plugins",
  "sessions",
  "approvals",
  "background_jobs",
  "audit_traces",
  "events",
  "config",
  "secret_references",
  "approval_actions",
  "durable_tasks",
];

export class SqliteCoreStateStore implements CoreStateStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  save(snapshot: CoreStateSnapshot): Effect.Effect<void, CoreStateStoreError> {
    return Effect.fn("SqliteCoreStateStore.save")(() =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(this.#path), { recursive: true });
          const db = new Database(this.#path);
          try {
            applySqliteMigrations(db);
            db.exec("BEGIN IMMEDIATE");
            writeSnapshotDomain(db, "plugins", snapshot.plugins);
            writeSnapshotDomain(db, "sessions", snapshot.sessions);
            writeSnapshotDomain(db, "approvals", snapshot.approvals);
            writeSnapshotDomain(db, "background_jobs", snapshot.backgroundJobs);
            writeSnapshotDomain(db, "audit_traces", snapshot.auditTraces ?? []);
            writeSnapshotDomain(db, "events", snapshot.events ?? []);
            writeSnapshotDomain(db, "config", snapshot.config ?? {});
            writeSnapshotDomain(
              db,
              "secret_references",
              snapshot.secretReferences ?? [],
            );
            writeSnapshotDomain(db, "approval_actions", snapshot.approvalActions ?? []);
            writeSnapshotDomain(
              db,
              "durable_tasks",
              snapshot.durableTasks ?? { graphs: [], runs: [] },
            );
            db.exec("COMMIT");
          } catch (cause) {
            db.exec("ROLLBACK");
            throw cause;
          } finally {
            db.close();
          }
        },
        catch: (cause) =>
          new CoreStateStoreError({
            path: this.#path,
            message: `Failed to save core state to SQLite database '${this.#path}'.`,
            cause: stringifyCause(cause),
          }),
      }),
    )();
  }

  load(): Effect.Effect<CoreStateSnapshot | undefined, CoreStateStoreError> {
    return Effect.fn("SqliteCoreStateStore.load")(() =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(this.#path), { recursive: true });
          const db = new Database(this.#path);
          try {
            applySqliteMigrations(db);
            const hasState = snapshotDomains.some(
              (domain) => readSnapshotDomain(db, domain) !== undefined,
            );
            if (!hasState) {
              return undefined;
            }
            return normalizeCoreStateSnapshot({
              plugins: readSnapshotDomain(db, "plugins") ?? [],
              sessions: readSnapshotDomain(db, "sessions") ?? [],
              approvals: readSnapshotDomain(db, "approvals") ?? [],
              backgroundJobs: readSnapshotDomain(db, "background_jobs") ?? [],
              auditTraces: readSnapshotDomain(db, "audit_traces") ?? [],
              events: readSnapshotDomain(db, "events") ?? [],
              config: readSnapshotDomain(db, "config") ?? {},
              secretReferences: readSnapshotDomain(db, "secret_references") ?? [],
              approvalActions: readSnapshotDomain(db, "approval_actions") ?? [],
              durableTasks: readSnapshotDomain(db, "durable_tasks") ?? {
                graphs: [],
                runs: [],
              },
            });
          } finally {
            db.close();
          }
        },
        catch: (cause) =>
          new CoreStateStoreError({
            path: this.#path,
            message: `Failed to load core state from SQLite database '${this.#path}'.`,
            cause: stringifyCause(cause),
          }),
      }),
    )();
  }
}

function applySqliteMigrations(db: Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS core_state_domains (
      domain TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS session_messages (
      session_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY (session_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      status TEXT,
      value_json TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY,
      status TEXT,
      value_json TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      sequence INTEGER PRIMARY KEY,
      value_json TEXT NOT NULL,
      published_at TEXT
    );
    CREATE TABLE IF NOT EXISTS traces (
      trace_id TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      started_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_records (
      id TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS plugins (
      plugin_id TEXT PRIMARY KEY,
      status TEXT,
      value_json TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS skills (
      skill_id TEXT PRIMARY KEY,
      status TEXT,
      value_json TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      scope TEXT,
      type TEXT,
      sensitivity TEXT,
      value_json TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS task_graphs (
      id TEXT PRIMARY KEY,
      name TEXT,
      version TEXT,
      value_json TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      status TEXT,
      idempotency_key TEXT,
      value_json TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS task_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      definition_id TEXT NOT NULL,
      status TEXT,
      attempts INTEGER,
      value_json TEXT NOT NULL,
      updated_at TEXT
    );
  `);
  db.query(
    "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  ).run(1, new Date().toISOString());
}

function writeSnapshotDomain(
  db: Database,
  domain: SnapshotDomain,
  value: unknown,
): void {
  const now = new Date().toISOString();
  db.query(
    "INSERT INTO core_state_domains (domain, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(domain) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
  ).run(domain, JSON.stringify(value), now);
  if (domain === "sessions" && Array.isArray(value)) {
    writeSessionRows(db, value, now);
  } else if (domain === "approvals" && Array.isArray(value)) {
    writeEntityRows(db, "approvals", "id", value, now);
  } else if (domain === "background_jobs" && Array.isArray(value)) {
    writeEntityRows(db, "background_jobs", "id", value, now);
  } else if (domain === "events" && Array.isArray(value)) {
    writeEventRows(db, value);
  } else if (domain === "audit_traces" && Array.isArray(value)) {
    writeTraceRows(db, value);
  } else if (domain === "durable_tasks" && isRecord(value)) {
    writeDurableTaskRows(db, value);
  }
}

function readSnapshotDomain(db: Database, domain: SnapshotDomain): unknown {
  const row = db
    .query("SELECT value_json FROM core_state_domains WHERE domain = ?")
    .get(domain) as { value_json?: unknown } | null;
  return typeof row?.value_json === "string" ? JSON.parse(row.value_json) : undefined;
}

function writeSessionRows(
  db: Database,
  sessions: readonly unknown[],
  now: string,
): void {
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM session_messages").run();
  const insertSession = db.query(
    "INSERT INTO sessions (id, value_json, updated_at) VALUES (?, ?, ?)",
  );
  const insertMessage = db.query(
    "INSERT INTO session_messages (session_id, ordinal, value_json) VALUES (?, ?, ?)",
  );
  for (const session of sessions) {
    if (!isRecord(session)) {
      continue;
    }
    const { id, updatedAt: updatedAtValue, messages: messagesValue } = session;
    if (typeof id !== "string") {
      continue;
    }
    const sessionId = id;
    const updatedAt = typeof updatedAtValue === "string" ? updatedAtValue : now;
    insertSession.run(sessionId, JSON.stringify(session), updatedAt);
    const messages = Array.isArray(messagesValue) ? messagesValue : [];
    messages.forEach((message, index) => {
      insertMessage.run(sessionId, index, JSON.stringify(message));
    });
  }
}

function writeEntityRows(
  db: Database,
  table: "approvals" | "background_jobs",
  idKey: string,
  values: readonly unknown[],
  now: string,
): void {
  db.query(`DELETE FROM ${table}`).run();
  const insert = db.query(
    `INSERT INTO ${table} (id, status, value_json, updated_at) VALUES (?, ?, ?, ?)`,
  );
  for (const value of values) {
    if (!isRecord(value) || typeof value[idKey] !== "string") {
      continue;
    }
    const { status: statusValue, updatedAt: updatedAtValue } = value;
    const status = typeof statusValue === "string" ? statusValue : null;
    const updatedAt = typeof updatedAtValue === "string" ? updatedAtValue : now;
    insert.run(value[idKey], status, JSON.stringify(value), updatedAt);
  }
}

function writeEventRows(db: Database, events: readonly unknown[]): void {
  db.query("DELETE FROM events").run();
  const insert = db.query(
    "INSERT INTO events (sequence, value_json, published_at) VALUES (?, ?, ?)",
  );
  for (const event of events) {
    if (!isRecord(event)) {
      continue;
    }
    const { sequence, publishedAt: publishedAtValue } = event;
    if (typeof sequence !== "number") {
      continue;
    }
    const publishedAt = typeof publishedAtValue === "string" ? publishedAtValue : null;
    insert.run(sequence, JSON.stringify(event), publishedAt);
  }
}

function writeTraceRows(db: Database, traces: readonly unknown[]): void {
  db.query("DELETE FROM traces").run();
  const insert = db.query(
    "INSERT INTO traces (trace_id, value_json, started_at) VALUES (?, ?, ?)",
  );
  for (const trace of traces) {
    if (!isRecord(trace)) {
      continue;
    }
    const { traceId, startedAt: startedAtValue } = trace;
    if (typeof traceId !== "string") {
      continue;
    }
    const startedAt = typeof startedAtValue === "string" ? startedAtValue : null;
    insert.run(traceId, JSON.stringify(trace), startedAt);
  }
}

function writeDurableTaskRows(
  db: Database,
  durableTasks: Record<string, unknown>,
): void {
  db.query("DELETE FROM task_graphs").run();
  db.query("DELETE FROM task_runs").run();
  db.query("DELETE FROM task_steps").run();
  const insertGraph = db.query(
    "INSERT INTO task_graphs (id, name, version, value_json, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insertRun = db.query(
    "INSERT INTO task_runs (id, graph_id, status, idempotency_key, value_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertStep = db.query(
    "INSERT INTO task_steps (id, run_id, definition_id, status, attempts, value_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const { graphs: graphsValue, runs: runsValue } = durableTasks;
  const graphs = Array.isArray(graphsValue) ? graphsValue : [];
  const runs = Array.isArray(runsValue) ? runsValue : [];
  for (const graph of graphs) {
    if (!isRecord(graph)) {
      continue;
    }
    const { id, name, version, updatedAt } = graph;
    if (typeof id !== "string") {
      continue;
    }
    insertGraph.run(
      id,
      typeof name === "string" ? name : null,
      typeof version === "string" ? version : null,
      JSON.stringify(graph),
      typeof updatedAt === "string" ? updatedAt : new Date().toISOString(),
    );
  }
  for (const run of runs) {
    if (!isRecord(run)) {
      continue;
    }
    const { id, graphId, status, idempotencyKey, updatedAt, steps } = run;
    if (typeof id !== "string" || typeof graphId !== "string") {
      continue;
    }
    insertRun.run(
      id,
      graphId,
      typeof status === "string" ? status : null,
      typeof idempotencyKey === "string" ? idempotencyKey : null,
      JSON.stringify(run),
      typeof updatedAt === "string" ? updatedAt : new Date().toISOString(),
    );
    const taskSteps = Array.isArray(steps) ? steps : [];
    for (const step of taskSteps) {
      if (!isRecord(step)) {
        continue;
      }
      const {
        id: stepId,
        definitionId,
        status: stepStatus,
        attempts,
        updatedAt: stepUpdatedAt,
      } = step;
      if (typeof stepId !== "string" || typeof definitionId !== "string") {
        continue;
      }
      insertStep.run(
        stepId,
        id,
        definitionId,
        typeof stepStatus === "string" ? stepStatus : null,
        typeof attempts === "number" ? attempts : null,
        JSON.stringify(step),
        typeof stepUpdatedAt === "string" ? stepUpdatedAt : new Date().toISOString(),
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    ...(record.durableTasks && typeof record.durableTasks === "object"
      ? { durableTasks: record.durableTasks as DurableTaskSnapshot }
      : {}),
  };
}
