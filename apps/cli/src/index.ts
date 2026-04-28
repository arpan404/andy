#!/usr/bin/env node
import { ConsoleAuditSink } from "@andy/audit";
import { AgentRuntime } from "@andy/core";
import { definePlugin, defineTool } from "@andy/plugin-sdk";
import { CapabilityPolicy } from "@andy/policy";
import {
  getJsonObjectProperty,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "@andy/types";
import { Effect } from "effect";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createConnection } from "node:net";

type DaemonRequestMethod = "GET" | "POST";

interface ParsedArgs {
  command: string | undefined;
  rest: string[];
  enable: boolean;
  manifestPath?: string;
  workflow?: string;
  input?: JsonValue;
  skills: string[];
  modelProviderId?: string;
  home?: string;
  force: boolean;
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  disable: boolean;
  channel?: string;
  pollMs?: number;
  images: { path: string; mediaType?: string }[];
  audioPath?: string;
  transcriptPath?: string;
  voice?: string;
  speak: boolean;
  limit?: number;
  eventType?: string;
  traceId?: string;
  sessionId?: string;
  fromSequence?: number;
}

const corePlugin = definePlugin({
  id: "andy.core",
  name: "Andy Core Tools",
  version: "0.1.0",
  capabilities: ["agent.respond"],
  tools: [
    defineTool({
      name: "agent.respond",
      description: "Return a direct response through the plugin execution path.",
      capabilities: ["agent.respond"],
      risk: "low",
      execute(input: { message: string }, context) {
        return Effect.gen(function* () {
          yield* context.scratchFs.writeFile("last-message.txt", input.message.trim());
          return {
            message:
              input.message.trim().length > 0
                ? `Andy plugin runtime received: ${input.message}`
                : "Andy plugin runtime is ready.",
          };
        });
      },
    }),
  ],
});

const parsed = parseArgs(process.argv.slice(2));

if (parsed.command === "status") {
  await printDaemonJson("GET", "/status");
} else if (parsed.command === "setup") {
  await runSetupCommand(parsed);
} else if (parsed.command === "config") {
  await runConfigCommand(parsed);
} else if (parsed.command === "plugin" || parsed.command === "plugins") {
  await runPluginCommand(parsed);
} else if (parsed.command === "skill" || parsed.command === "skills") {
  await runSkillCommand(parsed);
} else if (parsed.command === "ask") {
  await runAskCommand(parsed);
} else if (parsed.command === "voice") {
  await runVoiceCommand(parsed);
} else if (
  parsed.command === "events" ||
  parsed.command === "logs" ||
  parsed.command === "traces"
) {
  await runObservabilityCommand(parsed);
} else if (parsed.command === "approval" || parsed.command === "approvals") {
  await runApprovalCommand(parsed);
} else if (parsed.command === "help" || parsed.command === "--help") {
  printHelp();
} else {
  await runLegacySmoke(process.argv.slice(2).join(" "));
}

async function runSetupCommand(args: ParsedArgs): Promise<void> {
  const { ANDY_HOME } = process.env;
  const home = resolve(args.home ?? ANDY_HOME ?? process.cwd());
  await mkdir(home, { recursive: true });
  const configPath = join(home, ".andy", "daemon.json");
  if (existsSync(configPath) && !args.force) {
    console.log(
      JSON.stringify(
        {
          status: "exists",
          home,
          configPath,
          next: ["Config already exists. Use --force to recreate it."],
        },
        null,
        2,
      ),
    );
    return;
  }
  const daemonPath = findDaemonBinary();
  const result = await spawnAndCollect(daemonPath, ["--init"], { ANDY_HOME: home });
  if (result.exitCode !== 0 && !args.force) {
    throw new Error(result.stderr || `andy-daemon --init exited ${result.exitCode}`);
  }
  console.log(
    JSON.stringify(
      {
        status: "ready",
        home,
        configPath,
        next: [
          "Use `andy status --home <path>` or set ANDY_HOME for ACP-backed CLI commands.",
          "Start `andy-desktop` or `andy-daemon` only when you need the web console, webhooks, or background loops.",
        ],
      },
      null,
      2,
    ),
  );
}

