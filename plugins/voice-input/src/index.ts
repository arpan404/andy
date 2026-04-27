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
import { readFile } from "node:fs/promises";
import { platform } from "node:os";

startWorkerPlugin((request) =>
  Effect.fn("voice-input.handleRequest")(function* () {
    switch (request.toolName) {
      case "voice.listen":
        return listen(request.input);
      case "voice.record":
        return yield* record(request.input);
      case "voice.transcribe":
        return yield* transcribe(request.input);
      default:
        return yield* Effect.fail(
          new Error(`Unknown voice-input tool '${request.toolName}'.`),
        );
    }
  })(),
);

function listen(input: JsonValue): JsonValue {
  const parsed = requireObject(input, "voice.listen");
  const mode = optionalString(parsed, "activationMode") ?? "manual";
  const durationMs = optionalNumber(parsed, "durationMs") ?? 0;
  return {
    status: "armed",
    activationMode: mode,
    durationMs,
    platform: platform(),
    supportedActivationModes: ["manual", "push-to-talk"],
    recordBackends: recordBackendNames(),
    message:
      "Voice input is explicit activation only. Use voice.record to capture approved audio or voice.transcribe with provided transcript text.",
  };
}

function record(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("voice.record")(function* () {
    const parsed = requireObject(input, "voice.record");
    const outputPath = requireString(parsed, "outputPath");
    const durationMs = optionalNumber(parsed, "durationMs") ?? 5000;
    if (durationMs <= 0 || durationMs > 120_000) {
      return yield* Effect.fail(
        new Error("voice.record durationMs must be between 1 and 120000."),
      );
    }
    const backend = yield* recordAudio(outputPath, durationMs);
    return {
      recorded: true,
      outputPath,
      durationMs,
      platform: platform(),
      backend,
    };
  })();
}

function transcribe(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("voice.transcribe")(function* () {
    const parsed = requireObject(input, "voice.transcribe");
    const text = optionalString(parsed, "text");
    if (text) {
      return { text, confidence: 1, source: "provided-text" };
    }
    const transcriptPath = optionalString(parsed, "transcriptPath");
    if (transcriptPath) {
      const transcript = yield* Effect.tryPromise({
        try: () => readFile(transcriptPath, "utf8"),
        catch: (cause) => cause,
      });
      return {
        text: transcript.trim(),
        confidence: 1,
        source: "transcript-file",
        transcriptPath,
      };
    }
    const audioPath = requireString(parsed, "audioPath");
    return {
      text: "",
      confidence: 0,
      source: "audio-file",
      audioPath,
      providerRequired: true,
      message:
        "Audio capture succeeded, but speech-to-text provider integration is not configured. Provide text or transcriptPath, or install an STT provider plugin.",
    };
  })();
}

function recordAudio(
  outputPath: string,
  durationMs: number,
): Effect.Effect<string, unknown> {
  const seconds = Math.max(1, Math.ceil(durationMs / 1000));
  const currentPlatform = platform();
  if (currentPlatform === "darwin") {
    return runFirstAvailable([
      {
        command: "ffmpeg",
        args: [
          "-y",
          "-f",
          "avfoundation",
          "-i",
          ":0",
          "-t",
          String(seconds),
          outputPath,
        ],
        backend: "ffmpeg-avfoundation",
      },
      {
        command: "sox",
        args: ["-d", outputPath, "trim", "0", String(seconds)],
        backend: "sox-default-device",
      },
    ]);
  }
  if (currentPlatform === "linux") {
    return runFirstAvailable([
      {
        command: "ffmpeg",
        args: ["-y", "-f", "pulse", "-i", "default", "-t", String(seconds), outputPath],
        backend: "ffmpeg-pulse",
      },
      {
        command: "arecord",
        args: ["-d", String(seconds), "-f", "cd", outputPath],
        backend: "arecord",
      },
      {
        command: "parecord",
        args: ["--record", "--file-format=wav", outputPath],
        backend: "parecord",
      },
    ]);
  }
  if (currentPlatform === "win32") {
    return runFirstAvailable([
      {
        command: "ffmpeg.exe",
        args: [
          "-y",
          "-f",
          "dshow",
          "-i",
          "audio=default",
          "-t",
          String(seconds),
          outputPath,
        ],
        backend: "ffmpeg-dshow",
      },
    ]);
  }
  return Effect.fail(
    new Error(`Voice recording is not supported on platform '${currentPlatform}'.`),
  );
}

function recordBackendNames(): readonly string[] {
  const currentPlatform = platform();
  if (currentPlatform === "darwin") {
    return ["ffmpeg-avfoundation", "sox-default-device"];
  }
  if (currentPlatform === "linux") {
    return ["ffmpeg-pulse", "arecord", "parecord"];
  }
  if (currentPlatform === "win32") {
    return ["ffmpeg-dshow"];
  }
  return [];
}

function runFirstAvailable(
  candidates: readonly { command: string; args: readonly string[]; backend: string }[],
): Effect.Effect<string, unknown> {
  const [candidate, ...rest] = candidates;
  if (!candidate) {
    return Effect.fail(
      new Error(
        "No voice recording backend is available. Install ffmpeg, sox, arecord, or parecord for this platform.",
      ),
    );
  }
  return runCommand(candidate.command, candidate.args, 130_000).pipe(
    Effect.as(candidate.backend),
    Effect.catchAll((error) =>
      rest.length > 0 ? runFirstAvailable(rest) : Effect.fail(error),
    ),
  );
}

function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(command, [...args], { shell: false });
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
          code === 0
            ? resolve()
            : reject(new Error(stderr || `${command} exited ${String(code)}.`));
        });
      }),
    catch: (cause) => cause,
  });
}
