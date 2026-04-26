import {
  optionalNumber,
  optionalString,
  optionalStringArray,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonValue } from "@andy/types";
import { Effect } from "effect";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const environment = process.env as {
  ANDY_PLUGIN_PROJECT_ROOTS?: string;
};

const projectRoots = parseRoots(environment.ANDY_PLUGIN_PROJECT_ROOTS || ".");

startWorkerPlugin((request) =>
  Effect.fn("project.handleRequest")(function* () {
    switch (request.toolName) {
      case "project.read":
        return yield* readProjectFile(request.input);
      case "project.write":
        return yield* writeProjectFile(request.input);
      case "project.search":
        return yield* searchProject(request.input);
      case "project.diff":
        return yield* runProjectCommand(request.input, ["git", "diff", "--"]);
      case "project.run_check":
        return yield* runCheck(request.input);
      default:
        return yield* Effect.fail(
          new Error(`Unknown project tool '${request.toolName}'.`),
        );
    }
  })(),
);

function readProjectFile(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("project.read")(function* () {
    const parsed = requireObject(input, "project.read");
    const path = resolveProjectPath(requireString(parsed, "path"));
    const content = yield* Effect.tryPromise(() => readFile(path, "utf8"));
    return { path, content };
  })();
}

function writeProjectFile(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("project.write")(function* () {
    const parsed = requireObject(input, "project.write");
    const path = resolveProjectPath(requireString(parsed, "path"));
    const content = requireString(parsed, "content");
    yield* Effect.tryPromise(() => mkdir(dirname(path), { recursive: true }));
    yield* Effect.tryPromise(() => writeFile(path, content, "utf8"));
    return { path, bytes: Buffer.byteLength(content, "utf8") };
  })();
}

function searchProject(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("project.search")(function* () {
    const parsed = requireObject(input, "project.search");
    const query = requireString(parsed, "query");
    const root = resolveProjectPath(optionalString(parsed, "root") ?? ".");
    const limit = optionalNumber(parsed, "limit") ?? 50;
    const matches: Array<{ path: string; line: number; text: string }> = [];
    yield* Effect.tryPromise(() =>
      walk(root, async (path) => {
        if (matches.length >= limit) return;
        const content = await readFile(path, "utf8").catch(() => "");
        content.split(/\r?\n/).forEach((line, index) => {
          if (matches.length < limit && line.includes(query)) {
            matches.push({ path, line: index + 1, text: line });
          }
        });
      }),
    );
    return { query, matches };
  })();
}

function runCheck(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("project.runCheck")(function* () {
    const parsed = requireObject(input, "project.run_check");
    const command = requireString(parsed, "command");
    const args = optionalStringArray(parsed, "args") ?? [];
    const cwd = resolveProjectPath(optionalString(parsed, "cwd") ?? ".");
    return yield* execute(
      command,
      args,
      cwd,
      optionalNumber(parsed, "timeoutMs") ?? 120_000,
    );
  })();
}

function runProjectCommand(
  input: JsonValue,
  command: readonly string[],
): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("project.command")(function* () {
    const parsed = requireObject(input, "project.command");
    const cwd = resolveProjectPath(optionalString(parsed, "cwd") ?? ".");
    return yield* execute(command[0] ?? "git", command.slice(1), cwd, 30_000);
  })();
}

async function walk(
  root: string,
  visit: (path: string) => Promise<void>,
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === "dist"
    ) {
      continue;
    }
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      await walk(path, visit);
    } else if (entry.isFile()) {
      await visit(path);
    }
  }
}

function execute(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Effect.Effect<JsonValue, unknown> {
  return Effect.async((resume) => {
    const child = spawn(command, [...args], { cwd, shell: false });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      resume(Effect.fail(error));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resume(
        Effect.succeed({
          command,
          args: [...args],
          cwd,
          exitCode,
          stdout: Buffer.concat(chunks).toString("utf8").slice(0, 64_000),
          stderr: Buffer.concat(errors).toString("utf8").slice(0, 64_000),
        }),
      );
    });
  });
}

function parseRoots(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolve(item));
}

function resolveProjectPath(path: string): string {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
  if (!projectRoots.some((root) => isWithinRoot(resolved, root))) {
    throw new Error(`Path '${resolved}' is outside declared project roots.`);
  }
  return resolved;
}

function isWithinRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
