import {
  optionalBoolean,
  optionalString,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonValue } from "@andy/types";
import { Effect } from "effect";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, relative } from "node:path";

const environment = process.env as {
  ANDY_PLUGIN_FILESYSTEM_READ_ROOTS?: string;
  ANDY_PLUGIN_FILESYSTEM_WRITE_ROOTS?: string;
  ANDY_PLUGIN_FILESYSTEM_SENSITIVE_READ_ROOTS?: string;
};

const readRoots = parseRoots(environment.ANDY_PLUGIN_FILESYSTEM_READ_ROOTS);
const writeRoots = parseRoots(environment.ANDY_PLUGIN_FILESYSTEM_WRITE_ROOTS);
const sensitiveReadRoots = parseRoots(
  environment.ANDY_PLUGIN_FILESYSTEM_SENSITIVE_READ_ROOTS,
);

startWorkerPlugin((request) =>
  Effect.fn("filesystem.handleRequest")(function* () {
    switch (request.toolName) {
      case "filesystem.read":
        return yield* readPath(request.input);
      case "filesystem.read_sensitive":
        return yield* readSensitivePath(request.input);
      case "filesystem.list":
        return yield* listPath(request.input);
      case "filesystem.write":
        return yield* writePath(request.input);
      case "filesystem.delete":
        return yield* deletePath(request.input);
      default:
        return yield* Effect.fail(
          new Error(`Unknown filesystem tool '${request.toolName}'.`),
        );
    }
  })(),
);

function readPath(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("filesystem.read")(function* () {
    const parsed = requireObject(input, "filesystem.read");
    const path = resolveScopedPath(requireString(parsed, "path"), readRoots, "read");
    rejectSensitiveRead(path);
    const encoding = optionalString(parsed, "encoding") ?? "utf8";
    if (encoding !== "utf8" && encoding !== "base64") {
      return yield* Effect.fail(new Error("encoding must be 'utf8' or 'base64'."));
    }
    const data = yield* Effect.tryPromise(() => readFile(path));
    return {
      path,
      encoding,
      content: encoding === "base64" ? data.toString("base64") : data.toString("utf8"),
    };
  })();
}

function readSensitivePath(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("filesystem.readSensitive")(function* () {
    const parsed = requireObject(input, "filesystem.read_sensitive");
    const path = resolveScopedPath(
      requireString(parsed, "path"),
      sensitiveReadRoots,
      "sensitive read",
    );
    const encoding = optionalString(parsed, "encoding") ?? "utf8";
    if (encoding !== "utf8" && encoding !== "base64") {
      return yield* Effect.fail(new Error("encoding must be 'utf8' or 'base64'."));
    }
    const data = yield* Effect.tryPromise(() => readFile(path));
    return {
      path,
      encoding,
      sensitive: true,
      content: encoding === "base64" ? data.toString("base64") : data.toString("utf8"),
    };
  })();
}

function listPath(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("filesystem.list")(function* () {
    const parsed = requireObject(input, "filesystem.list");
    const path = resolveScopedPath(requireString(parsed, "path"), readRoots, "read");
    rejectSensitiveRead(path);
    const entries = yield* Effect.tryPromise(() =>
      readdir(path, { withFileTypes: true }),
    );
    return entries
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  })();
}

function writePath(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("filesystem.write")(function* () {
    const parsed = requireObject(input, "filesystem.write");
    const path = resolveScopedPath(requireString(parsed, "path"), writeRoots, "write");
    const content = requireString(parsed, "content");
    const encoding = optionalString(parsed, "encoding") ?? "utf8";
    if (encoding !== "utf8" && encoding !== "base64") {
      return yield* Effect.fail(new Error("encoding must be 'utf8' or 'base64'."));
    }
    const createParents = optionalBoolean(parsed, "createParents") ?? true;
    if (createParents) {
      yield* Effect.tryPromise(() => mkdir(dirname(path), { recursive: true }));
    }
    yield* Effect.tryPromise(() =>
      writeFile(path, Buffer.from(content, encoding), { flag: "w" }),
    );
    const info = yield* Effect.tryPromise(() => stat(path));
    return { path, bytes: info.size };
  })();
}

function deletePath(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("filesystem.delete")(function* () {
    const parsed = requireObject(input, "filesystem.delete");
    const path = resolveScopedPath(requireString(parsed, "path"), writeRoots, "delete");
    const recursive = optionalBoolean(parsed, "recursive") ?? false;
    yield* Effect.tryPromise(() => rm(path, { recursive, force: false }));
    return { path, deleted: true };
  })();
}

function parseRoots(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolve(item));
}

function resolveScopedPath(
  path: string,
  roots: readonly string[],
  action: string,
): string {
  if (roots.length === 0) {
    throw new Error(`No filesystem roots are declared for ${action}.`);
  }
  const resolved = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
  if (!roots.some((root) => isWithinRoot(resolved, root))) {
    throw new Error(`Path '${resolved}' is outside declared ${action} roots.`);
  }
  return resolved;
}

function rejectSensitiveRead(path: string): void {
  if (sensitiveReadRoots.some((root) => isWithinRoot(path, root))) {
    throw new Error(
      `Path '${path}' is under a sensitive root; use filesystem.read_sensitive with an explicit declaration.`,
    );
  }
}

function isWithinRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
