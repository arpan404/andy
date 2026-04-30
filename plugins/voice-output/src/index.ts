import {
  optionalNumber,
  optionalString,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonObject, JsonValue } from "@andy/types";
import { Effect } from "effect";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { platform } from "node:os";

let activeSpeech: ChildProcessWithoutNullStreams | undefined;

startWorkerPlugin((request) =>
  Effect.fn("voice-output.handleRequest")(function* () {
    switch (request.toolName) {
      case "voice.speak":
        return yield* speak(request.input);
      case "voice.stop":
        return stopSpeech();
      default:
        return yield* Effect.fail(
          new Error(`Unknown voice-output tool '${request.toolName}'.`),
        );
    }
  })(),
);

function speak(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("voice.speak")(function* () {
    const parsed = requireObject(input, "voice.speak");
    const text = requireString(parsed, "text");
    const voice = optionalString(parsed, "voice");
    const rate = optionalNumber(parsed, "rate");
    const result = yield* currentAdapter().speak({
      text,
      ...(voice ? { voice } : {}),
      ...(rate ? { rate } : {}),
    });
    return { ...result, spoken: true };
  })();
}

function stopSpeech(): JsonValue {
  if (!activeSpeech || activeSpeech.exitCode !== null) {
    return { stopped: false, message: "No active speech process." };
  }
  activeSpeech.kill("SIGTERM");
  activeSpeech = undefined;
  return { stopped: true };
}

interface SpeechOptions {
  text: string;
  voice?: string;
  rate?: number;
}

interface VoiceOutputAdapter {
  platform: string;
  speak(input: SpeechOptions): Effect.Effect<JsonObject, unknown>;
}

function currentAdapter(): VoiceOutputAdapter {
  const currentPlatform = platform();
  if (currentPlatform === "darwin") return macosAdapter;
  if (currentPlatform === "linux") return linuxAdapter;
  if (currentPlatform === "win32") return windowsAdapter;
  return unsupportedAdapter(currentPlatform);
}

const macosAdapter: VoiceOutputAdapter = {
  platform: "darwin",
  speak: ({ text, voice, rate }) =>
    runFirstAvailable([
      {
        command: "say",
        args: [
          ...(voice ? ["-v", voice] : []),
          ...(rate ? ["-r", String(rate)] : []),
          text,
        ],
        backend: "say",
      },
    ]).pipe(Effect.map((result) => ({ ...result, platform: "darwin" }))),
};

const linuxAdapter: VoiceOutputAdapter = {
  platform: "linux",
  speak: ({ text, rate }) =>
    runFirstAvailable([
      {
        command: "spd-say",
        args: [...(rate ? ["--rate", String(Math.round(rate))] : []), text],
        backend: "spd-say",
      },
      {
        command: "espeak",
        args: [...(rate ? ["-s", String(Math.round(rate))] : []), text],
        backend: "espeak",
      },
    ]).pipe(Effect.map((result) => ({ ...result, platform: "linux" }))),
};

const windowsAdapter: VoiceOutputAdapter = {
  platform: "win32",
  speak: ({ text, voice, rate }) =>
    runCommand(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        windowsSpeakScript(text, voice, rate),
      ],
      120_000,
      "powershell-speech",
    ).pipe(Effect.map((result) => ({ ...result, platform: "win32" }))),
};

function unsupportedAdapter(currentPlatform: string): VoiceOutputAdapter {
  return {
    platform: currentPlatform,
    speak: () =>
      Effect.fail(
        new Error(`Voice output is not supported on platform '${currentPlatform}'.`),
      ),
  };
}

function windowsSpeakScript(
  text: string,
  voice: string | undefined,
  rate: number | undefined,
) {
  return `
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
${voice ? `$speaker.SelectVoice(${JSON.stringify(voice)})` : ""}
${rate ? `$speaker.Rate = ${String(Math.max(-10, Math.min(10, Math.round(rate))))}` : ""}
$speaker.Speak(${JSON.stringify(text)})
$speaker.Dispose()
`;
}

function runFirstAvailable(
  candidates: readonly { command: string; args: readonly string[]; backend: string }[],
): Effect.Effect<JsonObject, unknown> {
  const [candidate, ...rest] = candidates;
  if (!candidate) {
    return Effect.fail(new Error("No voice output backend is available."));
  }
  return runCommand(candidate.command, candidate.args, 120_000, candidate.backend).pipe(
    Effect.catchAll((error) =>
      rest.length > 0 ? runFirstAvailable(rest) : Effect.fail(error),
    ),
  );
}

function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  backend: string,
): Effect.Effect<JsonObject, unknown> {
  return Effect.tryPromise({
    try: () =>
      new Promise<JsonObject>((resolve, reject) => {
        const child = spawn(command, [...args], { shell: false });
        activeSpeech = child;
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
          if (activeSpeech === child) {
            activeSpeech = undefined;
          }
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          if (activeSpeech === child) {
            activeSpeech = undefined;
          }
          if (code === 0) {
            resolve({ command, backend, exitCode: code });
            return;
          }
          reject(new Error(stderr || `${command} exited with ${String(code)}.`));
        });
      }),
    catch: (cause) => cause,
  });
}
