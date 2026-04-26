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
import { isAbsolute, resolve, relative } from "node:path";

const environment = process.env as {
  ANDY_PLUGIN_FILESYSTEM_READ_ROOTS?: string;
  ANDY_PLUGIN_FILESYSTEM_WRITE_ROOTS?: string;
  PATH?: string;
  HOME?: string;
  TMPDIR?: string;
};

const allowedRoots = [
  ...parseRoots(environment.ANDY_PLUGIN_FILESYSTEM_READ_ROOTS),
  ...parseRoots(environment.ANDY_PLUGIN_FILESYSTEM_WRITE_ROOTS),
];

startWorkerPlugin((request) =>
  Effect.fn("shell.handleRequest")(function* () {
    if (request.toolName !== "shell.execute") {
      return yield* Effect.fail(new Error(`Unknown shell tool '${request.toolName}'.`));
    }
    return yield* executeShell(request.input);
  })(),
);

function executeShell(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("shell.execute")(function* () {
    const parsed = requireObject(input, "shell.execute");
    const command = requireString(parsed, "command");
    const args = optionalStringArray(parsed, "args") ?? [];
    const cwd = resolveScopedCwd(optionalString(parsed, "cwd") ?? process.cwd());
    const timeoutMs = Math.min(optionalNumber(parsed, "timeoutMs") ?? 30_000, 120_000);
    const maxOutputBytes = Math.min(
      optionalNumber(parsed, "maxOutputBytes") ?? 128 * 1024,
      1024 * 1024,
    );

    return yield* Effect.tryPromise({
      try: () =>
        new Promise<JsonValue>((resolvePromise, reject) => {
          const child = spawn(command, args, {
            cwd,
            shell: false,
            env: {
              PATH: environment.PATH ?? "",
              HOME: environment.HOME ?? cwd,
              TMPDIR: environment.TMPDIR ?? cwd,
            },
          });
          const timer = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error(`Command timed out after ${timeoutMs}ms.`));
          }, timeoutMs);
          let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
          let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
          child.stdout.on("data", (chunk: Buffer) => {
            stdout = appendLimited(stdout, chunk, maxOutputBytes);
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderr = appendLimited(stderr, chunk, maxOutputBytes);
          });
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("exit", (code, signal) => {
            clearTimeout(timer);
            resolvePromise({
              command,
              args,
              cwd,
              exitCode: code ?? null,
              signal: signal ?? null,
              stdout: stdout.toString("utf8"),
              stderr: stderr.toString("utf8"),
            });
          });
        }),
      catch: (cause) => cause,
    });
  })();
}

function appendLimited(existing: Buffer, chunk: Buffer, maxBytes: number): Buffer {
  return Buffer.concat([existing, chunk]).subarray(0, maxBytes);
}

function parseRoots(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolve(item));
}

function resolveScopedCwd(cwd: string): string {
  if (allowedRoots.length === 0) {
    throw new Error("shell.execute requires declared filesystem roots for cwd.");
  }
  const resolved = isAbsolute(cwd) ? resolve(cwd) : resolve(process.cwd(), cwd);
  if (!allowedRoots.some((root) => isWithinRoot(resolved, root))) {
    throw new Error(`cwd '${resolved}' is outside declared shell roots.`);
  }
  return resolved;
}

function isWithinRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
