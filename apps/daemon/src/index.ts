#!/usr/bin/env node
import { ConsoleAuditSink } from "@andy/audit";
import {
  AgentKernel,
  CommunicationSendError,
  createAndyDaemon,
  JsonFileCoreStateStore,
} from "@andy/core";
import type { AndyDaemonServices } from "@andy/core";
import { createAiSdkOpenAiModelProvider } from "@andy/model-ai-sdk";
import {
  createInstallPlan,
  JsonFilePluginRegistry,
  type InstalledPluginRecord,
} from "@andy/plugin-manager";
import { parsePluginManifest, type PluginManifest } from "@andy/plugin-sdk";
import {
  createPolicyEngineFromConfig,
  JsonFilePolicyStore,
  type PolicyConfig,
} from "@andy/policy";
import {
  isJsonObject,
  isJsonValue,
  type JsonObject,
  type JsonValue,
} from "@andy/types";
import { Effect } from "effect";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

interface DaemonConfig {
  statePath: string;
  pluginRegistryPath: string;
  pluginInstallRoot: string;
  policyPath: string;
  backgroundPollMs: number;
  allowedCapabilities: string[];
  approvalRequiredCapabilities: string[];
  plugins: DaemonPluginConfig[];
  modelProviders: DaemonModelProviderConfig[];
  remoteControl: DaemonRemoteControlConfig;
  http: DaemonHttpConfig;
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
  whatsapp?: {
    enabled: boolean;
    modelProviderId: string;
    systemPrompt?: string;
  };
}

interface DaemonHttpConfig {
  enabled: boolean;
  host: string;
  port: number;
  webhookSecretEnv?: string;
}

