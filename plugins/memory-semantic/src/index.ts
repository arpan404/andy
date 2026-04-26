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

type SemanticRecord = {
  id: string;
  scope: string;
  namespace: string;
  key: string;
  value: JsonValue;
  text: string;
  tags: string[];
  vector: number[];
  source: string;
  createdAt: string;
  updatedAt: string;
};

const environment = process.env as {
  ANDY_PLUGIN_ID?: string;
  ANDY_PLUGIN_STORAGE_ROOT?: string;
};

const storageRoot = environment.ANDY_PLUGIN_STORAGE_ROOT ?? process.cwd();
const memoryPath = join(storageRoot, "semantic-memory.json");

startWorkerPlugin((request) =>
  Effect.fn("memory-semantic.handleRequest")(function* () {
    switch (request.toolName) {
      case "memory.embed":
        return embedText(request.input);
      case "memory.save":
        return yield* saveMemory(request.input);
      case "memory.fetch":
        return yield* fetchMemory(request.input);
      case "memory.semantic_query":
        return yield* semanticQuery(request.input);
      case "memory.forget":
        return yield* forgetMemory(request.input);
      default:
        return yield* Effect.fail(
          new Error(`Unknown memory-semantic tool '${request.toolName}'.`),
        );
    }
  })(),
);

function embedText(input: JsonValue): JsonValue {
  const parsed = requireObject(input, "memory.embed");
  const text = requireString(parsed, "text");
  return { text, dimensions: 32, vector: embed(text) };
}

function saveMemory(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("memory-semantic.save")(function* () {
    const parsed = requireObject(input, "memory.save");
    const { value } = parsed as { value?: JsonValue };
    const text = optionalString(parsed, "text") ?? stringifyValue(value ?? "");
    const now = new Date().toISOString();
    const record: SemanticRecord = {
      id: optionalString(parsed, "id") ?? randomUUID(),
      scope: optionalString(parsed, "scope") ?? "user",
      namespace: optionalString(parsed, "namespace") ?? "knowledge",
      key: requireString(parsed, "key"),
      value: value ?? text,
      text,
      tags: optionalStringArray(parsed, "tags") ?? [],
      vector: embed(text),
      source: optionalString(parsed, "source") ?? environment.ANDY_PLUGIN_ID ?? "andy",
      createdAt: now,
      updatedAt: now,
    };
    const records = yield* loadRecords();
    records.push(record);
    yield* saveRecords(records);
    return record;
  })();
}

function fetchMemory(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("memory-semantic.fetch")(function* () {
    const parsed = requireObject(input, "memory.fetch");
    const records = yield* loadRecords();
    const id = optionalString(parsed, "id");
    if (id) {
      return records.find((record) => record.id === id) ?? null;
    }
    const key = optionalString(parsed, "key");
    return records.find((record) => !key || record.key === key) ?? null;
  })();
}

function semanticQuery(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("memory-semantic.query")(function* () {
    const parsed = requireObject(input, "memory.semantic_query");
    const query = requireString(parsed, "text");
    const namespace = optionalString(parsed, "namespace");
    const tags = optionalStringArray(parsed, "tags") ?? [];
    const queryVector = embed(query);
    const records = yield* loadRecords();
    return records
      .filter((record) => {
        if (namespace && record.namespace !== namespace) return false;
        if (tags.length > 0 && !tags.every((tag) => record.tags.includes(tag))) {
          return false;
        }
        return true;
      })
      .map((record) => ({
        ...record,
        score: cosineSimilarity(queryVector, record.vector),
      }))
      .sort((a, b) => b.score - a.score);
  })();
}

function forgetMemory(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("memory-semantic.forget")(function* () {
    const parsed = requireObject(input, "memory.forget");
    const id = requireString(parsed, "id");
    const records = yield* loadRecords();
    const next = records.filter((record) => record.id !== id);
    yield* saveRecords(next);
    return { forgotten: next.length !== records.length };
  })();
}

function loadRecords(): Effect.Effect<SemanticRecord[], unknown> {
  return Effect.tryPromise(async () => {
    try {
      const raw = await readFile(memoryPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isSemanticRecord) : [];
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  });
}

function saveRecords(records: readonly SemanticRecord[]): Effect.Effect<void, unknown> {
  return Effect.tryPromise(async () => {
    await mkdir(storageRoot, { recursive: true });
    await writeFile(memoryPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  });
}

function embed(text: string): number[] {
  const vector = Array.from({ length: 32 }, () => 0);
  for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    const index = hashToken(token) % vector.length;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => Number((value / length).toFixed(6)));
}

function hashToken(token: string): number {
  let hash = 0;
  for (const character of token) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const score = a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
  return Number(score.toFixed(6));
}

function stringifyValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isSemanticRecord(value: unknown): value is SemanticRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<SemanticRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.key === "string" &&
    Array.isArray(record.vector)
  );
}
