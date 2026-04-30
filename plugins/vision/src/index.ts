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
import { platform } from "node:os";

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
    return yield* captureScreenshot(outputPath).pipe(
      Effect.map((backend) => ({
        outputPath,
        captured: true,
        platform: platform(),
        backend,
        provenance: visualProvenance(outputPath, "screen"),
      })),
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
      provenance: visualProvenance(imagePath ?? "inline-image", "image"),
      aiSdkImage: {
        type: "image",
        image: bytes.toString("base64"),
        mediaType: detectImageType(bytes),
      },
      description:
        "Image bytes are prepared for direct multimodal LLM input through the AI SDK image part format.",
    };
  })();
}

function ocr(input: JsonValue): JsonValue {
  const parsed = requireObject(input, "screen.ocr");
  return {
    text: "",
    imagePath: optionalString(parsed, "imagePath") ?? null,
    provenance: visualProvenance(
      optionalString(parsed, "imagePath") ?? "inline-image",
      "image",
    ),
    message:
      "OCR provider integration is pending; this tool defines the policy-gated OCR capability surface.",
  };
}

function visualProvenance(sourceId: string, domain: "screen" | "image"): JsonValue {
  return [
    {
      sourceId,
      sourceType: "file",
      trust: "untrusted",
      domain,
    },
  ];
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

function captureScreenshot(outputPath: string): Effect.Effect<string, unknown> {
  const currentPlatform = platform();
  if (currentPlatform === "darwin") {
    return runFirstAvailable([
      { command: "screencapture", args: ["-x", outputPath], backend: "screencapture" },
    ]);
  }
  if (currentPlatform === "linux") {
    return runFirstAvailable([
      {
        command: "gnome-screenshot",
        args: ["-f", outputPath],
        backend: "gnome-screenshot",
      },
      {
        command: "import",
        args: ["-window", "root", outputPath],
        backend: "imagemagick-import",
      },
      { command: "scrot", args: [outputPath], backend: "scrot" },
    ]);
  }
  if (currentPlatform === "win32") {
    return runCommand(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        windowsScreenshotScript(outputPath),
      ],
      30_000,
    ).pipe(Effect.as("powershell"));
  }
  return Effect.fail(
    new Error(`Screen capture is not supported on platform '${currentPlatform}'.`),
  );
}

function runFirstAvailable(
  candidates: readonly { command: string; args: readonly string[]; backend: string }[],
): Effect.Effect<string, unknown> {
  const [candidate, ...rest] = candidates;
  if (!candidate) {
    return Effect.fail(new Error("No screenshot backend is available."));
  }
  return runCommand(candidate.command, candidate.args, 30_000).pipe(
    Effect.as(candidate.backend),
    Effect.catchAll((error) =>
      rest.length > 0 ? runFirstAvailable(rest) : Effect.fail(error),
    ),
  );
}

function windowsScreenshotScript(outputPath: string): string {
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save(${JSON.stringify(outputPath)})
$graphics.Dispose()
$bitmap.Dispose()
`;
}

function runCommand(command: string, args: readonly string[], timeoutMs: number) {
  return Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(command, [...args], { shell: false });
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
