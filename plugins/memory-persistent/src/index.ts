import {
  optionalString,
  optionalStringArray,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonValue } from "@andy/types";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type MemoryRecord = {
  id: string;
  scope: string;
  namespace: string;
  key: string;
  value: JsonValue;
  tags: string[];
  trust: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};

const environment = process.env as {
  ANDY_PLUGIN_ID?: string;
  ANDY_PLUGIN_STORAGE_ROOT?: string;
};

const storageRoot = environment.ANDY_PLUGIN_STORAGE_ROOT ?? process.cwd();
const memoryPath = join(storageRoot, "persistent-memory.json");

startWorkerPlugin((request) =>
  Effect.fn("memory-persistent.handleRequest")(function* () {
    switch (request.toolName) {
      case "memory.save":
        return yield* saveMemory(request.input, false);
      case "memory.save_fact":
        return yield* saveMemory(request.input, true);
      case "memory.fetch":
        return yield* fetchMemory(request.input);
      case "memory.query":
      case "memory.list":
        return yield* queryMemory(request.input);
      case "memory.forget":
        return yield* forgetMemory(request.input);
      default:
        return yield* Effect.fail(
          new Error(`Unknown memory-persistent tool '${request.toolName}'.`),
        );
    }
  })(),
);

function saveMemory(
  input: JsonValue,
  fact: boolean,
): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("memory-persistent.save")(function* () {
    const parsed = requireObject(input, "memory.save");
    const { value } = parsed as { value?: JsonValue };
    const now = new Date().toISOString();
    const records = yield* loadRecords();
    const record: MemoryRecord = {
      id: optionalString(parsed, "id") ?? randomUUID(),
      scope: optionalString(parsed, "scope") ?? "user",
      namespace:
        optionalString(parsed, "namespace") ?? (fact ? "facts" : "preferences"),
      key: requireString(parsed, "key"),
      value: value ?? null,
      tags: [
        ...new Set([
          ...(optionalStringArray(parsed, "tags") ?? []),
          ...(fact ? ["fact"] : []),
        ]),
      ].sort(),
      trust: optionalString(parsed, "trust") ?? "derived",
      source: optionalString(parsed, "source") ?? environment.ANDY_PLUGIN_ID ?? "andy",
      createdAt: now,
      updatedAt: now,
    };
    records.push(record);
    yield* saveRecords(records);
    return record;
  })();
}

function fetchMemory(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("memory-persistent.fetch")(function* () {
    const parsed = requireObject(input, "memory.fetch");
    const records = yield* loadRecords();
    const id = optionalString(parsed, "id");
    if (id) {
      return records.find((record) => record.id === id) ?? null;
    }
    const key = optionalString(parsed, "key");
    const namespace = optionalString(parsed, "namespace");
    return (
      records.find(
        (record) =>
          (!key || record.key === key) &&
          (!namespace || record.namespace === namespace),
      ) ?? null
    );
  })();
}

function queryMemory(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("memory-persistent.query")(function* () {
    const parsed = requireObject(input, "memory.query");
    const records = yield* loadRecords();
    const text = optionalString(parsed, "text")?.toLowerCase();
    const tags = optionalStringArray(parsed, "tags") ?? [];
    const namespace = optionalString(parsed, "namespace");
    const scope = optionalString(parsed, "scope");
    const key = optionalString(parsed, "key");
    return records.filter((record) => {
      if (scope && record.scope !== scope) return false;
      if (namespace && record.namespace !== namespace) return false;
      if (key && record.key !== key) return false;
      if (tags.length > 0 && !tags.every((tag) => record.tags.includes(tag))) {
        return false;
      }
      if (!text) return true;
      return JSON.stringify(record).toLowerCase().includes(text);
    });
  })();
}

function forgetMemory(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("memory-persistent.forget")(function* () {
    const parsed = requireObject(input, "memory.forget");
    const id = requireString(parsed, "id");
    const records = yield* loadRecords();
    const next = records.filter((record) => record.id !== id);
    yield* saveRecords(next);
    return { forgotten: next.length !== records.length };
  })();
}

function loadRecords(): Effect.Effect<MemoryRecord[], unknown> {
  return Effect.tryPromise(async () => {
    try {
      const raw = await readFile(memoryPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isMemoryRecord) : [];
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  });
}

function saveRecords(records: readonly MemoryRecord[]): Effect.Effect<void, unknown> {
  return Effect.tryPromise(async () => {
    await mkdir(storageRoot, { recursive: true });
    await writeFile(memoryPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  });
}

function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<MemoryRecord>;
  return typeof record.id === "string" && typeof record.key === "string";
}
