import realFs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  getJsonObjectProperty,
  isJsonObject,
  isJsonValue,
  parseJsonValue,
  type JsonObject,
  type JsonValue,
} from "@andy/types";
import { Effect, Schema } from "effect";

export type MemoryScope = "user" | "project" | "session" | "agent" | "plugin";

export type MemoryTrust = "trusted" | "untrusted" | "derived";

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  namespace: string;
  key: string;
  value: JsonValue;
  tags: string[];
  trust: MemoryTrust;
  source: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}

export interface SaveMemoryInput {
  scope: MemoryScope;
  namespace: string;
  key: string;
  value: JsonValue;
  tags?: string[];
  trust?: MemoryTrust;
  source: string;
  expiresAt?: Date;
}

export interface MemoryQuery {
  scope?: MemoryScope;
  namespace?: string;
  key?: string;
  tags?: string[];
  text?: string;
  limit?: number;
}

export interface MemoryStore {
  save(input: SaveMemoryInput): Effect.Effect<MemoryRecord, MemoryStoreError>;
  get(id: string): Effect.Effect<MemoryRecord | undefined, MemoryStoreError>;
  query(query: MemoryQuery): Effect.Effect<MemoryRecord[], MemoryStoreError>;
  forget(id: string): Effect.Effect<boolean, MemoryStoreError>;
}

export type StructuredMemoryType =
  | "preference"
  | "fact"
  | "relationship"
  | "project"
  | "procedure"
  | "episode";

export type StructuredMemorySensitivity = "low" | "medium" | "high";

export type StructuredMemoryVisibility =
  | "assistant"
  | "user-review-required"
  | "hidden-until-approved";

export interface StructuredMemorySource {
  channel: string;
  sessionId?: string;
  toolId?: string;
  documentId?: string;
}

export interface StructuredMemoryRecord {
  id: string;
  type: StructuredMemoryType;
  subject: string;
  content: string;
  source: StructuredMemorySource;
  confidence: number;
  sensitivity: StructuredMemorySensitivity;
  visibility: StructuredMemoryVisibility;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}

export interface SaveStructuredMemoryInput {
  id?: string;
  type: StructuredMemoryType;
  subject: string;
  content: string;
  source: StructuredMemorySource;
  confidence?: number;
  sensitivity?: StructuredMemorySensitivity;
  visibility?: StructuredMemoryVisibility;
  expiresAt?: Date;
}

export interface StructuredMemoryQuery {
  type?: StructuredMemoryType;
  subject?: string;
  sensitivity?: StructuredMemorySensitivity;
  visibility?: StructuredMemoryVisibility;
  text?: string;
  limit?: number;
}

export interface StructuredMemoryStore {
  save(
    input: SaveStructuredMemoryInput,
  ): Effect.Effect<StructuredMemoryRecord, MemoryStoreError>;
  get(id: string): Effect.Effect<StructuredMemoryRecord | undefined, MemoryStoreError>;
  query(
    query: StructuredMemoryQuery,
  ): Effect.Effect<StructuredMemoryRecord[], MemoryStoreError>;
  approve(
    id: string,
  ): Effect.Effect<StructuredMemoryRecord | undefined, MemoryStoreError>;
  reject(id: string): Effect.Effect<boolean, MemoryStoreError>;
  forget(id: string): Effect.Effect<boolean, MemoryStoreError>;
}

export class MemoryFileReadError extends Schema.TaggedError<MemoryFileReadError>()(
  "MemoryFileReadError",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.String),
  },
) {}

export class MemoryFileWriteError extends Schema.TaggedError<MemoryFileWriteError>()(
  "MemoryFileWriteError",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.String),
  },
) {}

export type MemoryStoreError = MemoryFileReadError | MemoryFileWriteError;

export class SqliteStructuredMemoryStore implements StructuredMemoryStore {
  readonly #path: string;

  constructor(options: { path: string }) {
    this.#path = path.resolve(options.path);
  }