async function runConfigCommand(args: ParsedArgs): Promise<void> {
  const [action, subject, value] = args.rest;
  if (!action || action === "show") {
    await printDaemonJson("GET", "/config");
    return;
  }
  if (action === "set-model-provider") {
    const id = subject;
    if (!id || !args.provider || !args.model) {
      throw new Error(
        "Usage: andy config set-model-provider <id> --provider openai|anthropic|google --model <modelId> [--api-key-env ENV] [--enable]",
      );
    }
    await printDaemonJson("POST", "/config/model-provider", {
      id,
      provider: normalizeProvider(args.provider),
      modelId: args.model,
      ...(args.apiKeyEnv ? { apiKeyEnv: args.apiKeyEnv } : {}),
      enabled: args.enable,
    });
    return;
  }
  if (action === "enable-model-provider" || action === "disable-model-provider") {
    const id = subject;
    if (!id) {
      throw new Error(`Usage: andy config ${action} <id>`);
    }
    await printDaemonJson(
      "POST",
      `/config/model-provider/${id}/${action.startsWith("enable") ? "enable" : "disable"}`,
    );
    return;
  }
  if (action === "remote") {
    const channel = subject ?? args.channel;
    if (channel !== "telegram" && channel !== "whatsapp") {
      throw new Error(
        "Usage: andy config remote <telegram|whatsapp> [--enable|--disable] [--model-provider id]",
      );
    }
    await printDaemonJson("POST", "/config/remote-control", {
      channel,
      enabled: args.enable && !args.disable,
      ...(args.modelProviderId ? { modelProviderId: args.modelProviderId } : {}),
      ...(args.pollMs ? { pollMs: args.pollMs } : {}),
      ...(value ? { systemPrompt: value } : {}),
    });
    return;
  }
  throw new Error(`Unknown config command '${action}'.`);
}

async function runAskCommand(args: ParsedArgs): Promise<void> {
  const message = args.rest.join(" ").trim();
  if (!message) {
    throw new Error("Usage: andy ask [--skills skill.a,skill.b] <message>");
  }
  await printDaemonJson("POST", "/agent/run", {
    message,
    skillIds: args.skills,
    ...(args.modelProviderId ? { modelProviderId: args.modelProviderId } : {}),
    ...(args.images.length > 0 ? { images: args.images } : {}),
  });
}

async function runVoiceCommand(args: ParsedArgs): Promise<void> {
  const [action, ...rest] = args.rest;
  if (action === "stop") {
    await printDaemonJson("POST", "/voice/stop", {});
    return;
  }
  if (!action || action === "turn") {
    const text = rest.join(" ").trim();
    if (!text && !args.audioPath && !args.transcriptPath) {
      throw new Error(
        "Usage: andy voice turn [--audio path|--transcript path|text] [--no-speak] [--voice name]",
      );
    }
    await printDaemonJson("POST", "/voice/turn", {
      ...(text ? { text } : {}),
      ...(args.audioPath ? { audioPath: args.audioPath } : {}),
      ...(args.transcriptPath ? { transcriptPath: args.transcriptPath } : {}),
      ...(args.modelProviderId ? { modelProviderId: args.modelProviderId } : {}),
      ...(args.skills.length > 0 ? { skillIds: args.skills } : {}),
      ...(args.voice ? { voice: args.voice } : {}),
      speak: args.speak,
    });
    return;
  }
  throw new Error(`Unknown voice command '${action}'.`);
}