interface BootedDaemon {
  services: AndyDaemonServices;
  config: DaemonConfig;
  configPath: string;
  pluginRegistry: JsonFilePluginRegistry;
  startedPluginIds: string[];
  installedPlugins: InstalledPluginRecord[];
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

const httpServer = booted.config.http.enabled ? startHttpServer(booted) : undefined;

console.log(
  JSON.stringify({
    status: "running",
    configPath: booted.configPath,
    plugins: booted.startedPluginIds,
    backgroundPollMs: booted.config.backgroundPollMs,
    http: booted.config.http.enabled
      ? `${booted.config.http.host}:${booted.config.http.port}`
      : "disabled",
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
  if (httpServer) {
    await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
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
    const pluginRegistry = new JsonFilePluginRegistry(
      resolveFromRoot(config.pluginRegistryPath),
    );
    const policyStore = new JsonFilePolicyStore(resolveFromRoot(config.policyPath));
    const policyConfig = yield* policyStore.load(createDefaultPolicyConfig(config));
    const audit = new ConsoleAuditSink();
    const services = yield* createAndyDaemon({
      audit,
      policy: createPolicyEngineFromConfig(policyConfig),
      stateStore: new JsonFileCoreStateStore(resolveFromRoot(config.statePath)),
    });

    yield* seedPluginRegistryFromConfig(pluginRegistry, config);

    const startedPluginIds: string[] = [];
    for (const provider of config.modelProviders) {
      if (!provider.enabled) {
        continue;
      }

      yield* services.modelProviders.register(createModelProvider(provider));
    }

    const installedPlugins = yield* pluginRegistry.list();
    for (const plugin of installedPlugins) {
      if (plugin.status !== "enabled") {
        continue;
      }

      const manifest = materializeInstalledManifest(plugin);
      yield* services.lifecycle.start(manifest);
      startedPluginIds.push(manifest.id);
    }
    yield* registerMessagingChannels(services, startedPluginIds);

    yield* services.saveState();
    return {
      services,
      config,
      configPath: path,
      pluginRegistry,
      startedPluginIds,
      installedPlugins: [...installedPlugins],
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

function seedPluginRegistryFromConfig(
  registry: JsonFilePluginRegistry,
  config: DaemonConfig,
): Effect.Effect<void, unknown> {
  return Effect.fn("daemon.seedPluginRegistryFromConfig")(function* () {
    for (const plugin of config.plugins) {
      const manifest = yield* loadManifest(plugin.manifestPath);
      const sourceRoot = dirname(resolveFromRoot(plugin.manifestPath));
      const source = {
        type: "local" as const,
        path: sourceRoot,
      };
      const existing = yield* Effect.either(registry.get(manifest.id));
      if (existing._tag === "Left") {
        yield* registry.install(
          createInstallPlan(source, {
            ...manifest,
            entry: relativizeEntry(manifest.entry, sourceRoot),
          }),
        );
      }
      if (plugin.enabled) {
        yield* registry.enable(manifest.id);
      } else if (existing._tag === "Left") {
        yield* registry.disable(manifest.id);
      }
    }
  })();
}

function materializeInstalledManifest(record: InstalledPluginRecord): PluginManifest {
  const sourceRoot =
    record.source.type === "local"
      ? resolveFromRoot(record.source.path)
      : record.source.type === "github" && record.source.checkoutPath
        ? resolveFromRoot(record.source.checkoutPath)
        : repositoryRoot;
  return {
    ...record.manifest,
    entry: isAbsolute(record.manifest.entry)
      ? record.manifest.entry
      : resolve(sourceRoot, record.manifest.entry),
  };
}

function relativizeEntry(entry: string, sourceRoot: string): string {
  if (!isAbsolute(entry)) {
    return entry;
  }
  const relativeEntry = entry.startsWith(`${sourceRoot}/`)
    ? entry.slice(sourceRoot.length + 1)
    : entry;
  return isAbsolute(relativeEntry) ? relativeEntry : `./${relativeEntry}`;
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
    pluginRegistryPath: ".andy/plugins.json",
    pluginInstallRoot: ".andy/github-plugins",
    policyPath: ".andy/policy.json",
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
      whatsapp: {
        enabled: false,
        modelProviderId: "ai-sdk.openai.default",
        systemPrompt: "You are Andy. Respond concisely and use tools only when needed.",
      },
    },
    http: {
      enabled: true,
      host: "127.0.0.1",
      port: 8765,
      webhookSecretEnv: "ANDY_WEBHOOK_SECRET",
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
    pluginRegistryPath:
      typeof record.pluginRegistryPath === "string"
        ? record.pluginRegistryPath
        : ".andy/plugins.json",
    pluginInstallRoot:
      typeof record.pluginInstallRoot === "string"
        ? record.pluginInstallRoot
        : ".andy/github-plugins",
    policyPath:
      typeof record.policyPath === "string" ? record.policyPath : ".andy/policy.json",
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
    http: parseHttpConfig(record.http),
  };
}

function createDefaultPolicyConfig(config: DaemonConfig): PolicyConfig {
  return {
    allowedCapabilities: config.allowedCapabilities,
    approvalRequiredCapabilities: config.approvalRequiredCapabilities,
    approvalRequiredRisks: ["high", "critical"],
    approvalRequiredChannels: [],
    deniedPlugins: [],
    rules: [],
    grants: [],
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
    pluginRegistryPath: booted.config.pluginRegistryPath,
    pluginInstallRoot: booted.config.pluginInstallRoot,
    policyPath: booted.config.policyPath,
    pluginHosts: booted.services.lifecycle.health(),
    installedPlugins: booted.installedPlugins.map((plugin) => ({
      pluginId: plugin.manifest.id,
      status: plugin.status,
      source: plugin.source,
      installedAt: plugin.installedAt,
      updatedAt: plugin.updatedAt,
    })),
    plugins: booted.services.runtime.listPlugins(),
    tools: booted.services.runtime.listTools().map((tool) => tool.qualifiedName),
    modelProviders: booted.services.modelProviders.list().map((provider) => ({
      id: provider.id,
      pluginId: provider.pluginId,
      modelId: provider.modelId,
    })),
    backgroundPollMs: booted.config.backgroundPollMs,
    remoteControl: booted.config.remoteControl,
    http: booted.config.http,
    approvals: booted.services.approvals.list().map((approval) => ({
      id: approval.id,
      toolName: approval.toolName,
      status: approval.status,
      reason: approval.reason,
      createdAt: approval.createdAt,
      resolvedAt: approval.resolvedAt,
    })),
    sessions: booted.services.sessions.list().map((session) => ({
      id: session.id,
      agentId: session.agentId,
      role: session.role,
      messageCount: session.messages.length,
      channelId: session.channelId,
      conversationId: session.conversationId,
      updatedAt: session.updatedAt,
    })),
    eventCount: booted.services.eventBus.replay().length,
    traceCount: booted.services.traces.list().length,
  };
}

function parseRemoteControlConfig(value: unknown): DaemonRemoteControlConfig {
  if (typeof value !== "object" || value === null) {
    return createDefaultConfig().remoteControl;
  }
  const record = value as Partial<DaemonRemoteControlConfig>;
  const telegram = record.telegram;
  const whatsapp = record.whatsapp;
  const config: DaemonRemoteControlConfig = {};
  if (typeof telegram === "object" && telegram !== null) {
    config.telegram = {
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
    };
  }
  if (typeof whatsapp === "object" && whatsapp !== null) {
    config.whatsapp = {
      enabled: whatsapp.enabled === true,
      modelProviderId:
        typeof whatsapp.modelProviderId === "string"
          ? whatsapp.modelProviderId
          : "ai-sdk.openai.default",
      ...(typeof whatsapp.systemPrompt === "string"
        ? { systemPrompt: whatsapp.systemPrompt }
        : {}),
    };
  }
  return config;
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
      sessionStore: booted.services.sessions,
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
        channelId: "telegram",
        conversationId,
        userId: senderId,
        ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
      });

      yield* booted.services.communication.send({
        channelId: "telegram",
        conversationId,
        kind: "agent",
        text: response.response,
        metadata: { sessionId: response.session.id },
      });
    }

    return typeof outputRecord.nextOffset === "number"
      ? outputRecord.nextOffset
      : offset;
  })();
}

