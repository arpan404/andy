import {
  optionalNumber,
  optionalString,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonValue } from "@andy/types";
import { Effect } from "effect";
import { spawn } from "node:child_process";

startWorkerPlugin((request) =>
  Effect.fn("voice-output.handleRequest")(function* () {
    if (request.toolName !== "voice.speak") {
      return yield* Effect.fail(
        new Error(`Unknown voice-output tool '${request.toolName}'.`),
      );
    }
    return yield* speak(request.input);
  })(),
);

function speak(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("voice.speak")(function* () {
    const parsed = requireObject(input, "voice.speak");
    const text = requireString(parsed, "text");
    const voice = optionalString(parsed, "voice");
    const rate = optionalNumber(parsed, "rate");
    const args = [
      ...(voice ? ["-v", voice] : []),
      ...(rate ? ["-r", String(rate)] : []),
      text,
    ];
    const result = yield* runCommand("say", args, 60_000);
    return { command: result.command, exitCode: result.exitCode, spoken: true };
  })();
}

function runCommand(command: string, args: string[], timeoutMs: number) {
  return Effect.tryPromise({
    try: () =>
      new Promise<{ command: string; exitCode: number }>((resolve, reject) => {
        const child = spawn(command, args, { shell: false });
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`${command} timed out.`));
        }, timeoutMs);
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          if (code === 0) {
            resolve({ command, exitCode: code });
            return;
          }
          reject(new Error(stderr || `${command} exited with ${String(code)}.`));
        });
      }),
    catch: (cause) => cause,
  });
}