async function runPluginCommand(args: ParsedArgs): Promise<void> {
  const [action, ...rest] = args.rest;
  if (!action || action === "list") {
    await printDaemonJson("GET", "/plugins");
    return;
  }

  if (action === "install-local") {
    const [manifestPath] = rest;
    if (!manifestPath) {
      throw new Error("Usage: andy plugin install-local <manifestPath> [--enable]");
    }
    await printDaemonJson("POST", "/plugins/install-local", {
      manifestPath,
      enabled: args.enable,
    });
    return;
  }
  if (action === "review-local") {
    const [manifestPath] = rest;
    if (!manifestPath) {
      throw new Error("Usage: andy plugin review-local <manifestPath>");
    }
    await printDaemonJson("POST", "/plugins/review-local", {
      manifestPath,
    });
    return;
  }

  if (action === "install-github") {
    const [repository, ref] = rest;
    if (!repository || !ref) {
      throw new Error(
        "Usage: andy plugin install-github <repository-url> <commit-or-version-tag> [--manifest plugin.json] [--enable]",
      );
    }
    await printDaemonJson("POST", "/plugins/install-github", {
      repository,
      ref,
      ...(args.manifestPath ? { manifestPath: args.manifestPath } : {}),
      enabled: args.enable,
    });
    return;
  }

  if (action === "enable" || action === "disable" || action === "remove") {
    const [pluginId] = rest;
    if (!pluginId) {
      throw new Error(`Usage: andy plugin ${action} <pluginId>`);
    }
    await printDaemonJson("POST", `/plugins/${pluginId}/${action}`);
    return;
  }

  if (action === "restart-crashed") {
    await printDaemonJson("POST", "/plugins/restart-crashed");
    return;
  }

  throw new Error(`Unknown plugin command '${action}'.`);
}

async function runSkillCommand(args: ParsedArgs): Promise<void> {
  const [action, ...rest] = args.rest;
  if (!action || action === "list") {
    await printDaemonJson("GET", "/skills");
    return;
  }

  if (action === "install-local") {
    const [manifestPath] = rest;
    if (!manifestPath) {
      throw new Error("Usage: andy skill install-local <manifestPath> [--enable]");
    }
    await printDaemonJson("POST", "/skills/install-local", {
      manifestPath,
      enabled: args.enable,
    });
    return;
  }
  if (action === "review-local") {
    const [manifestPath] = rest;
    if (!manifestPath) {
      throw new Error("Usage: andy skill review-local <manifestPath>");
    }
    await printDaemonJson("POST", "/skills/review-local", {
      manifestPath,
    });
    return;
  }

  if (action === "enable" || action === "disable" || action === "remove") {
    const [skillId] = rest;
    if (!skillId) {
      throw new Error(`Usage: andy skill ${action} <skillId>`);
    }
    await printDaemonJson("POST", `/skills/${skillId}/${action}`);
    return;
  }

  if (action === "run") {
    const [skillId] = rest;
    if (!skillId) {
      throw new Error(
        'Usage: andy skill run <skillId> [--workflow name] [--input \'{"key":"value"}\']',
      );
    }
    await printDaemonJson("POST", `/skills/${skillId}/run`, {
      ...(args.workflow ? { workflow: args.workflow } : {}),
      input: args.input ?? {},
    });
    return;
  }

  throw new Error(`Unknown skill command '${action}'.`);
}

async function runApprovalCommand(args: ParsedArgs): Promise<void> {
  const [action, approvalId] = args.rest;
  if (!action || action === "list") {
    await printDaemonJson("GET", "/approvals");
    return;
  }

  if (action === "approve" || action === "deny") {
    if (!approvalId) {
      throw new Error(`Usage: andy approval ${action} <approvalId>`);
    }
    await printDaemonJson("POST", `/approvals/${approvalId}/${action}`);
    return;
  }

  throw new Error(`Unknown approval command '${action}'.`);
}

async function runObservabilityCommand(args: ParsedArgs): Promise<void> {
  const params = new URLSearchParams();
  if (args.limit) {
    params.set("limit", String(args.limit));
  }
  if (args.eventType && args.command !== "traces") {
    params.set("type", args.eventType);
  }
  if (args.traceId) {
    params.set("traceId", args.traceId);
  }
  if (args.sessionId && args.command !== "traces") {
    params.set("sessionId", args.sessionId);
  }
  if (args.fromSequence && args.command !== "traces") {
    params.set("fromSequence", String(args.fromSequence));
  }
  const query = params.toString();
  await printDaemonJson("GET", `/${args.command}${query ? `?${query}` : ""}`);
}