function parseHttpConfig(value: unknown): DaemonHttpConfig {
  if (typeof value !== "object" || value === null) {
    return createDefaultConfig().http;
  }
  const record = value as Partial<DaemonHttpConfig>;
  return {
    enabled: record.enabled !== false,
    host: typeof record.host === "string" ? record.host : "127.0.0.1",
    port:
      typeof record.port === "number" && Number.isInteger(record.port)
        ? record.port
        : 8765,
    ...(typeof record.webhookSecretEnv === "string"
      ? { webhookSecretEnv: record.webhookSecretEnv }
      : {}),
  };
}

function registerMessagingChannels(
  services: AndyDaemonServices,
  pluginIds: readonly string[],
): Effect.Effect<void, unknown> {
  return Effect.fn("daemon.registerMessagingChannels")(function* () {
    if (pluginIds.includes("andy.messaging.telegram")) {
      yield* services.communication.registerChannel({
        id: "telegram",
        pluginId: "andy.messaging.telegram",
        send(input) {
          return services.runtime
            .executeTool(
              "andy.messaging.telegram.telegram.sendMessage",
              {
                chatId: input.conversationId,
                text: input.text,
              },
              {
                channelId: "telegram",
                conversationId: input.conversationId,
              },
            )
            .pipe(
              Effect.map((result) => result.output),
              Effect.mapError(
                (error) =>
                  new CommunicationSendError({
                    channelId: "telegram",
                    message: "Telegram send failed.",
                    cause: String(error),
                  }),
              ),
            );
        },
      });
    }

    if (pluginIds.includes("andy.messaging.whatsapp")) {
      yield* services.communication.registerChannel({
        id: "whatsapp",
        pluginId: "andy.messaging.whatsapp",
        send(input) {
          return services.runtime
            .executeTool(
              "andy.messaging.whatsapp.whatsapp.sendMessage",
              {
                to: input.conversationId,
                text: input.text,
              },
              {
                channelId: "whatsapp",
                conversationId: input.conversationId,
              },
            )
            .pipe(
              Effect.map((result) => result.output),
              Effect.mapError(
                (error) =>
                  new CommunicationSendError({
                    channelId: "whatsapp",
                    message: "WhatsApp send failed.",
                    cause: String(error),
                  }),
              ),
            );
        },
      });
    }
  })();
}

function startHttpServer(booted: BootedDaemon) {
  const server = createServer((request, response) => {
    Effect.runPromise(handleHttpRequest(booted, request, response).pipe(Effect.ignore));
  });
  server.listen(booted.config.http.port, booted.config.http.host, () => {
    console.log(
      JSON.stringify({
        status: "http_listening",
        host: booted.config.http.host,
        port: booted.config.http.port,
      }),
    );
  });
  return server;
}

