import {
  optionalNumber,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonValue } from "@andy/types";
import { Effect } from "effect";
import { spawn } from "node:child_process";

const computerControlEnv = process.env as {
  ANDY_ENABLE_COMPUTER_CONTROL?: string;
};
const enabled = computerControlEnv.ANDY_ENABLE_COMPUTER_CONTROL === "1";

startWorkerPlugin((request) =>
  Effect.fn("computer-control.handleRequest")(function* () {
    switch (request.toolName) {
      case "computer.click":
        return yield* gated(() => click(request.input));
      case "computer.type":
        return yield* gated(() => typeText(request.input));
      case "computer.key":
        return yield* gated(() => key(request.input));
      case "computer.window.list":
        return yield* windowList();
      default:
        return yield* Effect.fail(
          new Error(`Unknown computer-control tool '${request.toolName}'.`),
        );
    }
  })(),
);

function gated(run: () => Effect.Effect<JsonValue, unknown>) {
  if (!enabled) {
    return Effect.fail(
      new Error(
        "Computer control is disabled. Set ANDY_ENABLE_COMPUTER_CONTROL=1 after policy approval.",
      ),
    );
  }
  return run();
}

function click(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  const parsed = requireObject(input, "computer.click");
  const x = optionalNumber(parsed, "x");
  const y = optionalNumber(parsed, "y");
  if (x === undefined || y === undefined) {
    return Effect.fail(new Error("computer.click requires x and y."));
  }
  return osascript([
    `tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}`,
  ]).pipe(Effect.map(() => ({ clicked: true, x, y })));
}

function typeText(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  const parsed = requireObject(input, "computer.type");
  const text = requireString(parsed, "text");
  return osascript([
    'tell application "System Events"',
    `keystroke ${JSON.stringify(text)}`,
    "end tell",
  ]).pipe(Effect.map(() => ({ typed: true, characters: text.length })));
}

function key(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  const parsed = requireObject(input, "computer.key");
  const value = requireString(parsed, "key");
  return osascript([
    'tell application "System Events"',
    `key code ${JSON.stringify(value)}`,
    "end tell",
  ]).pipe(Effect.map(() => ({ pressed: true, key: value })));
}

function windowList(): Effect.Effect<JsonValue, unknown> {
  return osascript([
    'tell application "System Events"',
    "set appNames to name of every process whose background only is false",
    "return appNames as string",
    "end tell",
  ]).pipe(
    Effect.map((output) => ({
      applications: output
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    })),
  );
}

function osascript(lines: string[]): Effect.Effect<string, unknown> {
  return Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(
          "osascript",
          lines.flatMap((line) => ["-e", line]),
          {
            shell: false,
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          code === 0 ? resolve(stdout) : reject(new Error(stderr));
        });
      }),
    catch: (cause) => cause,
  });
}