async function printDaemonJson(
  method: DaemonRequestMethod,
  path: string,
  body?: JsonValue,
): Promise<void> {
  const [pathname, queryString] = path.split("?", 2);
  const query = Object.fromEntries(new URLSearchParams(queryString ?? ""));
  const result = await runAcpRequest("andy/request", {
    method,
    path: pathname ?? path,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(body !== undefined ? { body } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
}

function parseArgs(input: string[]): ParsedArgs {
  let enable = false;
  let manifestPath: string | undefined;
  let home: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let apiKeyEnv: string | undefined;
  let channel: string | undefined;
  let pollMs: number | undefined;
  let audioPath: string | undefined;
  let transcriptPath: string | undefined;
  let voice: string | undefined;
  let limit: number | undefined;
  let eventType: string | undefined;
  let traceId: string | undefined;
  let sessionId: string | undefined;
  let fromSequence: number | undefined;
  const images: { path: string; mediaType?: string }[] = [];
  let force = false;
  let disable = false;
  let speak = true;
  const positional: string[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (arg === "--enable") {
      enable = true;
      continue;
    }
    if (arg === "--disable") {
      disable = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--home") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--home requires a value.");
      }
      home = value;
      index += 1;
      continue;
    }
    if (arg === "--provider") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--provider requires a value.");
      }
      provider = value;
      index += 1;
      continue;
    }
    if (arg === "--model") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--model requires a value.");
      }
      model = value;
      index += 1;
      continue;
    }
    if (arg === "--api-key-env") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--api-key-env requires a value.");
      }
      apiKeyEnv = value;
      index += 1;
      continue;
    }
    if (arg === "--channel") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--channel requires a value.");
      }
      channel = value;
      index += 1;
      continue;
    }
    if (arg === "--poll-ms") {
      const value = input[index + 1];
      const parsed = value ? Number(value) : Number.NaN;
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--poll-ms requires a positive number.");
      }
      pollMs = parsed;
      index += 1;
      continue;
    }
    if (arg === "--image") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--image requires a file path.");
      }
      const mediaType = guessImageMediaType(value);
      images.push({ path: value, ...(mediaType ? { mediaType } : {}) });
      index += 1;
      continue;
    }
    if (arg === "--audio") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--audio requires a file path.");
      }
      audioPath = value;
      index += 1;
      continue;
    }
    if (arg === "--transcript") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--transcript requires a file path.");
      }
      transcriptPath = value;
      index += 1;
      continue;
    }
    if (arg === "--voice") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--voice requires a value.");
      }
      voice = value;
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      limit = parsePositiveFlag(input[index + 1], "--limit");
      index += 1;
      continue;
    }
    if (arg === "--type") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--type requires a value.");
      }
      eventType = value;
      index += 1;
      continue;
    }
    if (arg === "--trace-id") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--trace-id requires a value.");
      }
      traceId = value;
      index += 1;
      continue;
    }
    if (arg === "--session-id") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--session-id requires a value.");
      }
      sessionId = value;
      index += 1;
      continue;
    }
    if (arg === "--from-sequence") {
      fromSequence = parsePositiveFlag(input[index + 1], "--from-sequence");
      index += 1;
      continue;
    }
    if (arg === "--no-speak") {
      speak = false;
      continue;
    }
    if (arg === "--manifest") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--manifest requires a value.");
      }
      manifestPath = value;
      index += 1;
      continue;
    }
    if (arg === "--workflow") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--workflow requires a value.");
      }
      positional.push(`__workflow:${value}`);
      index += 1;
      continue;
    }
    if (arg === "--input") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--input requires a JSON value.");
      }
      positional.push(`__input:${value}`);
      index += 1;
      continue;
    }
    if (arg === "--skills") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--skills requires a comma-separated value.");
      }
      positional.push(`__skills:${value}`);
      index += 1;
      continue;
    }
    if (arg === "--model-provider") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--model-provider requires a value.");
      }
      positional.push(`__modelProvider:${value}`);
      index += 1;
      continue;
    }
    if (arg) {
      positional.push(arg);
    }
  }

  const [command, ...rest] = positional;
  const workflowMarker = rest.find((item) => item.startsWith("__workflow:"));
  const inputMarker = rest.find((item) => item.startsWith("__input:"));
  const skillsMarker = rest.find((item) => item.startsWith("__skills:"));
  const modelProviderMarker = rest.find((item) => item.startsWith("__modelProvider:"));
  return {
    command,
    rest: rest
      .filter((item) => !item.startsWith("__workflow:") && !item.startsWith("__input:"))
      .filter(
        (item) => !item.startsWith("__skills:") && !item.startsWith("__modelProvider:"),
      ),
    enable,
    force,
    disable,
    speak,
    images,
    skills: skillsMarker
      ? skillsMarker
          .slice("__skills:".length)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [],
    ...(manifestPath ? { manifestPath } : {}),
    ...(home ? { home } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(channel ? { channel } : {}),
    ...(pollMs ? { pollMs } : {}),
    ...(audioPath ? { audioPath } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(voice ? { voice } : {}),
    ...(limit ? { limit } : {}),
    ...(eventType ? { eventType } : {}),
    ...(traceId ? { traceId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(fromSequence ? { fromSequence } : {}),
    ...(workflowMarker ? { workflow: workflowMarker.slice("__workflow:".length) } : {}),
    ...(modelProviderMarker
      ? { modelProviderId: modelProviderMarker.slice("__modelProvider:".length) }
      : {}),
    ...(inputMarker
      ? { input: parseJsonResponse(inputMarker.slice("__input:".length)) }
      : {}),
  };
}

function parsePositiveFlag(value: string | undefined, flag: string): number {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive number.`);
  }
  return parsed;
}

function guessImageMediaType(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return undefined;
}

function normalizeProvider(provider: string): string {
  if (provider.startsWith("ai-sdk.")) {
    return provider;
  }
  return `ai-sdk.${provider}`;
}

function findDaemonBinary(): string {
  const candidates = [
    resolve(dirname(process.execPath), "andy-daemon"),
    resolve(process.cwd(), "dist", "andy-daemon"),
    resolve(process.cwd(), "bin", "andy-daemon"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("Could not find andy-daemon next to the CLI or under ./dist.");
  }
  return found;
}

async function spawnAndCollect(
  command: string,
  args: string[],
  env: Record<string, string>,
  stdin?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      shell: false,
      env: { ...process.env, ...env },
    });
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
      resolveResult({ exitCode: code ?? 1, stdout, stderr });
    });
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    }
  });
}

async function runAcpRequest(method: string, params: JsonValue): Promise<JsonValue> {
  const daemonPath = findDaemonBinary();
  const id = 1;
  const payload = `${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params,
  })}\n`;
  const socketPath = getAcpSocketPath(resolveAndyHome());
  if (existsSync(socketPath) || platform() === "win32") {
    const socketResult = await tryAcpSocketRequest(socketPath, payload, id);
    if (socketResult.connected) {
      return socketResult.result;
    }
  }
  const result = await spawnAndCollect(
    daemonPath,
    ["--acp"],
    parsed.home ? { ANDY_HOME: resolve(parsed.home) } : {},
    payload,
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `andy-daemon --acp exited ${result.exitCode}`);
  }
  const response = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJsonResponse(line))
    .find(
      (item): item is JsonObject =>
        isJsonObject(item) && getJsonObjectProperty(item, "id") === id,
    );
  if (!response) {
    throw new Error("ACP daemon did not return a response.");
  }
  const error = getJsonObjectProperty(response, "error");
  if (isJsonObject(error)) {
    const message = getJsonObjectProperty(error, "message");
    throw new Error(typeof message === "string" ? message : JSON.stringify(error));
  }
  const resultValue = getJsonObjectProperty(response, "result");
  return isJsonValue(resultValue) ? resultValue : {};
}

function resolveAndyHome(): string {
  const { ANDY_HOME } = process.env;
  return resolve(parsed.home ?? ANDY_HOME ?? process.cwd());
}

function getAcpSocketPath(home: string): string {
  if (platform() === "win32") {
    return `\\\\.\\pipe\\andy-${home.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
  }
  return join(home, ".andy", "andy.sock");
}

async function tryAcpSocketRequest(
  socketPath: string,
  payload: string,
  id: number,
): Promise<{ connected: true; result: JsonValue } | { connected: false }> {
  return await new Promise((resolveRequest, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finishNotConnected = () => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolveRequest({ connected: false });
    };
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        finishNotConnected();
        return;
      }
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const item = parseJsonResponse(trimmed);
        if (!isJsonObject(item) || getJsonObjectProperty(item, "id") !== id) {
          continue;
        }
        const error = getJsonObjectProperty(item, "error");
        if (isJsonObject(error)) {
          const message = getJsonObjectProperty(error, "message");
          settled = true;
          socket.end();
          reject(
            new Error(typeof message === "string" ? message : JSON.stringify(error)),
          );
          return;
        }
        const result = getJsonObjectProperty(item, "result");
        settled = true;
        socket.end();
        resolveRequest({ connected: true, result: isJsonValue(result) ? result : {} });
        return;
      }
    });
    socket.once("connect", () => {
      socket.write(payload);
    });
    socket.once("end", () => {
      if (!settled) {
        settled = true;
        reject(new Error("ACP socket closed before returning a response."));
      }
    });
  });
}

