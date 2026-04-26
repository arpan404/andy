#!/usr/bin/env node
import { ConsoleAuditSink } from "@andy/audit";
import { AgentKernel, createAndyDaemon, JsonFileCoreStateStore } from "@andy/core";
import type { AndyDaemonServices } from "@andy/core";
import { createAiSdkOpenAiModelProvider } from "@andy/model-ai-sdk";
import { parsePluginManifest, type PluginManifest } from "@andy/plugin-sdk";
import { CapabilityPolicy } from "@andy/policy";
import { Effect } from "effect";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

interface DaemonConfig {
  statePath: string;
  backgroundPollMs: number;
  allowedCapabilities: string[];
  approvalRequiredCapabilities: string[];
  plugins: DaemonPluginConfig[];
  modelProviders: DaemonModelProviderConfig[];
  remoteControl: DaemonRemoteControlConfig;
}

interface DaemonPluginConfig {
  manifestPath: string;
  enabled: boolean;
}

interface DaemonModelProviderConfig {
  id: string;
  provider: "ai-sdk.openai";
  enabled: boolean;
  modelId: string;
  apiKeyEnv?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
}

interface DaemonRemoteControlConfig {
  telegram?: {
    enabled: boolean;
    modelProviderId: string;
    pollMs: number;
    systemPrompt?: string;
  };
}

interface BootedDaemon {
  services: AndyDaemonServices;
  config: DaemonConfig;
  configPath: string;
  startedPluginIds: readonly string[];
}

const args = new Set(process.argv.slice(2));
const { ANDY_CONFIG, ANDY_HOME } = process.env;
const repositoryRoot = resolve(
  ANDY_HOME ?? findWorkspaceRoot(process.cwd()) ?? process.cwd(),
);
const configPath = resolveFromRoot(ANDY_CONFIG ?? ".andy/daemon.json");

if (args.has("--init")) {
  await writeDefaultConfig(configPath);
  console.log(`Created daemon config at ${configPath}`);
  process.exit(0);
}

const booted = await Effect.runPromise(bootDaemon(configPath));

if (args.has("--status")) {
  console.log(JSON.stringify(createStatus(booted), null, 2));
  await Effect.runPromise(shutdownDaemon(booted));
  process.exit(0);
}

if (args.has("--once")) {
  await Effect.runPromise(booted.services.backgroundExecutor.runDue());
  await Effect.runPromise(booted.services.saveState());
  console.log(JSON.stringify(createStatus(booted), null, 2));
  await Effect.runPromise(shutdownDaemon(booted));
  process.exit(0);
}

console.log(
  JSON.stringify({
    status: "running",
    configPath: booted.configPath,
    plugins: booted.startedPluginIds,
    backgroundPollMs: booted.config.backgroundPollMs,
  }),
);

const interval = setInterval(() => {
  Effect.runPromise(
    booted.services.backgroundExecutor
      .runDue()
      .pipe(Effect.zipRight(booted.services.saveState()), Effect.ignore),
  );
}, booted.config.backgroundPollMs);

let telegramOffset: number | undefined;
const telegramConfig = booted.config.remoteControl.telegram;
const telegramInterval =
  telegramConfig?.enabled === true
    ? setInterval(() => {
        Effect.runPromise(
          runTelegramRemoteControl(booted, telegramConfig, telegramOffset).pipe(
            Effect.tap((nextOffset) =>
              Effect.sync(() => {
                telegramOffset = nextOffset;
              }),
            ),
            Effect.zipRight(booted.services.saveState()),
            Effect.ignore,
          ),
        );
      }, telegramConfig.pollMs)
    : undefined;

const stop = async () => {
  clearInterval(interval);
  if (telegramInterval) {
    clearInterval(telegramInterval);
  }
  await Effect.runPromise(shutdownDaemon(booted));
  process.exit(0);
};

process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});

