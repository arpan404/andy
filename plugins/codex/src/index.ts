import {
  optionalString,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonValue } from "@andy/types";
import { Codex } from "@openai/codex-sdk";
import { Effect } from "effect";

startWorkerPlugin((request) =>
  Effect.fn("codex.handleRequest")(function* () {
    switch (request.toolName) {
      case "codex.run":
        return yield* runCodex(request.input);
      default:
        return yield* Effect.fail(
          new Error(`Unknown Codex tool '${request.toolName}'.`),
        );
    }
  })(),
);

function runCodex(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("codex.run")(function* () {
    const parsed = requireObject(input, "codex.run");
    const prompt = requireString(parsed, "prompt");
    const threadId = optionalString(parsed, "threadId");
    const cwd = optionalString(parsed, "cwd");
    return yield* Effect.tryPromise({
      try: async () => {
        const codex = new Codex();
        const thread = threadId
          ? codex.resumeThread(threadId, createThreadOptions(cwd))
          : codex.startThread(createThreadOptions(cwd));
        const result = await thread.run(prompt);
        const normalizedResult = normalizeJson(result);
        const nextThreadId = readThreadId(thread, result);
        return nextThreadId
          ? { result: normalizedResult, threadId: nextThreadId }
          : { result: normalizedResult };
      },
      catch: (cause) => cause,
    });
  })();
}

function createThreadOptions(cwd: string | undefined) {
  return cwd
    ? {
        workingDirectory: cwd,
        skipGitRepoCheck: true,
      }
    : undefined;
}

function readThreadId(thread: unknown, result: unknown): string | undefined {
  const threadRecord = isRecord(thread) ? thread : {};
  const resultRecord = isRecord(result) ? result : {};
  const { id, threadId } = threadRecord as {
    id?: unknown;
    threadId?: unknown;
  };
  const { threadId: resultThreadId } = resultRecord as {
    threadId?: unknown;
  };
  const direct = id ?? threadId ?? resultThreadId;
  return typeof direct === "string" ? direct : undefined;
}

function normalizeJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeJson(entry)]),
    );
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