function handleHttpRequest(
  booted: BootedDaemon,
  request: IncomingMessage,
  response: ServerResponse,
): Effect.Effect<void, unknown> {
  return Effect.fn("daemon.handleHttpRequest")(function* () {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/status") {
      writeJson(response, 200, createStatus(booted));
      return;
    }
    if (request.method === "GET" && url.pathname === "/approvals") {
      writeJson(response, 200, { approvals: booted.services.approvals.list() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/plugins") {
      const plugins = yield* booted.pluginRegistry.list();
      writeJson(response, 200, {
        plugins: plugins.map(serializeInstalledPlugin),
        hosts: booted.services.lifecycle.health(),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/plugins/install-local") {
      const body = yield* readJsonBody(request);
      const result = yield* installLocalPlugin(booted, body);
      writeJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/plugins/install-github") {
      const body = yield* readJsonBody(request);
      const result = yield* installGitHubPlugin(booted, body);
      writeJson(response, 200, result);
      return;
    }

    const pluginActionMatch = url.pathname.match(
      /^\/plugins\/([^/]+)\/(enable|disable|remove)$/,
    );
    if (request.method === "POST" && pluginActionMatch) {
      const [, pluginId, action] = pluginActionMatch;
      if (!pluginId || !action) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      const result = yield* mutatePluginLifecycle(booted, pluginId, action);
      writeJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/plugins/restart-crashed") {
      const result = yield* booted.services.lifecycle.restartCrashed();
      yield* refreshInstalledPlugins(booted);
      yield* booted.services.saveState();
      writeJson(response, 200, { plugins: result });
      return;
    }

    const approvalMatch = url.pathname.match(/^\/approvals\/([^/]+)\/(approve|deny)$/);
    if (request.method === "POST" && approvalMatch) {
      const [, approvalId, decision] = approvalMatch;
      if (!approvalId || !decision) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      const result =
        decision === "approve"
          ? yield* booted.services.approvalResume.resumeApproved(approvalId)
          : yield* booted.services.approvalResume.deny(approvalId);
      yield* booted.services.saveState();
      writeJson(response, 200, { approvalId, decision, result });
      return;
    }

    if (request.method === "POST" && url.pathname === "/webhooks/telegram") {
      if (!verifyWebhookSecret(booted, request)) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      const body = yield* readJsonBody(request);
      const normalized = yield* booted.services.runtime.executeTool(
        "andy.messaging.telegram.telegram.normalizeUpdate",
        body,
        { channelId: "telegram" },
      );
      yield* handleNormalizedMessage({
        booted,
        channelId: "telegram",
        message: normalized.output,
        remoteConfig: booted.config.remoteControl.telegram,
      });
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/webhooks/whatsapp") {
      if (!verifyWebhookSecret(booted, request)) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      const body = yield* readJsonBody(request);
      const normalized = yield* booted.services.runtime.executeTool(
        "andy.messaging.whatsapp.whatsapp.normalizeWebhook",
        { payload: body },
        { channelId: "whatsapp" },
      );
      const output = normalized.output;
      const messages =
        typeof output === "object" &&
        output !== null &&
        !Array.isArray(output) &&
        Array.isArray((output as { messages?: unknown }).messages)
          ? (output as { messages: unknown[] }).messages
          : [];
      for (const message of messages) {
        yield* handleNormalizedMessage({
          booted,
          channelId: "whatsapp",
          message,
          remoteConfig: booted.config.remoteControl.whatsapp,
        });
      }
      writeJson(response, 200, { ok: true, messages: messages.length });
      return;
    }

    writeJson(response, 404, { error: "not_found" });
  })().pipe(
    Effect.catchAll((cause) =>
      Effect.sync(() => writeJson(response, 500, { error: String(cause) })),
    ),
  );
}

function installLocalPlugin(
  booted: BootedDaemon,
  body: JsonValue,
): Effect.Effect<
  {
    plugin: ReturnType<typeof serializeInstalledPlugin>;
    plan: ReturnType<typeof serializeInstallPlan>;
  },
  unknown
> {
  return Effect.fn("daemon.installLocalPlugin")(function* () {
    const payload = isJsonObject(body)
      ? (body as { manifestPath?: unknown; enabled?: unknown })
      : {};
    const manifestPath =
      typeof payload.manifestPath === "string" ? payload.manifestPath : "";
    if (!manifestPath) {
      throw new Error("manifestPath is required.");
    }
    const enableAfterInstall = payload.enabled === true;
    const manifest = yield* loadManifest(manifestPath);
    const sourceRoot = dirname(resolveFromRoot(manifestPath));
    const existing = yield* Effect.either(booted.pluginRegistry.get(manifest.id));
    const plan = createInstallPlan(
      { type: "local", path: sourceRoot },
      {
        ...manifest,
        entry: relativizeEntry(manifest.entry, sourceRoot),
      },
      existing._tag === "Right" ? existing.right : undefined,
    );
    const installed =
      existing._tag === "Right"
        ? yield* booted.pluginRegistry.upgrade(plan, "approved")
        : yield* booted.pluginRegistry.install(plan);
    if (enableAfterInstall) {
      yield* mutatePluginLifecycle(booted, manifest.id, "enable");
    } else {
      yield* refreshInstalledPlugins(booted);
    }
    return {
      plugin: serializeInstalledPlugin(
        enableAfterInstall ? yield* booted.pluginRegistry.get(manifest.id) : installed,
      ),
      plan: serializeInstallPlan(plan),
    };
  })();
}

function installGitHubPlugin(
  booted: BootedDaemon,
  body: JsonValue,
): Effect.Effect<
  {
    plugin: ReturnType<typeof serializeInstalledPlugin>;
    plan: ReturnType<typeof serializeInstallPlan>;
    checkoutPath: string;
  },
  unknown
> {
  return Effect.fn("daemon.installGitHubPlugin")(function* () {
    const payload = isJsonObject(body)
      ? (body as {
          repository?: unknown;
          ref?: unknown;
          manifestPath?: unknown;
          enabled?: unknown;
        })
      : {};
    const repository = typeof payload.repository === "string" ? payload.repository : "";
    const ref = typeof payload.ref === "string" ? payload.ref : "";
    const manifestPath =
      typeof payload.manifestPath === "string" ? payload.manifestPath : "plugin.json";
    const enableAfterInstall = payload.enabled === true;
    if (!repository) {
      throw new Error("repository is required.");
    }
    if (!ref) {
      throw new Error("ref is required.");
    }
    if (!isImmutableGitRef(ref)) {
      throw new Error(
        "GitHub plugin installs require an immutable commit SHA or semver release tag.",
      );
    }

    const checkoutPath = resolveFromRoot(
      `${booted.config.pluginInstallRoot}/${safePathSegment(repository)}/${safePathSegment(ref)}`,
    );
    yield* materializeGitCheckout({ repository, ref, checkoutPath });
    const manifest = yield* loadManifest(resolve(checkoutPath, manifestPath));
    const existing = yield* Effect.either(booted.pluginRegistry.get(manifest.id));
    const source = {
      type: "github" as const,
      repository,
      ref,
      checkoutPath,
    };
    const plan = createInstallPlan(
      source,
      {
        ...manifest,
        entry: relativizeEntry(manifest.entry, checkoutPath),
      },
      existing._tag === "Right" ? existing.right : undefined,
    );
    const installed =
      existing._tag === "Right"
        ? yield* booted.pluginRegistry.upgrade(plan, "approved")
        : yield* booted.pluginRegistry.install(plan);
    if (enableAfterInstall) {
      yield* mutatePluginLifecycle(booted, manifest.id, "enable");
    } else {
      yield* refreshInstalledPlugins(booted);
      yield* booted.services.saveState();
    }

    return {
      plugin: serializeInstalledPlugin(
        enableAfterInstall ? yield* booted.pluginRegistry.get(manifest.id) : installed,
      ),
      plan: serializeInstallPlan(plan),
      checkoutPath,
    };
  })();
}

function materializeGitCheckout(options: {
  repository: string;
  ref: string;
  checkoutPath: string;
}): Effect.Effect<void, unknown> {
  return Effect.fn("daemon.materializeGitCheckout")(function* () {
    yield* Effect.tryPromise({
      try: async () => {
        await rm(options.checkoutPath, { recursive: true, force: true });
        await mkdir(dirname(options.checkoutPath), { recursive: true });
        await execFilePromise("git", [
          "clone",
          "--filter=blob:none",
          "--no-checkout",
          options.repository,
          options.checkoutPath,
        ]);
        await execFilePromise("git", [
          "-C",
          options.checkoutPath,
          "checkout",
          options.ref,
        ]);
      },
      catch: (cause) => cause,
    });
  })();
}

function mutatePluginLifecycle(
  booted: BootedDaemon,
  pluginId: string,
  action: string,
): Effect.Effect<{ plugin: ReturnType<typeof serializeInstalledPlugin> }, unknown> {
  return Effect.fn("daemon.mutatePluginLifecycle")(function* () {
    if (action === "enable") {
      const record = yield* booted.pluginRegistry.enable(pluginId);
      const manifest = materializeInstalledManifest(record);
      yield* booted.services.lifecycle.start(manifest);
      if (!booted.startedPluginIds.includes(pluginId)) {
        booted.startedPluginIds.push(pluginId);
      }
      yield* registerMessagingChannels(booted.services, booted.startedPluginIds);
    } else if (action === "disable") {
      const record = yield* booted.pluginRegistry.disable(pluginId);
      yield* booted.services.lifecycle.stop(pluginId).pipe(Effect.ignore);
      booted.startedPluginIds = booted.startedPluginIds.filter((id) => id !== pluginId);
      yield* refreshInstalledPlugins(booted);
      yield* booted.services.saveState();
      return { plugin: serializeInstalledPlugin(record) };
    } else if (action === "remove") {
      const record = yield* booted.pluginRegistry.remove(pluginId);
      yield* booted.services.lifecycle.stop(pluginId).pipe(Effect.ignore);
      yield* booted.services.runtime.removePlugin(pluginId).pipe(Effect.ignore);
      booted.startedPluginIds = booted.startedPluginIds.filter((id) => id !== pluginId);
      yield* refreshInstalledPlugins(booted);
      yield* booted.services.saveState();
      return { plugin: serializeInstalledPlugin(record) };
    } else {
      throw new Error(`Unsupported plugin action '${action}'.`);
    }

    yield* refreshInstalledPlugins(booted);
    yield* booted.services.saveState();
    const plugin = yield* booted.pluginRegistry.get(pluginId);
    return { plugin: serializeInstalledPlugin(plugin) };
  })();
}

function refreshInstalledPlugins(booted: BootedDaemon): Effect.Effect<void, unknown> {
  return booted.pluginRegistry.list().pipe(
    Effect.flatMap((plugins) =>
      Effect.sync(() => {
        booted.installedPlugins = [...plugins];
      }),
    ),
  );
}

function serializeInstalledPlugin(plugin: InstalledPluginRecord) {
  return {
    pluginId: plugin.manifest.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    status: plugin.status,
    risk: plugin.manifest.risk,
    source: plugin.source,
    capabilities: plugin.manifest.capabilities,
    toolNames: (plugin.manifest.tools ?? []).map((tool) => tool.name),
    installedAt: plugin.installedAt,
    updatedAt: plugin.updatedAt,
  };
}

function serializeInstallPlan(plan: ReturnType<typeof createInstallPlan>) {
  return {
    pluginId: plan.manifest.id,
    source: plan.source,
    risk: plan.risk,
    requiresApproval: plan.requiresApproval,
    capabilityChanges: plan.capabilityChanges,
    permissionChanges: plan.permissionChanges,
  };
}

function isImmutableGitRef(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref) || /^v?\d+\.\d+\.\d+([-.+].*)?$/.test(ref);
}

function safePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized.slice(0, 120) : "plugin";
}

function execFilePromise(
  command: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveExec, rejectExec) => {
    execFile(command, [...args], { timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        rejectExec(
          new Error(
            `${command} ${args.join(" ")} failed: ${String(stderr || error.message)}`,
          ),
        );
        return;
      }
      resolveExec({ stdout, stderr });
    });
  });
}