  save(
    input: SaveStructuredMemoryInput,
  ): Effect.Effect<StructuredMemoryRecord, MemoryStoreError> {
    const self = this;
    return Effect.fn("SqliteStructuredMemoryStore.save")(function* () {
      const now = new Date();
      const existing = input.id ? yield* self.get(input.id) : undefined;
      const record: StructuredMemoryRecord = {
        id: existing?.id ?? input.id ?? crypto.randomUUID(),
        type: input.type,
        subject: input.subject,
        content: input.content,
        source: input.source,
        confidence: clampConfidence(input.confidence ?? 0.5),
        sensitivity: input.sensitivity ?? "medium",
        visibility:
          input.visibility ?? defaultVisibility(input.sensitivity ?? "medium"),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      };
      yield* self.#write(record);
      return record;
    })();
  }

  get(id: string): Effect.Effect<StructuredMemoryRecord | undefined, MemoryStoreError> {
    return Effect.fn("SqliteStructuredMemoryStore.get")(() =>
      this.#readAll().pipe(
        Effect.map((records) => records.find((record) => record.id === id)),
      ),
    )();
  }

  query(
    query: StructuredMemoryQuery,
  ): Effect.Effect<StructuredMemoryRecord[], MemoryStoreError> {
    return Effect.fn("SqliteStructuredMemoryStore.query")(() =>
      this.#readAll().pipe(
        Effect.map((records) => {
          const text = query.text?.toLowerCase();
          const limit = query.limit ?? 50;
          return records
            .filter((record) => !isStructuredMemoryExpired(record))
            .filter((record) => !query.type || record.type === query.type)
            .filter((record) => !query.subject || record.subject === query.subject)
            .filter(
              (record) =>
                !query.sensitivity || record.sensitivity === query.sensitivity,
            )
            .filter(
              (record) => !query.visibility || record.visibility === query.visibility,
            )
            .filter((record) => {
              if (!text) return true;
              return `${record.type} ${record.subject} ${record.content} ${record.source.channel}`
                .toLowerCase()
                .includes(text);
            })
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
            .slice(0, limit);
        }),
      ),
    )();
  }

  approve(
    id: string,
  ): Effect.Effect<StructuredMemoryRecord | undefined, MemoryStoreError> {
    const self = this;
    return Effect.fn("SqliteStructuredMemoryStore.approve")(function* () {
      const record = yield* self.get(id);
      if (!record) {
        return undefined;
      }
      const updated: StructuredMemoryRecord = {
        ...record,
        visibility: "assistant",
        updatedAt: new Date(),
      };
      yield* self.#write(updated);
      return updated;
    })();
  }

  reject(id: string): Effect.Effect<boolean, MemoryStoreError> {
    return this.forget(id);
  }

  forget(id: string): Effect.Effect<boolean, MemoryStoreError> {
    const self = this;
    return Effect.fn("SqliteStructuredMemoryStore.forget")(function* () {
      return yield* Effect.try({
        try: () => {
          const database = self.#open();
          try {
            const result = database
              .query("delete from structured_memories where id = $id")
              .run({ $id: id });
            return result.changes > 0;
          } finally {
            database.close();
          }
        },
        catch: (cause) =>
          new MemoryFileWriteError({
            path: self.#path,
            message: `Unable to delete structured memory '${id}'.`,
            cause: stringifyCause(cause),
          }),
      });
    })();
  }

  #write(record: StructuredMemoryRecord): Effect.Effect<void, MemoryFileWriteError> {
    return Effect.try({
      try: () => {
        const database = this.#open();
        try {
          database
            .query(
              `insert into structured_memories
                (id, type, subject, content, source_json, confidence, sensitivity, visibility, created_at, updated_at, expires_at, record_json)
               values
                ($id, $type, $subject, $content, $source_json, $confidence, $sensitivity, $visibility, $created_at, $updated_at, $expires_at, $record_json)
               on conflict(id) do update set
                type = excluded.type,
                subject = excluded.subject,
                content = excluded.content,
                source_json = excluded.source_json,
                confidence = excluded.confidence,
                sensitivity = excluded.sensitivity,
                visibility = excluded.visibility,
                updated_at = excluded.updated_at,
                expires_at = excluded.expires_at,
                record_json = excluded.record_json`,
            )
            .run({
              $id: record.id,
              $type: record.type,
              $subject: record.subject,
              $content: record.content,
              $source_json: JSON.stringify(record.source),
              $confidence: record.confidence,
              $sensitivity: record.sensitivity,
              $visibility: record.visibility,
              $created_at: record.createdAt.toISOString(),
              $updated_at: record.updatedAt.toISOString(),
              $expires_at: record.expiresAt?.toISOString() ?? null,
              $record_json: JSON.stringify(record),
            });
        } finally {
          database.close();
        }
      },
      catch: (cause) =>
        new MemoryFileWriteError({
          path: this.#path,
          message: `Unable to write structured memory database '${this.#path}'.`,
          cause: stringifyCause(cause),
        }),
    });
  }

  #readAll(): Effect.Effect<StructuredMemoryRecord[], MemoryFileReadError> {
    return Effect.try({
      try: () => {
        const database = this.#open();
        try {
          return database
            .query("select record_json from structured_memories")
            .all()
            .flatMap(parseStructuredMemoryRow);
        } finally {
          database.close();
        }
      },
      catch: (cause) =>
        new MemoryFileReadError({
          path: this.#path,
          message: `Unable to read structured memory database '${this.#path}'.`,
          cause: stringifyCause(cause),
        }),
    });
  }

  #open(): Database {
    mkdirSync(path.dirname(this.#path), { recursive: true });
    const database = new Database(this.#path);
    database.exec(`
      create table if not exists structured_memories (
        id text primary key,
        type text not null,
        subject text not null,
        content text not null,
        source_json text not null,
        confidence real not null,
        sensitivity text not null,
        visibility text not null,
        created_at text not null,
        updated_at text not null,
        expires_at text,
        record_json text not null
      );
      create index if not exists structured_memories_visibility_idx on structured_memories(visibility);
      create index if not exists structured_memories_subject_idx on structured_memories(subject);
      create index if not exists structured_memories_type_idx on structured_memories(type);
    `);
    return database;
  }
}

export class InMemoryStore implements MemoryStore {
  readonly #records = new Map<string, MemoryRecord>();

  save(input: SaveMemoryInput): Effect.Effect<MemoryRecord, never> {
    return Effect.fn("InMemoryStore.save")(() =>
      Effect.sync(() => {
        const now = new Date();
        const existing = this.#findByIdentity(input.scope, input.namespace, input.key);
        const record: MemoryRecord = {
          id: existing?.id ?? crypto.randomUUID(),
          scope: input.scope,
          namespace: input.namespace,
          key: input.key,
          value: input.value,
          tags: [...(input.tags ?? [])].sort(),
          trust: input.trust ?? "derived",
          source: input.source,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        if (input.expiresAt) {
          record.expiresAt = input.expiresAt;
        }

        this.#records.set(record.id, record);
        return record;
      }),
    )();
  }

  get(id: string): Effect.Effect<MemoryRecord | undefined, never> {
    return Effect.fn("InMemoryStore.get")(() =>
      Effect.sync(() => {
        const record = this.#records.get(id);
        if (!record || isExpired(record)) {
          return undefined;
        }

        return record;
      }),
    )();
  }

  query(query: MemoryQuery): Effect.Effect<MemoryRecord[], never> {
    return Effect.fn("InMemoryStore.query")(() =>
      Effect.sync(() => {
        const limit = query.limit ?? 20;
        const tags = new Set(query.tags ?? []);
        const text = query.text?.toLocaleLowerCase();

        return [...this.#records.values()]
          .filter((record) => !isExpired(record))
          .filter((record) => !query.scope || record.scope === query.scope)
          .filter((record) => !query.namespace || record.namespace === query.namespace)
          .filter((record) => !query.key || record.key === query.key)
          .filter((record) =>
            tags.size === 0 ? true : record.tags.some((tag) => tags.has(tag)),
          )
          .filter((record) => {
            if (!text) {
              return true;
            }

            const haystack = `${record.namespace} ${record.key} ${record.tags.join(
              " ",
            )} ${JSON.stringify(record.value)}`.toLocaleLowerCase();
            return haystack.includes(text);
          })
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .slice(0, limit);
      }),
    )();
  }

  forget(id: string): Effect.Effect<boolean, never> {
    return Effect.fn("InMemoryStore.forget")(() =>
      Effect.sync(() => this.#records.delete(id)),
    )();
  }

  #findByIdentity(
    scope: MemoryScope,
    namespace: string,
    key: string,
  ): MemoryRecord | undefined {
    return [...this.#records.values()].find(
      (record) =>
        record.scope === scope && record.namespace === namespace && record.key === key,
    );
  }
}

export interface MarkdownMemoryStoreOptions {
  filePath: string;
}

export class MarkdownMemoryStore implements MemoryStore {
  readonly #filePath: string;
  readonly #memory = new InMemoryStore();
  #loaded = false;

  constructor(options: MarkdownMemoryStoreOptions) {
    this.#filePath = path.resolve(options.filePath);
  }

  save(input: SaveMemoryInput): Effect.Effect<MemoryRecord, MemoryStoreError> {
    const self = this;
    return Effect.fn("MarkdownMemoryStore.save")(function* () {
      yield* self.#load();
      const record = yield* self.#memory.save(input);
      yield* self.#flush();
      return record;
    })();
  }

  get(id: string): Effect.Effect<MemoryRecord | undefined, MemoryStoreError> {
    const self = this;
    return Effect.fn("MarkdownMemoryStore.get")(function* () {
      yield* self.#load();
      return yield* self.#memory.get(id);
    })();
  }

  query(query: MemoryQuery): Effect.Effect<MemoryRecord[], MemoryStoreError> {
    const self = this;
    return Effect.fn("MarkdownMemoryStore.query")(function* () {
      yield* self.#load();
      return yield* self.#memory.query(query);
    })();
  }

  forget(id: string): Effect.Effect<boolean, MemoryStoreError> {
    const self = this;
    return Effect.fn("MarkdownMemoryStore.forget")(function* () {
      yield* self.#load();
      const deleted = yield* self.#memory.forget(id);
      if (deleted) {
        yield* self.#flush();
      }

      return deleted;
    })();
  }

  #load(): Effect.Effect<void, MemoryFileReadError> {
    const self = this;
    return Effect.fn("MarkdownMemoryStore.load")(function* () {
      if (self.#loaded) {
        return;
      }

      self.#loaded = true;
      let contents = "";
      const readResult = yield* Effect.either(
        Effect.tryPromise({
          try: () => realFs.readFile(self.#filePath, "utf8"),
          catch: (cause) =>
            new MemoryFileReadError({
              path: self.#filePath,
              message: `Unable to read memory file '${self.#filePath}'.`,
              cause: stringifyCause(cause),
            }),
        }),
      );
      if (readResult._tag === "Left") {
        return;
      }
      contents = readResult.right;

      for (const block of parseMemoryBlocks(contents)) {
        yield* self.#memory.save(block);
      }
    })();
  }

  #flush(): Effect.Effect<void, MemoryFileWriteError> {
    const self = this;
    return Effect.fn("MarkdownMemoryStore.flush")(function* () {
      const records = yield* self.#memory.query({ limit: Number.MAX_SAFE_INTEGER });
      const body = [
        "# Andy Memory",
        "",
        "This file is managed by Andy. It is intentionally Markdown so the user and agent can inspect, edit, and review long-term memory.",
        "",
        ...records.flatMap((record) => formatMemoryRecord(record)),
      ].join("\n");

      yield* Effect.tryPromise({
        try: async () => {
          await realFs.mkdir(path.dirname(self.#filePath), { recursive: true });
          await realFs.writeFile(self.#filePath, `${body}\n`, "utf8");
        },
        catch: (cause) =>
          new MemoryFileWriteError({
            path: self.#filePath,
            message: `Unable to write memory file '${self.#filePath}'.`,
            cause: stringifyCause(cause),
          }),
      });
    })();
  }
}

function isExpired(record: MemoryRecord): boolean {
  return record.expiresAt ? record.expiresAt.getTime() <= Date.now() : false;
}

function isStructuredMemoryExpired(record: StructuredMemoryRecord): boolean {
  return record.expiresAt ? record.expiresAt.getTime() <= Date.now() : false;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, value));
}

function defaultVisibility(
  sensitivity: StructuredMemorySensitivity,
): StructuredMemoryVisibility {
  return sensitivity === "high" ? "user-review-required" : "assistant";
}

function parseStructuredMemoryRow(row: unknown): StructuredMemoryRecord[] {
  if (typeof row !== "object" || row === null) {
    return [];
  }
  const recordJson = (row as { record_json?: unknown }).record_json;
  if (typeof recordJson !== "string") {
    return [];
  }
  const parsed = JSON.parse(recordJson) as StructuredMemoryRecord;
  return [
    {
      ...parsed,
      createdAt: new Date(parsed.createdAt),
      updatedAt: new Date(parsed.updatedAt),
      ...(parsed.expiresAt ? { expiresAt: new Date(parsed.expiresAt) } : {}),
    },
  ];
}

function stringifyCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatMemoryRecord(record: MemoryRecord): string[] {
  return [
    `## ${record.namespace}/${record.key}`,
    "",
    "```andy-memory",
    JSON.stringify(
      {
        scope: record.scope,
        namespace: record.namespace,
        key: record.key,
        value: record.value,
        tags: record.tags,
        trust: record.trust,
        source: record.source,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
        expiresAt: record.expiresAt?.toISOString(),
      },
      null,
      2,
    ),
    "```",
    "",
  ];
}

function parseMemoryBlocks(contents: string): SaveMemoryInput[] {
  const blocks = contents.matchAll(/```andy-memory\n([\s\S]*?)\n```/g);
  const memories: SaveMemoryInput[] = [];

  for (const block of blocks) {
    try {
      const jsonText = block[1];
      if (!jsonText) {
        continue;
      }

      const parsed = parseJsonValue(jsonText);
      const input = memoryInputFromJson(parsed);
      if (input) {
        memories.push(input);
      }
    } catch {}
  }

  return memories;
}

function memoryInputFromJson(
  value: JsonValue | undefined,
): SaveMemoryInput | undefined {
  if (!isMemoryJsonObject(value)) {
    return undefined;
  }

  const scope = getJsonObjectProperty(value, "scope");
  const namespace = getJsonObjectProperty(value, "namespace");
  const key = getJsonObjectProperty(value, "key");
  const memoryValue = getJsonObjectProperty(value, "value");
  const tags = getJsonObjectProperty(value, "tags");
  const trust = getJsonObjectProperty(value, "trust");
  const source = getJsonObjectProperty(value, "source");
  const expiresAt = getJsonObjectProperty(value, "expiresAt");

  if (
    !isMemoryScope(scope) ||
    typeof namespace !== "string" ||
    typeof key !== "string" ||
    !isJsonValue(memoryValue)
  ) {
    return undefined;
  }

  if (tags !== undefined && !isStringArray(tags)) {
    return undefined;
  }

  if (trust !== undefined && !isMemoryTrust(trust)) {
    return undefined;
  }

  if (source !== undefined && typeof source !== "string") {
    return undefined;
  }

  if (expiresAt !== undefined && typeof expiresAt !== "string") {
    return undefined;
  }

  const input: SaveMemoryInput = {
    scope,
    namespace,
    key,
    value: memoryValue,
    source: source ?? "markdown",
  };

  if (tags) {
    input.tags = [...tags];
  }

  if (trust) {
    input.trust = trust;
  }

  if (expiresAt) {
    input.expiresAt = new Date(expiresAt);
  }

  return input;
}

function isMemoryJsonObject(value: JsonValue | undefined): value is JsonObject {
  return isJsonObject(value);
}

function isStringArray(value: JsonValue): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isMemoryScope(value: JsonValue | undefined): value is MemoryScope {
  return (
    value === "user" ||
    value === "project" ||
    value === "session" ||
    value === "agent" ||
    value === "plugin"
  );
}

function isMemoryTrust(value: JsonValue): value is MemoryTrust {
  return value === "trusted" || value === "untrusted" || value === "derived";
}