function bootDaemon(path: string): Effect.Effect<BootedDaemon, unknown> {
  return Effect.fn("daemon.boot")(function* () {
    const config = yield* loadOrCreateConfig(path);
    const audit = new ConsoleAuditSink();
    const services = yield* createAndyDaemon({
      audit,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(config.allowedCapabilities),
        approvalRequiredCapabilities: new Set(config.approvalRequiredCapabilities),
      }),
      stateStore: new JsonFileCoreStateStore(resolveFromRoot(config.statePath)),
    });

    const startedPluginIds: string[] = [];
    for (const provider of config.modelProviders) {
      if (!provider.enabled) {
        continue;
      }

      yield* services.modelProviders.register(createModelProvider(provider));
    }

    for (const plugin of config.plugins) {
      if (!plugin.enabled) {
        continue;
      }

      const manifest = yield* loadManifest(plugin.manifestPath);
      yield* services.lifecycle.start(manifest);
      startedPluginIds.push(manifest.id);
    }

    yield* services.saveState();
    return {
      services,
      config,
      configPath: path,
      startedPluginIds,
    };
  })();
}

function shutdownDaemon(booted: BootedDaemon): Effect.Effect<void, unknown> {
  return Effect.fn("daemon.shutdown")(function* () {
    yield* booted.services.saveState();
    yield* booted.services.lifecycle.stopAll();
  })();
}

function loadOrCreateConfig(path: string): Effect.Effect<DaemonConfig, unknown> {
  return Effect.fn("daemon.loadOrCreateConfig")(function* () {
    const loaded = yield* Effect.either(
      Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: (cause) => cause,
      }),
    );
    if (loaded._tag === "Right") {
      return parseConfig(JSON.parse(loaded.right));
    }

    const config = createDefaultConfig();
    yield* writeConfig(path, config);
    return config;
  })();
}

function loadManifest(path: string): Effect.Effect<PluginManifest, unknown> {
  return Effect.fn("daemon.loadManifest")(function* () {
    const manifestPath = resolveFromRoot(path);
    const text = yield* Effect.tryPromise({
      try: () => readFile(manifestPath, "utf8"),
      catch: (cause) => cause,
    });
    const parsed = parsePluginManifest(JSON.parse(text));
    return {
      ...parsed,
      entry: isAbsolute(parsed.entry)
        ? parsed.entry
        : resolve(dirname(manifestPath), parsed.entry),
    };
  })();
}

function resolveFromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(repositoryRoot, path);
}

function findWorkspaceRoot(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    const packagePath = resolve(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as {
          workspaces?: unknown;
        };
        if (Array.isArray(parsed.workspaces)) {
          return current;
        }
      } catch {}
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function writeDefaultConfig(path: string): Promise<void> {
  return Effect.runPromise(writeConfig(path, createDefaultConfig()));
}

function writeConfig(path: string, config: DaemonConfig): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    },
    catch: (cause) => cause,
  });
}