function handleNormalizedMessage(options: {
  booted: BootedDaemon;
  channelId: "telegram" | "whatsapp";
  message: unknown;
  remoteConfig:
    | NonNullable<DaemonRemoteControlConfig["telegram"]>
    | NonNullable<DaemonRemoteControlConfig["whatsapp"]>
    | undefined;
}): Effect.Effect<void, unknown> {
  return Effect.fn("daemon.handleNormalizedMessage")(function* () {
    if (
      typeof options.message !== "object" ||
      options.message === null ||
      Array.isArray(options.message)
    ) {
      return;
    }
    const message = options.message as {
      conversationId?: unknown;
      senderId?: unknown;
      text?: unknown;
    };
    const conversationId =
      typeof message.conversationId === "string" ? message.conversationId : "";
    const senderId = typeof message.senderId === "string" ? message.senderId : "";
    const text = typeof message.text === "string" ? message.text : "";
    if (!conversationId || !text) {
      return;
    }

    yield* options.booted.services.communication.publishInbound({
      channelId: options.channelId,
      conversationId,
      senderId,
      kind: "user",
      text,
      metadata: toMetadata(options.message),
    });

    if (
      yield* handleApprovalCommand(
        options.booted,
        options.channelId,
        conversationId,
        text,
      )
    ) {
      return;
    }

    if (!options.remoteConfig?.enabled) {
      return;
    }

    const runner = yield* options.booted.services.modelProviders.createRunner(
      options.remoteConfig.modelProviderId,
    );
    const kernel = new AgentKernel({
      runtime: options.booted.services.runtime,
      llm: runner,
      audit: options.booted.services.audit,
      sessionStore: options.booted.services.sessions,
    });
    const responseResult = yield* Effect.either(
      kernel.run({
        sessionId: `${options.channelId}:${conversationId}`,
        userMessage: text,
        channelId: options.channelId,
        conversationId,
        userId: senderId,
        ...(options.remoteConfig.systemPrompt
          ? { systemPrompt: options.remoteConfig.systemPrompt }
          : {}),
      }),
    );
    if (responseResult._tag === "Left") {
      if (String(responseResult.left).includes("ToolApprovalRequiredError")) {
        yield* options.booted.services.saveState();
        return;
      }
      return yield* Effect.fail(responseResult.left);
    }
    const response = responseResult.right;
    yield* options.booted.services.communication.send({
      channelId: options.channelId,
      conversationId,
      kind: "agent",
      text: response.response,
      metadata: { sessionId: response.session.id },
    });
    yield* options.booted.services.saveState();
  })();
}