function parseJsonResponse(text: string): JsonValue {
  if (text.trim().length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(text);
  return isJsonValue(parsed) ? parsed : { value: String(parsed) };
}

function isJsonValue(value: unknown): value is JsonValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every(isJsonValue)) ||
    (typeof value === "object" &&
      value !== null &&
      Object.values(value).every(isJsonValue))
  );
}

function printHelp(): void {
  console.log(`Andy CLI

Usage:
  andy setup [--home path] [--force]
  andy status [--home path]
  andy config show
  andy config set-model-provider <id> --provider openai|anthropic|google --model <modelId> [--api-key-env ENV] [--enable]
  andy config enable-model-provider <id>
  andy config disable-model-provider <id>
  andy config remote <telegram|whatsapp> [--enable|--disable] [--model-provider id] [--poll-ms ms]
  andy ask [--skills skill.a,skill.b] [--model-provider id] [--image path] <message>
  andy voice turn [--skills skill.a,skill.b] [--model-provider id] [--audio path|--transcript path|text] [--voice name] [--no-speak]
  andy voice stop
  andy events [--limit n] [--type event.type] [--trace-id id] [--session-id id] [--from-sequence n]
  andy logs [--limit n] [--type event.type] [--trace-id id] [--session-id id]
  andy traces [--limit n] [--trace-id id]
  andy plugin list
  andy plugin install-local <manifestPath> [--enable]
  andy plugin review-local <manifestPath>
  andy plugin install-github <repository-url> <commit-or-version-tag> [--manifest plugin.json] [--enable]
  andy plugin enable <pluginId>
  andy plugin disable <pluginId>
  andy plugin remove <pluginId>
  andy plugin restart-crashed
  andy skill list
  andy skill install-local <manifestPath> [--enable]
  andy skill review-local <manifestPath>
  andy skill enable <skillId>
  andy skill disable <skillId>
  andy skill remove <skillId>
  andy skill run <skillId> [--workflow name] [--input '{"key":"value"}']
  andy approval list
  andy approval approve <approvalId>
  andy approval deny <approvalId>

Environment:
  ANDY_HOME selects the daemon home used by ACP-backed CLI commands.`);
}

async function runLegacySmoke(message: string): Promise<void> {
  const audit = new ConsoleAuditSink();
  const policy = new CapabilityPolicy({
    allowedCapabilities: new Set(["agent.respond"]),
  });
  const runtime = new AgentRuntime({ audit, policy });
  Effect.runSync(runtime.registerPlugin(corePlugin));

  const result = await Effect.runPromise(
    runtime.executeTool("agent.respond", {
      message,
    }),
  );

  console.log(readMessage(result.output));
}

function readMessage(value: JsonValue): string {
  if (isJsonObject(value)) {
    const message = getJsonObjectProperty(value, "message");
    if (typeof message === "string") {
      return message;
    }
  }

  return "Andy plugin runtime completed without a message.";
}
