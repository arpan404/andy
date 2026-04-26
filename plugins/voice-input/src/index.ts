import {
  optionalNumber,
  optionalString,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonValue } from "@andy/types";
import { Effect } from "effect";

startWorkerPlugin((request) =>
  Effect.fn("voice-input.handleRequest")(function* () {
    switch (request.toolName) {
      case "voice.listen":
        return listen(request.input);
      case "voice.transcribe":
        return transcribe(request.input);
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
    message:
      "Native microphone capture is intentionally gated; this plugin exposes the policy surface and accepts transcribe inputs from approved capture adapters.",
  };
}

function transcribe(input: JsonValue): JsonValue {
  const parsed = requireObject(input, "voice.transcribe");
  const text = optionalString(parsed, "text");
  if (text) {
    return { text, confidence: 1, source: "provided-text" };
  }
  const audioPath = requireString(parsed, "audioPath");
  return {
    text: "",
    confidence: 0,
    source: "audio-file",
    audioPath,
    message:
      "Speech-to-text provider integration is pending; audio file input is recorded for a provider plugin handoff.",
  };
}
