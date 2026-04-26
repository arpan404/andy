import {
  optionalString,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonValue } from "@andy/types";
import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

startWorkerPlugin((request) =>
  Effect.fn("vision.handleRequest")(function* () {
    switch (request.toolName) {
      case "screen.capture":
        return yield* capture(request.input);
      case "screen.describe":
        return yield* describe(request.input);
      case "screen.ocr":
        return ocr(request.input);
      default:
        return yield* Effect.fail(
          new Error(`Unknown vision tool '${request.toolName}'.`),
        );
    }
  })(),
);

function capture(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("vision.capture")(function* () {
    const parsed = requireObject(input, "screen.capture");
    const outputPath = requireString(parsed, "outputPath");
    return yield* runCommand("screencapture", ["-x", outputPath], 30_000).pipe(
      Effect.map(() => ({ outputPath, captured: true })),
    );
  })();
}

function describe(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("vision.describe")(function* () {
    const parsed = requireObject(input, "screen.describe");
    const imagePath = optionalString(parsed, "imagePath");
    const imageBase64 = optionalString(parsed, "imageBase64");
    const bytes = imageBase64
      ? Buffer.from(imageBase64, "base64")
      : yield* Effect.tryPromise(() => readFile(requireString(parsed, "imagePath")));
    return {
      source: imagePath ? "file" : "base64",
      imagePath: imagePath ?? null,
      bytes: bytes.byteLength,
      mediaType: detectImageType(bytes),
      description:
        "Image bytes are available. Detailed visual reasoning is delegated to a model/vision provider plugin.",
    };
  })();
}

function ocr(input: JsonValue): JsonValue {
  const parsed = requireObject(input, "screen.ocr");
  return {
    text: "",
    imagePath: optionalString(parsed, "imagePath") ?? null,
    message:
      "OCR provider integration is pending; this tool defines the policy-gated OCR capability surface.",
  };
}

function detectImageType(bytes: Buffer): string {
  if (
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "image/jpeg";
  }
  return "application/octet-stream";
}

function runCommand(command: string, args: string[], timeoutMs: number) {
  return Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { shell: false });
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`${command} timed out.`));
        }, timeoutMs);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          code === 0
            ? resolve()
            : reject(new Error(`${command} exited ${String(code)}.`));
        });
      }),
    catch: (cause) => cause,
  });
}