function createDefaultConfig(): DaemonConfig {
  return {
    statePath: ".andy/state.json",
    backgroundPollMs: 5_000,
    allowedCapabilities: [
      "memory.fetch",
      "memory.save",
      "memory.save_fact",
      "memory.query",
      "memory.forget",
      "memory.list",
      "filesystem.read",
      "filesystem.write",
      "filesystem.delete",
      "shell.execute",
      "messaging.receive",
      "messaging.send",
      "messaging.manage_webhook",
      "messaging.read_contact",
      "messaging.map_identity",
      "voice.listen",
      "voice.transcribe",
      "voice.speak",
      "microphone.read",
      "speaker.speak",
      "camera.read",
      "screen.capture",
      "screen.ocr",
      "screen.describe",
      "computer.mouse",
      "computer.keyboard",
      "computer.window",
      "computer.app",
      "computer.accessibility_tree",
    ],
    approvalRequiredCapabilities: [
      "filesystem.write",
      "filesystem.delete",
      "shell.execute",
      "messaging.send",
      "messaging.manage_webhook",
      "microphone.read",
      "screen.capture",
      "computer.mouse",
      "computer.keyboard",
      "computer.window",
      "computer.app",
      "computer.accessibility_tree",
    ],
    plugins: [
      {
        manifestPath: "plugins/memory-markdown/plugin.json",
        enabled: true,
      },
      { manifestPath: "plugins/filesystem/plugin.json", enabled: false },
      { manifestPath: "plugins/shell/plugin.json", enabled: false },
      { manifestPath: "plugins/telegram/plugin.json", enabled: false },
      { manifestPath: "plugins/whatsapp/plugin.json", enabled: false },
      { manifestPath: "plugins/voice-input/plugin.json", enabled: false },
      { manifestPath: "plugins/voice-output/plugin.json", enabled: false },
      { manifestPath: "plugins/vision/plugin.json", enabled: false },
      { manifestPath: "plugins/computer-control/plugin.json", enabled: false },
    ],
    modelProviders: [
      {
        id: "ai-sdk.openai.default",
        provider: "ai-sdk.openai",
        enabled: false,
        modelId: "gpt-4.1-mini",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    ],
    remoteControl: {
      telegram: {
        enabled: false,
        modelProviderId: "ai-sdk.openai.default",
        pollMs: 3_000,
        systemPrompt: "You are Andy. Respond concisely and use tools only when needed.",
      },
    },
  };
}

function parseConfig(value: unknown): DaemonConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error("Daemon config must be an object.");
  }
  const record = value as Partial<DaemonConfig>;
  return {
    statePath:
      typeof record.statePath === "string" ? record.statePath : ".andy/state.json",
    backgroundPollMs:
      typeof record.backgroundPollMs === "number" && record.backgroundPollMs > 0
        ? record.backgroundPollMs
        : 5_000,
    allowedCapabilities: Array.isArray(record.allowedCapabilities)
      ? record.allowedCapabilities.filter((item) => typeof item === "string")
      : createDefaultConfig().allowedCapabilities,
    approvalRequiredCapabilities: Array.isArray(record.approvalRequiredCapabilities)
      ? record.approvalRequiredCapabilities.filter((item) => typeof item === "string")
      : createDefaultConfig().approvalRequiredCapabilities,
    plugins: Array.isArray(record.plugins)
      ? record.plugins.flatMap(parsePluginConfig)
      : createDefaultConfig().plugins,
    modelProviders: Array.isArray(record.modelProviders)
      ? record.modelProviders.flatMap(parseModelProviderConfig)
      : createDefaultConfig().modelProviders,
    remoteControl: parseRemoteControlConfig(record.remoteControl),
  };
}

function parsePluginConfig(value: unknown): DaemonPluginConfig[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Partial<DaemonPluginConfig>;
  if (typeof record.manifestPath !== "string") {
    return [];
  }
  return [
    {
      manifestPath: record.manifestPath,
      enabled: record.enabled === true,
    },
  ];
}

function parseModelProviderConfig(value: unknown): DaemonModelProviderConfig[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Partial<DaemonModelProviderConfig>;
  if (record.provider !== "ai-sdk.openai" || typeof record.id !== "string") {
    return [];
  }
  return [
    {
      id: record.id,
      provider: "ai-sdk.openai",
      enabled: record.enabled === true,
      modelId: typeof record.modelId === "string" ? record.modelId : "gpt-4.1-mini",
      ...(typeof record.apiKeyEnv === "string" ? { apiKeyEnv: record.apiKeyEnv } : {}),
      ...(typeof record.baseURL === "string" ? { baseURL: record.baseURL } : {}),
      ...(typeof record.organization === "string"
        ? { organization: record.organization }
        : {}),
      ...(typeof record.project === "string" ? { project: record.project } : {}),
    },
  ];
}