function handleApprovalCommand(
  booted: BootedDaemon,
  channelId: string,
  conversationId: string,
  text: string,
): Effect.Effect<boolean, unknown> {
  return Effect.fn("daemon.handleApprovalCommand")(function* () {
    const match = text.trim().match(/^\/(approve|deny)\s+([a-f0-9-]+)$/i);
    if (!match) {
      return false;
    }
    const [, decision, approvalId] = match;
    if (!approvalId || !decision) {
      return false;
    }
    if (decision.toLowerCase() === "approve") {
      const result = yield* booted.services.approvalResume.resumeApproved(approvalId);
      yield* booted.services.communication.send({
        channelId,
        conversationId,
        kind: "system",
        text: `Approved ${approvalId}. Result: ${JSON.stringify(result.output)}`,
      });
    } else {
      yield* booted.services.approvalResume.deny(approvalId);
      yield* booted.services.communication.send({
        channelId,
        conversationId,
        kind: "system",
        text: `Denied ${approvalId}.`,
      });
    }
    yield* booted.services.saveState();
    return true;
  })();
}

function toMetadata(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function verifyWebhookSecret(booted: BootedDaemon, request: IncomingMessage): boolean {
  const secretEnvName = booted.config.http.webhookSecretEnv;
  if (!secretEnvName) {
    return true;
  }
  const expected = process.env[secretEnvName];
  if (!expected) {
    return true;
  }
  return request.headers["x-andy-webhook-secret"] === expected;
}

function readJsonBody(request: IncomingMessage): Effect.Effect<JsonValue, unknown> {
  return Effect.tryPromise({
    try: () =>
      new Promise<JsonValue>((resolveBody, reject) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
          if (body.length > 1024 * 1024) {
            reject(new Error("Request body too large."));
            request.destroy();
          }
        });
        request.on("end", () => {
          try {
            const parsed: unknown = body.length > 0 ? JSON.parse(body) : {};
            if (!isJsonValue(parsed)) {
              reject(new Error("Request body must be JSON-compatible."));
              return;
            }
            resolveBody(parsed);
          } catch (error) {
            reject(error);
          }
        });
        request.on("error", reject);
      }),
    catch: (cause) => cause,
  });
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}
