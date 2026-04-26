import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  type MemoryQuery,
  type MemoryRecord,
  type MemoryScope,
  type MemoryTrust,
  MarkdownMemoryStore,
  type SaveMemoryInput,
} from "@andy/memory";
import {
  getJsonObjectProperty,
  isJsonObject,
  isJsonValue,
  type JsonObject,
  type JsonValue,
} from "@andy/types";
import { Effect } from "effect";

type WorkerPluginHostRequest = {
  type: "andy.tool.execute";
  requestId: string;
  pluginId: string;
  toolName: string;
  input: JsonValue;
};

type WorkerPluginHostResponse =
  | {
      type: "andy.tool.result";
      requestId: string;
      output: JsonValue;
    }
  | {
      type: "andy.tool.error";
      requestId: string;
      message: string;
      cause?: string;
    };

const environment = process.env as {
  ANDY_PLUGIN_ID?: string;
  ANDY_PLUGIN_STORAGE_ROOT?: string;
};

const storageRoot = environment.ANDY_PLUGIN_STORAGE_ROOT ?? process.cwd();
const store = new MarkdownMemoryStore({
  filePath: join(storageRoot, "memory.md"),
});

const stdin = createInterface({ input: process.stdin });

stdin.on("line", (line) => {
  const request = parseRequest(line);
  if (!request) {
    return;
  }

  Effect.runPromise(
    handleRequest(request).pipe(
      Effect.match({
        onFailure: (error) =>
          respond({
            type: "andy.tool.error",
            requestId: request.requestId,
            message: error instanceof Error ? error.message : String(error),
            cause: stringifyCause(error),
          }),
        onSuccess: (output) =>
          respond({
            type: "andy.tool.result",
            requestId: request.requestId,
            output,
          }),
      }),
    ),
  );
});

function handleRequest(
  request: WorkerPluginHostRequest,
): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("memory-markdown.handleRequest")(function* () {
    switch (request.toolName) {
      case "memory.save":
        return recordToJson(yield* store.save(parseSaveInput(request.input)));
      case "memory.save_fact":
        return recordToJson(yield* store.save(parseFactInput(request.input)));
      case "memory.fetch":
        return yield* fetchMemory(request.input);
      case "memory.query":
      case "memory.list":
        return recordsToJson(yield* store.query(parseQueryInput(request.input)));
      case "memory.forget":
        return yield* forgetMemory(request.input);
      default:
        return yield* Effect.fail(
          new Error(`Unknown memory-markdown tool '${request.toolName}'.`),
        );
    }
  })();
}

function fetchMemory(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("memory-markdown.fetchMemory")(function* () {
    if (!isJsonObject(input)) {
      return yield* Effect.fail(new Error("memory.fetch input must be an object."));
    }

    const id = getJsonObjectProperty(input, "id");
    if (typeof id === "string") {
      const record = yield* store.get(id);
      return record ? recordToJson(record) : null;
    }

    const query = parseQueryInput(input);
    const [record] = yield* store.query({ ...query, limit: 1 });
    return record ? recordToJson(record) : null;
  })();
}

function forgetMemory(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("memory-markdown.forgetMemory")(function* () {
    if (!isJsonObject(input)) {
      return yield* Effect.fail(new Error("memory.forget input must be an object."));
    }

    const id = getJsonObjectProperty(input, "id");
    if (typeof id !== "string" || id.length === 0) {
      return yield* Effect.fail(new Error("memory.forget requires a non-empty id."));
    }

    const forgotten = yield* store.forget(id);
    return { forgotten };
  })();
}

function parseSaveInput(input: JsonValue): SaveMemoryInput {
  if (!isJsonObject(input)) {
    throw new Error("memory.save input must be an object.");
  }

  const scope = parseScope(getJsonObjectProperty(input, "scope") ?? "user");
  const namespace = parseString(input, "namespace", "self");
  const key = parseString(input, "key");
  const value = getJsonObjectProperty(input, "value");
  const tags = parseOptionalStringArray(input, "tags");
  const trust = parseTrust(getJsonObjectProperty(input, "trust") ?? "derived");
  const source = parseString(input, "source", environment.ANDY_PLUGIN_ID ?? "andy");
  const expiresAt = parseOptionalDate(input, "expiresAt");

  if (!isJsonValue(value)) {
    throw new Error("memory.save requires a JSON value.");
  }

  return {
    scope,
    namespace,
    key,
    value,
    source,
    trust,
    ...(tags ? { tags } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function parseFactInput(input: JsonValue): SaveMemoryInput {
  const parsed = parseSaveInput(input);
  return {
    ...parsed,
    namespace: parsed.namespace === "self" ? "facts" : parsed.namespace,
    tags: [...new Set([...(parsed.tags ?? []), "fact"])].sort(),
    trust: parsed.trust ?? "derived",
  };
}

function parseQueryInput(input: JsonValue): MemoryQuery {
  if (!isJsonObject(input)) {
    throw new Error("memory query input must be an object.");
  }

  const query: MemoryQuery = {};
  const scope = getJsonObjectProperty(input, "scope");
  const namespace = getJsonObjectProperty(input, "namespace");
  const key = getJsonObjectProperty(input, "key");
  const text = getJsonObjectProperty(input, "text");
  const tags = parseOptionalStringArray(input, "tags");
  const limit = getJsonObjectProperty(input, "limit");

  if (scope !== undefined) {
    query.scope = parseScope(scope);
  }
  if (typeof namespace === "string") {
    query.namespace = namespace;
  }
  if (typeof key === "string") {
    query.key = key;
  }
  if (typeof text === "string") {
    query.text = text;
  }
  if (tags) {
    query.tags = tags;
  }
  if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) {
    query.limit = Math.min(limit, 100);
  }

  return query;
}

function parseScope(value: JsonValue): MemoryScope {
  if (
    value === "user" ||
    value === "project" ||
    value === "session" ||
    value === "agent" ||
    value === "plugin"
  ) {
    return value;
  }

  throw new Error(`Invalid memory scope '${String(value)}'.`);
}

function parseTrust(value: JsonValue): MemoryTrust {
  if (value === "trusted" || value === "untrusted" || value === "derived") {
    return value;
  }

  throw new Error(`Invalid memory trust '${String(value)}'.`);
}

function parseString(input: JsonObject, key: string, fallback?: string): string {
  const value = getJsonObjectProperty(input, key);
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Expected non-empty string '${key}'.`);
}

function parseOptionalStringArray(
  input: JsonObject,
  key: string,
): string[] | undefined {
  const value = getJsonObjectProperty(input, key);
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Expected string array '${key}'.`);
  }
  return [...value].sort();
}

function parseOptionalDate(input: JsonObject, key: string): Date | undefined {
  const value = getJsonObjectProperty(input, key);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected ISO date string '${key}'.`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO date string '${key}'.`);
  }
  return date;
}

function recordToJson(record: MemoryRecord): JsonObject {
  return {
    id: record.id,
    scope: record.scope,
    namespace: record.namespace,
    key: record.key,
    value: record.value,
    tags: record.tags,
    trust: record.trust,
    source: record.source,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    ...(record.expiresAt ? { expiresAt: record.expiresAt.toISOString() } : {}),
  };
}

function recordsToJson(records: readonly MemoryRecord[]): JsonValue {
  return records.map(recordToJson);
}

function parseRequest(line: string): WorkerPluginHostRequest | undefined {
  try {
    const parsed = JSON.parse(line) as WorkerPluginHostRequest;
    return parsed.type === "andy.tool.execute" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function respond(response: WorkerPluginHostResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function stringifyCause(cause: unknown): string {
  return cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
}