function createModelProvider(config: DaemonModelProviderConfig) {
  const apiKey =
    config.apiKeyEnv && config.apiKeyEnv in process.env
      ? process.env[config.apiKeyEnv]
      : undefined;
  return createAiSdkOpenAiModelProvider({
    id: config.id,
    modelId: config.modelId,
    ...(apiKey ? { apiKey } : {}),
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    ...(config.organization ? { organization: config.organization } : {}),
    ...(config.project ? { project: config.project } : {}),
  });
}

function createStatus(booted: BootedDaemon) {
  return {
    status: "ready",
    configPath: booted.configPath,
    plugins: booted.services.runtime.listPlugins(),
    tools: booted.services.runtime.listTools().map((tool) => tool.qualifiedName),
    modelProviders: booted.services.modelProviders.list().map((provider) => ({
      id: provider.id,
      pluginId: provider.pluginId,
      modelId: provider.modelId,
    })),
    backgroundPollMs: booted.config.backgroundPollMs,
    remoteControl: booted.config.remoteControl,
  };
}

function parseRemoteControlConfig(value: unknown): DaemonRemoteControlConfig {
  if (typeof value !== "object" || value === null) {
    return createDefaultConfig().remoteControl;
  }
  const record = value as Partial<DaemonRemoteControlConfig>;
  const telegram = record.telegram;
  if (typeof telegram !== "object" || telegram === null) {
    return {};
  }
  return {
    telegram: {
      enabled: telegram.enabled === true,
      modelProviderId:
        typeof telegram.modelProviderId === "string"
          ? telegram.modelProviderId
          : "ai-sdk.openai.default",
      pollMs:
        typeof telegram.pollMs === "number" && telegram.pollMs > 0
          ? telegram.pollMs
          : 3_000,
      ...(typeof telegram.systemPrompt === "string"
        ? { systemPrompt: telegram.systemPrompt }
        : {}),
    },
  };
}

function runTelegramRemoteControl(
  booted: BootedDaemon,
  config: NonNullable<DaemonRemoteControlConfig["telegram"]>,
  offset: number | undefined,
): Effect.Effect<number | undefined, unknown> {
  return Effect.fn("daemon.telegramRemoteControl")(function* () {
    const listenResult = yield* booted.services.runtime.executeTool(
      "andy.messaging.telegram.telegram.listen",
      {
        ...(offset ? { offset } : {}),
        timeout: 0,
        limit: 20,
      },
      { channelId: "telegram" },
    );
    const output = listenResult.output;
    if (typeof output !== "object" || output === null || Array.isArray(output)) {
      return offset;
    }

    const outputRecord = output as { messages?: unknown; nextOffset?: unknown };
    const messages = Array.isArray(outputRecord.messages) ? outputRecord.messages : [];
    const runner = yield* booted.services.modelProviders.createRunner(
      config.modelProviderId,
    );
    const kernel = new AgentKernel({
      runtime: booted.services.runtime,
      llm: runner,
      audit: booted.services.audit,
    });

    for (const message of messages) {
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        continue;
      }
      const text = typeof message.text === "string" ? message.text : "";
      const conversationId =
        typeof message.conversationId === "string" ? message.conversationId : "";
      const senderId = typeof message.senderId === "string" ? message.senderId : "";
      if (!text || !conversationId) {
        continue;
      }

      yield* booted.services.communication.publishInbound({
        channelId: "telegram",
        conversationId,
        senderId,
        kind: "user",
        text,
        metadata: message,
      });

      const response = yield* kernel.run({
        sessionId: `telegram:${conversationId}`,
        userMessage: text,
        ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
      });

      yield* booted.services.runtime.executeTool(
        "andy.messaging.telegram.telegram.sendMessage",
        {
          chatId: conversationId,
          text: response.response,
        },
        { channelId: "telegram", sessionId: response.session.id },
      );
    }

    return typeof outputRecord.nextOffset === "number"
      ? outputRecord.nextOffset
      : offset;
  })();
}
