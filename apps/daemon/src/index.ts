#!/usr/bin/env node
import { ConsoleAuditSink } from "@andy/audit";
import {
  AgentKernel,
  CommunicationSendError,
  createAndyDaemon,
  JsonFileCoreStateStore,
} from "@andy/core";
import type { AndyDaemonServices } from "@andy/core";
import {
  createAiSdkAnthropicModelProvider,
  createAiSdkGoogleModelProvider,
  createAiSdkOpenAiModelProvider,
} from "@andy/model-ai-sdk";
import {
  createInstallPlan,
  JsonFilePluginRegistry,
  type InstalledPluginRecord,
} from "@andy/plugin-manager";
import { parsePluginManifest, type PluginManifest } from "@andy/plugin-sdk";
import {
  createSkillInstallPlan,
  JsonFileSkillRegistry,
  type InstalledSkillRecord,
  type SkillInstallPlan,
} from "@andy/skill-manager";
import { parseSkillManifest, type SkillManifest } from "@andy/skill-sdk";
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
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

interface DaemonConfig {
  statePath: string;
  pluginRegistryPath: string;
  skillRegistryPath: string;
  pluginInstallRoot: string;
  policyPath: string;
  backgroundPollMs: number;
  allowedCapabilities: string[];
  approvalRequiredCapabilities: string[];
  plugins: DaemonPluginConfig[];
  skills: DaemonSkillConfig[];
  modelProviders: DaemonModelProviderConfig[];
  remoteControl: DaemonRemoteControlConfig;
  http: DaemonHttpConfig;
}

interface DaemonPluginConfig {
  manifestPath: string;
  enabled: boolean;
}

interface DaemonSkillConfig {
  manifestPath: string;
  enabled: boolean;
}

interface DaemonModelProviderConfig {
  id: string;
  provider: "ai-sdk.openai" | "ai-sdk.anthropic" | "ai-sdk.google";
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
  skillRegistry: JsonFileSkillRegistry;
  startedPluginIds: string[];
  installedPlugins: InstalledPluginRecord[];
  installedSkills: InstalledSkillRecord[];
}

const args = new Set(process.argv.slice(2));
const { ANDY_CONFIG, ANDY_HOME } = process.env;
const repositoryRoot = resolve(
  findReleaseRoot(dirname(process.execPath)) ??
    findWorkspaceRoot(process.cwd()) ??
    process.cwd(),
);
const dataRoot = resolve(ANDY_HOME ?? repositoryRoot);
const configPath = resolveDataPath(ANDY_CONFIG ?? ".andy/daemon.json");

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
      resolveDataPath(config.pluginRegistryPath),
    );
    const skillRegistry = new JsonFileSkillRegistry(
      resolveDataPath(config.skillRegistryPath),
    );
    const policyStore = new JsonFilePolicyStore(resolveDataPath(config.policyPath));
    const policyConfig = yield* policyStore.load(createDefaultPolicyConfig(config));
    const audit = new ConsoleAuditSink();
    const services = yield* createAndyDaemon({
      audit,
      policy: createPolicyEngineFromConfig(policyConfig),
      stateStore: new JsonFileCoreStateStore(resolveDataPath(config.statePath)),
    });

    yield* seedPluginRegistryFromConfig(pluginRegistry, skillRegistry, config);
    yield* seedSkillRegistryFromConfig(skillRegistry, config);

    const startedPluginIds: string[] = [];
    for (const provider of config.modelProviders) {
      if (!provider.enabled) {
        continue;
      }

      yield* services.modelProviders.register(createModelProvider(provider));
    }

    const installedPlugins = yield* pluginRegistry.list();
    const installedSkills = yield* skillRegistry.list();
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
      skillRegistry,
      startedPluginIds,
      installedPlugins: [...installedPlugins],
      installedSkills: [...installedSkills],
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
    const manifestPath = resolveAssetPath(path);
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
      ...(parsed.binaryEntrypoint
        ? {
            binaryEntrypoint: isAbsolute(parsed.binaryEntrypoint)
              ? parsed.binaryEntrypoint
              : resolve(dirname(manifestPath), parsed.binaryEntrypoint),
          }
        : {}),
    };
  })();
}

function loadSkillManifest(path: string): Effect.Effect<SkillManifest, unknown> {
  return Effect.fn("daemon.loadSkillManifest")(function* () {
    const manifestPath = resolveAssetPath(path);
    const text = yield* Effect.tryPromise({
      try: () => readFile(manifestPath, "utf8"),
      catch: (cause) => cause,
    });
    return parseSkillManifest(JSON.parse(text));
  })();
}

function seedPluginRegistryFromConfig(
  registry: JsonFilePluginRegistry,
  skillRegistry: JsonFileSkillRegistry,
  config: DaemonConfig,
): Effect.Effect<void, unknown> {
  return Effect.fn("daemon.seedPluginRegistryFromConfig")(function* () {
    for (const plugin of config.plugins) {
      const manifest = yield* loadManifest(plugin.manifestPath);
      const sourceRoot = dirname(resolveAssetPath(plugin.manifestPath));
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
            ...(manifest.binaryEntrypoint
              ? {
                  binaryEntrypoint: relativizeEntry(
                    manifest.binaryEntrypoint,
                    sourceRoot,
                  ),
                }
              : {}),
          }),
        );
      } else {
        const nextManifest = {
          ...manifest,
          entry: relativizeEntry(manifest.entry, sourceRoot),
          ...(manifest.binaryEntrypoint
            ? {
                binaryEntrypoint: relativizeEntry(
                  manifest.binaryEntrypoint,
                  sourceRoot,
                ),
              }
            : {}),
        };
        if (JSON.stringify(existing.right.manifest) !== JSON.stringify(nextManifest)) {
          yield* registry.upgrade(
            createInstallPlan(source, nextManifest, existing.right),
            "approved",
          );
        }
      }
      if (plugin.enabled) {
        yield* registry.enable(manifest.id);
      } else if (existing._tag === "Left") {
        yield* registry.disable(manifest.id);
      }
      yield* installBundledSkills(skillRegistry, manifest, sourceRoot);
    }
  })();
}

function seedSkillRegistryFromConfig(
  registry: JsonFileSkillRegistry,
  config: DaemonConfig,
): Effect.Effect<void, unknown> {
  return Effect.fn("daemon.seedSkillRegistryFromConfig")(function* () {
    for (const skill of config.skills) {
      const manifest = yield* loadSkillManifest(skill.manifestPath);
      const sourceRoot = dirname(resolveAssetPath(skill.manifestPath));
      const source = {
        type: "local" as const,
        path: sourceRoot,
      };
      const existing = yield* Effect.either(registry.get(manifest.id));
      const plan = createSkillInstallPlan(
        source,
        manifest,
        existing._tag === "Right" ? existing.right : undefined,
      );
      if (existing._tag === "Left") {
        yield* registry.install(plan);
      } else if (JSON.stringify(existing.right.manifest) !== JSON.stringify(manifest)) {
        yield* registry.upgrade(plan, "approved");
      }
      if (skill.enabled) {
        yield* registry.enable(manifest.id);
      } else if (existing._tag === "Left") {
        yield* registry.disable(manifest.id);
      }
    }
  })();
}

function installBundledSkills(
  registry: JsonFileSkillRegistry,
  plugin: PluginManifest,
  pluginRoot: string,
): Effect.Effect<void, unknown> {
  return Effect.fn("daemon.installBundledSkills")(function* () {
    const manifests = yield* discoverBundledSkillManifestPaths(plugin, pluginRoot);
    for (const manifestPath of manifests) {
      const manifest = yield* loadSkillManifest(manifestPath);
      const source = {
        type: "plugin" as const,
        pluginId: plugin.id,
        path: dirname(resolveAssetPath(manifestPath)),
      };
      const existing = yield* Effect.either(registry.get(manifest.id));
      const plan = createSkillInstallPlan(
        source,
        manifest,
        existing._tag === "Right" ? existing.right : undefined,
      );
      if (existing._tag === "Right") {
        yield* registry.upgrade(plan, "approved");
      } else {
        yield* registry.install(plan);
        yield* registry.disable(manifest.id);
      }
    }
  })();
}

function discoverBundledSkillManifestPaths(
  plugin: PluginManifest,
  pluginRoot: string,
): Effect.Effect<string[], unknown> {
  return Effect.tryPromise(async () => {
    const explicit = plugin.bundledSkills ?? [];
    if (explicit.length > 0) {
      return explicit.map((path) =>
        isAbsolute(path) ? path : resolve(pluginRoot, path),
      );
    }
    const skillsRoot = resolve(pluginRoot, "skills");
    try {
      const entries = await readdir(skillsRoot, { withFileTypes: true });
      return entries
        .flatMap((entry) =>
          entry.isDirectory() ? [resolve(skillsRoot, entry.name, "skill.json")] : [],
        )
        .filter((path) => existsSync(path));
    } catch (cause) {
      if (isFileNotFound(cause)) {
        return [];
      }
      throw cause;
    }
  });
}

function materializeInstalledManifest(record: InstalledPluginRecord): PluginManifest {
  const sourceRoot =
    record.source.type === "local"
      ? resolveAssetPath(record.source.path)
      : record.source.type === "github" && record.source.checkoutPath
        ? resolveDataPath(record.source.checkoutPath)
        : repositoryRoot;
  return {
    ...record.manifest,
    entry: isAbsolute(record.manifest.entry)
      ? record.manifest.entry
      : resolve(sourceRoot, record.manifest.entry),
    ...(record.manifest.binaryEntrypoint
      ? {
          binaryEntrypoint: isAbsolute(record.manifest.binaryEntrypoint)
            ? record.manifest.binaryEntrypoint
            : resolve(sourceRoot, record.manifest.binaryEntrypoint),
        }
      : {}),
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

function resolveAssetPath(path: string): string {
  return isAbsolute(path) ? path : resolve(repositoryRoot, path);
}

function resolveDataPath(path: string): string {
  return isAbsolute(path) ? path : resolve(dataRoot, path);
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

function findReleaseRoot(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    if (existsSync(resolve(current, "release.json"))) {
      return current;
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
    skillRegistryPath: ".andy/skills.json",
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
      "filesystem.read_sensitive",
      "filesystem.write",
      "filesystem.delete",
      "filesystem.read_sensitive",
      "shell.execute",
      "messaging.receive",
      "messaging.send",
      "messaging.manage_webhook",
      "messaging.read_contact",
      "messaging.map_identity",
      "voice.listen",
      "voice.record",
      "voice.transcribe",
      "voice.speak",
      "voice.stop",
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
      "background.run",
      "background.schedule",
      "background.cancel",
      "notification.send",
      "notification.approval_request",
      "swarm.plan",
      "swarm.spawn",
      "swarm.delegate",
      "swarm.join",
      "swarm.cancel",
      "memory.embed",
      "memory.semantic_query",
      "project.read",
      "project.write",
      "project.search",
      "project.diff",
      "project.run_check",
    ],
    approvalRequiredCapabilities: [
      "filesystem.write",
      "filesystem.delete",
      "shell.execute",
      "messaging.manage_webhook",
      "voice.record",
      "microphone.read",
      "screen.capture",
      "computer.mouse",
      "computer.keyboard",
      "computer.window",
      "computer.app",
      "computer.accessibility_tree",
      "background.run",
      "background.schedule",
      "notification.approval_request",
      "swarm.spawn",
      "swarm.delegate",
      "memory.save",
      "memory.save_fact",
      "memory.forget",
      "project.write",
      "project.run_check",
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
      { manifestPath: "plugins/background-worker/plugin.json", enabled: false },
      { manifestPath: "plugins/notifications/plugin.json", enabled: false },
      { manifestPath: "plugins/swarm-orchestrator/plugin.json", enabled: false },
      { manifestPath: "plugins/memory-persistent/plugin.json", enabled: false },
      { manifestPath: "plugins/memory-semantic/plugin.json", enabled: false },
      { manifestPath: "plugins/project/plugin.json", enabled: false },
    ],
    skills: [
      { manifestPath: "skills/remember/skill.json", enabled: true },
      { manifestPath: "skills/shell-note/skill.json", enabled: false },
    ],
    modelProviders: [
      {
        id: "ai-sdk.openai.default",
        provider: "ai-sdk.openai",
        enabled: false,
        modelId: "gpt-4.1-mini",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      {
        id: "ai-sdk.anthropic.default",
        provider: "ai-sdk.anthropic",
        enabled: false,
        modelId: "claude-3-5-sonnet-latest",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
      {
        id: "ai-sdk.google.default",
        provider: "ai-sdk.google",
        enabled: false,
        modelId: "gemini-2.0-flash",
        apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
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
  const defaults = createDefaultConfig();
  return {
    statePath:
      typeof record.statePath === "string" ? record.statePath : ".andy/state.json",
    pluginRegistryPath:
      typeof record.pluginRegistryPath === "string"
        ? record.pluginRegistryPath
        : ".andy/plugins.json",
    skillRegistryPath:
      typeof record.skillRegistryPath === "string"
        ? record.skillRegistryPath
        : ".andy/skills.json",
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
    allowedCapabilities: mergeStringDefaults(
      record.allowedCapabilities,
      defaults.allowedCapabilities,
    ),
    approvalRequiredCapabilities: mergeStringDefaults(
      record.approvalRequiredCapabilities,
      defaults.approvalRequiredCapabilities,
    ),
    plugins: mergePluginDefaults(record.plugins, defaults.plugins),
    skills: mergeSkillDefaults(record.skills, defaults.skills),
    modelProviders: mergeModelProviderDefaults(
      record.modelProviders,
      defaults.modelProviders,
    ),
    remoteControl: parseRemoteControlConfig(record.remoteControl),
    http: parseHttpConfig(record.http),
  };
}

function mergeStringDefaults(value: unknown, defaults: readonly string[]): string[] {
  const configured = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  return [...new Set([...configured, ...defaults])];
}

function mergePluginDefaults(
  value: unknown,
  defaults: readonly DaemonPluginConfig[],
): DaemonPluginConfig[] {
  const configured = Array.isArray(value) ? value.flatMap(parsePluginConfig) : [];
  const byPath = new Map<string, DaemonPluginConfig>();
  for (const plugin of defaults) {
    byPath.set(plugin.manifestPath, plugin);
  }
  for (const plugin of configured) {
    byPath.set(plugin.manifestPath, plugin);
  }
  return [...byPath.values()];
}

function mergeSkillDefaults(
  value: unknown,
  defaults: readonly DaemonSkillConfig[],
): DaemonSkillConfig[] {
  const configured = Array.isArray(value) ? value.flatMap(parseSkillConfig) : [];
  const byPath = new Map<string, DaemonSkillConfig>();
  for (const skill of defaults) {
    byPath.set(skill.manifestPath, skill);
  }
  for (const skill of configured) {
    byPath.set(skill.manifestPath, skill);
  }
  return [...byPath.values()];
}

function mergeModelProviderDefaults(
  value: unknown,
  defaults: readonly DaemonModelProviderConfig[],
): DaemonModelProviderConfig[] {
  const configured = Array.isArray(value)
    ? value.flatMap(parseModelProviderConfig)
    : [];
  const byId = new Map<string, DaemonModelProviderConfig>();
  for (const provider of defaults) {
    byId.set(provider.id, provider);
  }
  for (const provider of configured) {
    byId.set(provider.id, provider);
  }
  return [...byId.values()];
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

function parseSkillConfig(value: unknown): DaemonSkillConfig[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Partial<DaemonSkillConfig>;
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
  if (
    (record.provider !== "ai-sdk.openai" &&
      record.provider !== "ai-sdk.anthropic" &&
      record.provider !== "ai-sdk.google") ||
    typeof record.id !== "string"
  ) {
    return [];
  }
  return [
    {
      id: record.id,
      provider: record.provider,
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
  const common = {
    id: config.id,
    modelId: config.modelId,
    ...(apiKey ? { apiKey } : {}),
  };
  if (config.provider === "ai-sdk.anthropic") {
    return createAiSdkAnthropicModelProvider({
      ...common,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
  }
  if (config.provider === "ai-sdk.google") {
    return createAiSdkGoogleModelProvider(common);
  }
  return createAiSdkOpenAiModelProvider({
    ...common,
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
    skillRegistryPath: booted.config.skillRegistryPath,
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
    skills: booted.installedSkills.map(serializeInstalledSkill),
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

function sanitizeConfig(config: DaemonConfig) {
  return {
    ...config,
    modelProviders: config.modelProviders.map((provider) => ({
      ...provider,
      apiKeyConfigured:
        provider.apiKeyEnv && provider.apiKeyEnv in process.env
          ? Boolean(process.env[provider.apiKeyEnv])
          : false,
    })),
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
    if (request.method === "OPTIONS") {
      writeJson(response, 204, {});
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/status") {
      writeJson(response, 200, createStatus(booted));
      return;
    }
    if (request.method === "GET" && url.pathname === "/config") {
      writeJson(response, 200, { config: sanitizeConfig(booted.config) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/config/model-provider") {
      const body = yield* readJsonBody(request);
      const result = yield* upsertModelProviderConfig(booted, body);
      writeJson(response, 200, result);
      return;
    }
    const modelProviderActionMatch = url.pathname.match(
      /^\/config\/model-provider\/([^/]+)\/(enable|disable)$/,
    );
    if (request.method === "POST" && modelProviderActionMatch) {
      const [, providerId, action] = modelProviderActionMatch;
      if (!providerId || !action) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      const result = yield* setModelProviderEnabled(
        booted,
        providerId,
        action === "enable",
      );
      writeJson(response, 200, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/config/remote-control") {
      const body = yield* readJsonBody(request);
      const result = yield* updateRemoteControlConfig(booted, body);
      writeJson(response, 200, result);
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

    if (request.method === "GET" && url.pathname === "/skills") {
      const skills = yield* booted.skillRegistry.list();
      writeJson(response, 200, { skills: skills.map(serializeInstalledSkill) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/run") {
      const body = yield* readJsonBody(request);
      const result = yield* runAgentRequest(booted, body);
      writeJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/voice/turn") {
      const body = yield* readJsonBody(request);
      const result = yield* Effect.either(runVoiceTurn(booted, body));
      if (result._tag === "Left") {
        if (String(result.left).includes("ToolApprovalRequiredError")) {
          yield* booted.services.saveState();
          writeJson(response, 202, {
            status: "approval_required",
            approvals: booted.services.approvals.list(),
          });
          return;
        }
        return yield* Effect.fail(result.left);
      }
      writeJson(response, 200, result.right);
      return;
    }

    if (request.method === "POST" && url.pathname === "/voice/stop") {
      const result = yield* booted.services.runtime.executeTool(
        "andy.voice.output.voice.stop",
        {},
      );
      writeJson(response, 200, { output: result.output });
      return;
    }

    if (request.method === "POST" && url.pathname === "/plugins/install-local") {
      const body = yield* readJsonBody(request);
      const result = yield* installLocalPlugin(booted, body);
      writeJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/plugins/review-local") {
      const body = yield* readJsonBody(request);
      const result = yield* reviewLocalPlugin(booted, body);
      writeJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/skills/install-local") {
      const body = yield* readJsonBody(request);
      const result = yield* installLocalSkill(booted, body);
      writeJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/skills/review-local") {
      const body = yield* readJsonBody(request);
      const result = yield* reviewLocalSkill(booted, body);
      writeJson(response, 200, result);
      return;
    }

    const skillActionMatch = url.pathname.match(
      /^\/skills\/([^/]+)\/(enable|disable|remove)$/,
    );
    if (request.method === "POST" && skillActionMatch) {
      const [, skillId, action] = skillActionMatch;
      if (!skillId || !action) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      const result = yield* mutateSkillLifecycle(booted, skillId, action);
      writeJson(response, 200, result);
      return;
    }

    const skillRunMatch = url.pathname.match(/^\/skills\/([^/]+)\/run$/);
    if (request.method === "POST" && skillRunMatch) {
      const [, skillId] = skillRunMatch;
      if (!skillId) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      const body = yield* readJsonBody(request);
      const result = yield* Effect.either(runSkillWorkflow(booted, skillId, body));
      if (result._tag === "Left") {
        if (String(result.left).includes("ToolApprovalRequiredError")) {
          yield* booted.services.saveState();
          writeJson(response, 202, {
            status: "approval_required",
            approvals: booted.services.approvals.list(),
          });
          return;
        }
        return yield* Effect.fail(result.left);
      }
      writeJson(response, 200, result.right);
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
    const sourceRoot = dirname(resolveAssetPath(manifestPath));
    const existing = yield* Effect.either(booted.pluginRegistry.get(manifest.id));
    const plan = createInstallPlan(
      { type: "local", path: sourceRoot },
      {
        ...manifest,
        entry: relativizeEntry(manifest.entry, sourceRoot),
        ...(manifest.binaryEntrypoint
          ? {
              binaryEntrypoint: relativizeEntry(manifest.binaryEntrypoint, sourceRoot),
            }
          : {}),
      },
      existing._tag === "Right" ? existing.right : undefined,
    );
    const installed =
      existing._tag === "Right"
        ? yield* booted.pluginRegistry.upgrade(plan, "approved")
        : yield* booted.pluginRegistry.install(plan);
    yield* installBundledSkills(booted.skillRegistry, manifest, sourceRoot);
    if (enableAfterInstall) {
      yield* mutatePluginLifecycle(booted, manifest.id, "enable");
    } else {
      yield* refreshInstalledPlugins(booted);
      yield* refreshInstalledSkills(booted);
    }
    return {
      plugin: serializeInstalledPlugin(
        enableAfterInstall ? yield* booted.pluginRegistry.get(manifest.id) : installed,
      ),
      plan: serializeInstallPlan(plan),
    };
  })();
}

function upsertModelProviderConfig(
  booted: BootedDaemon,
  body: JsonValue,
): Effect.Effect<
  { config: ReturnType<typeof sanitizeConfig>; restartRequired: boolean },
  unknown
> {
  return Effect.fn("daemon.upsertModelProviderConfig")(function* () {
    const payload = isJsonObject(body)
      ? (body as {
          id?: unknown;
          provider?: unknown;
          modelId?: unknown;
          apiKeyEnv?: unknown;
          enabled?: unknown;
          baseURL?: unknown;
          organization?: unknown;
          project?: unknown;
        })
      : {};
    const id = typeof payload.id === "string" ? payload.id : "";
    const provider = typeof payload.provider === "string" ? payload.provider : "";
    const modelId = typeof payload.modelId === "string" ? payload.modelId : "";
    if (!id || !modelId) {
      throw new Error("id and modelId are required.");
    }
    if (
      provider !== "ai-sdk.openai" &&
      provider !== "ai-sdk.anthropic" &&
      provider !== "ai-sdk.google"
    ) {
      throw new Error(
        "provider must be ai-sdk.openai, ai-sdk.anthropic, or ai-sdk.google.",
      );
    }

    const nextProvider: DaemonModelProviderConfig = {
      id,
      provider,
      enabled: payload.enabled === true,
      modelId,
      ...(typeof payload.apiKeyEnv === "string"
        ? { apiKeyEnv: payload.apiKeyEnv }
        : {}),
      ...(typeof payload.baseURL === "string" ? { baseURL: payload.baseURL } : {}),
      ...(typeof payload.organization === "string"
        ? { organization: payload.organization }
        : {}),
      ...(typeof payload.project === "string" ? { project: payload.project } : {}),
    };
    const existingIndex = booted.config.modelProviders.findIndex(
      (item) => item.id === id,
    );
    if (existingIndex >= 0) {
      booted.config.modelProviders[existingIndex] = nextProvider;
    } else {
      booted.config.modelProviders.push(nextProvider);
    }
    yield* writeConfig(booted.configPath, booted.config);
    return { config: sanitizeConfig(booted.config), restartRequired: true };
  })();
}

function setModelProviderEnabled(
  booted: BootedDaemon,
  providerId: string,
  enabled: boolean,
): Effect.Effect<
  { config: ReturnType<typeof sanitizeConfig>; restartRequired: boolean },
  unknown
> {
  return Effect.fn("daemon.setModelProviderEnabled")(function* () {
    const provider = booted.config.modelProviders.find(
      (item) => item.id === providerId,
    );
    if (!provider) {
      throw new Error(`Unknown model provider '${providerId}'.`);
    }
    provider.enabled = enabled;
    yield* writeConfig(booted.configPath, booted.config);
    return { config: sanitizeConfig(booted.config), restartRequired: true };
  })();
}

function updateRemoteControlConfig(
  booted: BootedDaemon,
  body: JsonValue,
): Effect.Effect<
  { config: ReturnType<typeof sanitizeConfig>; restartRequired: boolean },
  unknown
> {
  return Effect.fn("daemon.updateRemoteControlConfig")(function* () {
    const payload = isJsonObject(body)
      ? (body as {
          channel?: unknown;
          enabled?: unknown;
          modelProviderId?: unknown;
          pollMs?: unknown;
          systemPrompt?: unknown;
        })
      : {};
    const channel = typeof payload.channel === "string" ? payload.channel : "";
    if (channel !== "telegram" && channel !== "whatsapp") {
      throw new Error("channel must be telegram or whatsapp.");
    }
    const current =
      channel === "telegram"
        ? booted.config.remoteControl.telegram
        : booted.config.remoteControl.whatsapp;
    const next = {
      enabled: payload.enabled === true,
      modelProviderId:
        typeof payload.modelProviderId === "string"
          ? payload.modelProviderId
          : (current?.modelProviderId ?? "ai-sdk.openai.default"),
      ...(channel === "telegram"
        ? {
            pollMs:
              typeof payload.pollMs === "number" && payload.pollMs > 0
                ? payload.pollMs
                : ((
                    current as
                      | NonNullable<DaemonRemoteControlConfig["telegram"]>
                      | undefined
                  )?.pollMs ?? 3000),
          }
        : {}),
      ...(typeof payload.systemPrompt === "string"
        ? { systemPrompt: payload.systemPrompt }
        : current?.systemPrompt
          ? { systemPrompt: current.systemPrompt }
          : {}),
    };
    if (channel === "telegram") {
      booted.config.remoteControl.telegram = next as NonNullable<
        DaemonRemoteControlConfig["telegram"]
      >;
    } else {
      booted.config.remoteControl.whatsapp = next;
    }
    yield* writeConfig(booted.configPath, booted.config);
    return { config: sanitizeConfig(booted.config), restartRequired: true };
  })();
}

function reviewLocalPlugin(
  booted: BootedDaemon,
  body: JsonValue,
): Effect.Effect<{ plan: ReturnType<typeof serializeInstallPlan> }, unknown> {
  return Effect.fn("daemon.reviewLocalPlugin")(function* () {
    const payload = isJsonObject(body) ? (body as { manifestPath?: unknown }) : {};
    const manifestPath =
      typeof payload.manifestPath === "string" ? payload.manifestPath : "";
    if (!manifestPath) {
      throw new Error("manifestPath is required.");
    }
    const manifest = yield* loadManifest(manifestPath);
    const sourceRoot = dirname(resolveAssetPath(manifestPath));
    const existing = yield* Effect.either(booted.pluginRegistry.get(manifest.id));
    const plan = createInstallPlan(
      { type: "local", path: sourceRoot },
      {
        ...manifest,
        entry: relativizeEntry(manifest.entry, sourceRoot),
        ...(manifest.binaryEntrypoint
          ? {
              binaryEntrypoint: relativizeEntry(manifest.binaryEntrypoint, sourceRoot),
            }
          : {}),
      },
      existing._tag === "Right" ? existing.right : undefined,
    );
    return { plan: serializeInstallPlan(plan) };
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

    const checkoutPath = resolveDataPath(
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
        ...(manifest.binaryEntrypoint
          ? {
              binaryEntrypoint: relativizeEntry(
                manifest.binaryEntrypoint,
                checkoutPath,
              ),
            }
          : {}),
      },
      existing._tag === "Right" ? existing.right : undefined,
    );
    const installed =
      existing._tag === "Right"
        ? yield* booted.pluginRegistry.upgrade(plan, "approved")
        : yield* booted.pluginRegistry.install(plan);
    yield* installBundledSkills(booted.skillRegistry, manifest, checkoutPath);
    if (enableAfterInstall) {
      yield* mutatePluginLifecycle(booted, manifest.id, "enable");
    } else {
      yield* refreshInstalledPlugins(booted);
      yield* refreshInstalledSkills(booted);
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

function installLocalSkill(
  booted: BootedDaemon,
  body: JsonValue,
): Effect.Effect<
  {
    skill: ReturnType<typeof serializeInstalledSkill>;
    plan: ReturnType<typeof serializeSkillInstallPlan>;
  },
  unknown
> {
  return Effect.fn("daemon.installLocalSkill")(function* () {
    const payload = isJsonObject(body)
      ? (body as { manifestPath?: unknown; enabled?: unknown })
      : {};
    const manifestPath =
      typeof payload.manifestPath === "string" ? payload.manifestPath : "";
    if (!manifestPath) {
      throw new Error("manifestPath is required.");
    }
    const enableAfterInstall = payload.enabled === true;
    const manifest = yield* loadSkillManifest(manifestPath);
    const sourceRoot = dirname(resolveAssetPath(manifestPath));
    const existing = yield* Effect.either(booted.skillRegistry.get(manifest.id));
    const plan = createSkillInstallPlan(
      { type: "local", path: sourceRoot },
      manifest,
      existing._tag === "Right" ? existing.right : undefined,
    );
    const installed =
      existing._tag === "Right"
        ? yield* booted.skillRegistry.upgrade(plan, "approved")
        : yield* booted.skillRegistry.install(plan);
    if (enableAfterInstall) {
      yield* mutateSkillLifecycle(booted, manifest.id, "enable");
    } else {
      yield* refreshInstalledSkills(booted);
      yield* booted.services.saveState();
    }
    return {
      skill: serializeInstalledSkill(
        enableAfterInstall ? yield* booted.skillRegistry.get(manifest.id) : installed,
      ),
      plan: serializeSkillInstallPlan(plan),
    };
  })();
}

function reviewLocalSkill(
  booted: BootedDaemon,
  body: JsonValue,
): Effect.Effect<{ plan: ReturnType<typeof serializeSkillInstallPlan> }, unknown> {
  return Effect.fn("daemon.reviewLocalSkill")(function* () {
    const payload = isJsonObject(body) ? (body as { manifestPath?: unknown }) : {};
    const manifestPath =
      typeof payload.manifestPath === "string" ? payload.manifestPath : "";
    if (!manifestPath) {
      throw new Error("manifestPath is required.");
    }
    const manifest = yield* loadSkillManifest(manifestPath);
    const existing = yield* Effect.either(booted.skillRegistry.get(manifest.id));
    const plan = createSkillInstallPlan(
      { type: "local", path: dirname(resolveAssetPath(manifestPath)) },
      manifest,
      existing._tag === "Right" ? existing.right : undefined,
    );
    return { plan: serializeSkillInstallPlan(plan) };
  })();
}

function mutateSkillLifecycle(
  booted: BootedDaemon,
  skillId: string,
  action: string,
): Effect.Effect<{ skill: ReturnType<typeof serializeInstalledSkill> }, unknown> {
  return Effect.fn("daemon.mutateSkillLifecycle")(function* () {
    const record =
      action === "enable"
        ? yield* booted.skillRegistry.enable(skillId)
        : action === "disable"
          ? yield* booted.skillRegistry.disable(skillId)
          : action === "remove"
            ? yield* booted.skillRegistry.remove(skillId)
            : undefined;
    if (!record) {
      throw new Error(`Unsupported skill action '${action}'.`);
    }
    yield* refreshInstalledSkills(booted);
    yield* booted.services.saveState();
    return { skill: serializeInstalledSkill(record) };
  })();
}

function runSkillWorkflow(
  booted: BootedDaemon,
  skillId: string,
  body: JsonValue,
): Effect.Effect<
  {
    skillId: string;
    workflow: string;
    results: Array<{ stepId: string; toolName: string; output: JsonValue }>;
  },
  unknown
> {
  return Effect.fn("daemon.runSkillWorkflow")(function* () {
    const payload = isJsonObject(body)
      ? (body as { workflow?: unknown; input?: unknown })
      : {};
    const record = yield* booted.skillRegistry.get(skillId);
    if (record.status !== "enabled") {
      throw new Error(`Skill '${skillId}' is not enabled.`);
    }
    assertSkillRequirementsAvailable(booted, record);
    const workflowName =
      typeof payload.workflow === "string"
        ? payload.workflow
        : record.manifest.workflows[0]?.name;
    const workflow = record.manifest.workflows.find(
      (candidate) => candidate.name === workflowName,
    );
    if (!workflow) {
      throw new Error(
        `Skill '${skillId}' workflow '${String(workflowName)}' not found.`,
      );
    }
    const input =
      payload.input !== undefined && isJsonValue(payload.input) ? payload.input : {};
    const results: Array<{ stepId: string; toolName: string; output: JsonValue }> = [];
    const context: SkillRenderContext = {
      input,
      steps: new Map(),
      vars: new Map(),
    };

    for (const step of workflow.steps) {
      if (step.when && !readSkillCondition(step.when, context)) {
        continue;
      }
      const eachValue = step.forEach ? readSkillPath(step.forEach, context) : undefined;
      const items = Array.isArray(eachValue) ? eachValue : [undefined];
      for (const item of items) {
        if (item !== undefined) {
          context.vars.set("item", item);
        }
        const renderedInput = renderSkillTemplate(step.input, context);
        if (!isJsonObject(renderedInput)) {
          throw new Error(
            `Skill '${skillId}' step '${step.id}' did not render object input.`,
          );
        }
        const result = yield* Effect.either(
          booted.services.runtime.executeTool(step.toolName, renderedInput, {
            taskId: `${skillId}:${workflow.name}:${step.id}`,
          }),
        );
        if (result._tag === "Left") {
          if (step.continueOnError) {
            const errorOutput: JsonValue = { error: String(result.left) };
            context.steps.set(step.id, errorOutput);
            if (step.saveAs) {
              context.vars.set(step.saveAs, errorOutput);
            }
            results.push({
              stepId: step.id,
              toolName: step.toolName,
              output: errorOutput,
            });
            continue;
          }
          return yield* Effect.fail(result.left);
        }
        context.steps.set(step.id, result.right.output);
        if (step.saveAs) {
          context.vars.set(step.saveAs, result.right.output);
        }
        results.push({
          stepId: step.id,
          toolName: step.toolName,
          output: result.right.output,
        });
      }
      context.vars.delete("item");
    }

    yield* booted.services.saveState();
    return { skillId, workflow: workflow.name, results };
  })();
}

function runAgentRequest(
  booted: BootedDaemon,
  body: JsonValue,
): Effect.Effect<{ response: string; sessionId: string }, unknown> {
  return Effect.fn("daemon.runAgentRequest")(function* () {
    const payload = isJsonObject(body)
      ? (body as {
          message?: unknown;
          modelProviderId?: unknown;
          systemPrompt?: unknown;
          skillIds?: unknown;
          sessionId?: unknown;
          images?: unknown;
        })
      : {};
    const message = typeof payload.message === "string" ? payload.message : "";
    if (!message) {
      throw new Error("message is required.");
    }
    const modelProviderId =
      typeof payload.modelProviderId === "string"
        ? payload.modelProviderId
        : "ai-sdk.openai.default";
    const skillIds = Array.isArray(payload.skillIds)
      ? payload.skillIds.filter((item): item is string => typeof item === "string")
      : [];
    const images = yield* normalizeAgentImages(payload.images);
    const runner = yield* booted.services.modelProviders.createRunner(modelProviderId);
    const kernel = new AgentKernel({
      runtime: booted.services.runtime,
      llm: runner,
      audit: booted.services.audit,
      sessionStore: booted.services.sessions,
    });
    const result = yield* kernel.run({
      userMessage: message,
      ...(typeof payload.sessionId === "string"
        ? { sessionId: payload.sessionId }
        : {}),
      ...(typeof payload.systemPrompt === "string"
        ? { systemPrompt: payload.systemPrompt }
        : {}),
      ...(skillIds.length > 0
        ? { skillInstructions: yield* buildSkillInstructions(booted, skillIds) }
        : {}),
      ...(images.length > 0 ? { images } : {}),
    });
    yield* booted.services.saveState();
    return { response: result.response, sessionId: result.session.id };
  })();
}

function runVoiceTurn(
  booted: BootedDaemon,
  body: JsonValue,
): Effect.Effect<
  {
    transcript: string;
    response: string;
    sessionId: string;
    spoken: boolean;
    speechOutput?: JsonValue;
  },
  unknown
> {
  return Effect.fn("daemon.runVoiceTurn")(function* () {
    const payload = isJsonObject(body) ? body : {};
    const text = optionalJsonString(payload, "text");
    const audioPath = optionalJsonString(payload, "audioPath");
    const transcriptPath = optionalJsonString(payload, "transcriptPath");
    const message = optionalJsonString(payload, "message");
    const speak = readJsonBoolean(payload, "speak") ?? true;
    const voice = optionalJsonString(payload, "voice");
    const modelProviderId = optionalJsonString(payload, "modelProviderId");
    const systemPrompt = optionalJsonString(payload, "systemPrompt");
    const skillIdsValue = readJsonProperty(payload, "skillIds");
    const skillIds = Array.isArray(skillIdsValue)
      ? skillIdsValue.filter((item): item is string => typeof item === "string")
      : [];
    const transcribeInput: JsonObject = {
      ...(text ? { text } : {}),
      ...(audioPath ? { audioPath } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
    };
    const transcription = yield* booted.services.runtime.executeTool(
      "andy.voice.input.voice.transcribe",
      transcribeInput,
      { channelId: "local-voice" },
    );
    const transcript = readJsonOutputString(transcription.output, "text");
    if (!transcript) {
      throw new Error(
        "Voice turn has no transcript. Provide text/transcriptPath, or configure an STT provider plugin for audio files.",
      );
    }
    const agentResult = yield* runAgentRequest(booted, {
      message: message ? `${message}\n\nTranscript: ${transcript}` : transcript,
      ...(modelProviderId ? { modelProviderId } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(skillIds.length > 0 ? { skillIds } : {}),
    });
    let speechOutput: JsonValue | undefined;
    if (speak) {
      const speech = yield* booted.services.runtime.executeTool(
        "andy.voice.output.voice.speak",
        {
          text: agentResult.response,
          ...(voice ? { voice } : {}),
        },
        { channelId: "local-voice" },
      );
      speechOutput = speech.output;
    }
    return {
      transcript,
      response: agentResult.response,
      sessionId: agentResult.sessionId,
      spoken: speak,
      ...(speechOutput ? { speechOutput } : {}),
    };
  })();
}

function buildSkillInstructions(
  booted: BootedDaemon,
  skillIds: readonly string[],
): Effect.Effect<string, unknown> {
  return Effect.fn("daemon.buildSkillInstructions")(function* () {
    const sections: string[] = [];
    for (const skillId of skillIds) {
      const skill = yield* booted.skillRegistry.get(skillId);
      if (skill.status !== "enabled") {
        throw new Error(`Skill '${skillId}' is not enabled.`);
      }
      assertSkillRequirementsAvailable(booted, skill);
      sections.push(formatSkillForPrompt(skill));
    }
    return `Use these installed Andy skills when relevant. Skills are declarative guidance; execute actions only through available tools.\n\n${sections.join("\n\n")}`;
  })();
}

function normalizeAgentImages(
  value: unknown,
): Effect.Effect<readonly { data: string; mediaType?: string }[], unknown> {
  return Effect.fn("daemon.normalizeAgentImages")(function* () {
    if (!Array.isArray(value)) {
      return [];
    }
    const images: { data: string; mediaType?: string }[] = [];
    for (const item of value) {
      if (!isJsonObject(item)) {
        continue;
      }
      const data = optionalJsonString(item, "data");
      const imageBase64 = optionalJsonString(item, "imageBase64");
      const path = optionalJsonString(item, "path");
      const mediaType = optionalJsonString(item, "mediaType");
      if (data ?? imageBase64) {
        images.push({
          data: data ?? imageBase64 ?? "",
          ...(mediaType ? { mediaType } : {}),
        });
        continue;
      }
      if (path) {
        const bytes = yield* Effect.tryPromise({
          try: () => readFile(path),
          catch: (cause) => cause,
        });
        images.push({
          data: bytes.toString("base64"),
          mediaType: mediaType ?? detectImageMediaType(bytes),
        });
      }
    }
    return images;
  })();
}

function optionalJsonString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function readJsonBoolean(object: JsonObject, key: string): boolean | undefined {
  const value = object[key];
  return typeof value === "boolean" ? value : undefined;
}

function readJsonProperty(object: JsonObject, key: string): JsonValue | undefined {
  return object[key];
}

function readJsonOutputString(value: JsonValue, key: string): string {
  if (!isJsonObject(value)) {
    return "";
  }
  const entry = value[key];
  return typeof entry === "string" ? entry : "";
}

function detectImageMediaType(bytes: Buffer): string {
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
  if (bytes.subarray(0, 4).toString("utf8") === "RIFF") {
    return "image/webp";
  }
  return "application/octet-stream";
}

function formatSkillForPrompt(skill: InstalledSkillRecord): string {
  const workflows = skill.manifest.workflows
    .map(
      (workflow) =>
        `Workflow ${workflow.name}: ${workflow.description}\nSteps:\n${workflow.steps
          .map((step) => `- ${step.id}: call ${step.toolName}`)
          .join("\n")}`,
    )
    .join("\n");
  return [
    `Skill ${skill.manifest.id}: ${skill.manifest.name}`,
    skill.manifest.description,
    skill.manifest.instructions ?? "",
    `Required capabilities: ${skill.manifest.requiredCapabilities.join(", ")}`,
    workflows,
  ]
    .filter(Boolean)
    .join("\n");
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
      yield* disablePluginOwnedSkills(booted, pluginId);
      booted.startedPluginIds = booted.startedPluginIds.filter((id) => id !== pluginId);
      yield* refreshInstalledPlugins(booted);
      yield* refreshInstalledSkills(booted);
      yield* booted.services.saveState();
      return { plugin: serializeInstalledPlugin(record) };
    } else if (action === "remove") {
      const record = yield* booted.pluginRegistry.remove(pluginId);
      yield* booted.services.lifecycle.stop(pluginId).pipe(Effect.ignore);
      yield* booted.services.runtime.removePlugin(pluginId).pipe(Effect.ignore);
      yield* removePluginOwnedSkills(booted, pluginId);
      booted.startedPluginIds = booted.startedPluginIds.filter((id) => id !== pluginId);
      yield* refreshInstalledPlugins(booted);
      yield* refreshInstalledSkills(booted);
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

function refreshInstalledSkills(booted: BootedDaemon): Effect.Effect<void, unknown> {
  return booted.skillRegistry.list().pipe(
    Effect.flatMap((skills) =>
      Effect.sync(() => {
        booted.installedSkills = [...skills];
      }),
    ),
  );
}

function disablePluginOwnedSkills(
  booted: BootedDaemon,
  pluginId: string,
): Effect.Effect<void, unknown> {
  return Effect.fn("daemon.disablePluginOwnedSkills")(function* () {
    const skills = yield* booted.skillRegistry.list();
    for (const skill of skills) {
      if (skill.source.type === "plugin" && skill.source.pluginId === pluginId) {
        yield* booted.skillRegistry.disable(skill.manifest.id);
      }
    }
  })();
}

function removePluginOwnedSkills(
  booted: BootedDaemon,
  pluginId: string,
): Effect.Effect<void, unknown> {
  return Effect.fn("daemon.removePluginOwnedSkills")(function* () {
    const skills = yield* booted.skillRegistry.list();
    for (const skill of skills) {
      if (skill.source.type === "plugin" && skill.source.pluginId === pluginId) {
        yield* booted.skillRegistry.remove(skill.manifest.id);
      }
    }
  })();
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

function serializeInstalledSkill(skill: InstalledSkillRecord) {
  return {
    skillId: skill.manifest.id,
    name: skill.manifest.name,
    version: skill.manifest.version,
    description: skill.manifest.description,
    status: skill.status,
    risk: skill.manifest.risk,
    source: skill.source,
    requiredPlugins: skill.manifest.requiredPlugins,
    requiredCapabilities: skill.manifest.requiredCapabilities,
    workflows: skill.manifest.workflows.map((workflow) => ({
      name: workflow.name,
      description: workflow.description,
      stepCount: workflow.steps.length,
    })),
    installedAt: skill.installedAt,
    updatedAt: skill.updatedAt,
  };
}

function serializeSkillInstallPlan(plan: SkillInstallPlan) {
  return {
    source: plan.source,
    skillId: plan.manifest.id,
    capabilityChanges: plan.capabilityChanges,
    pluginChanges: plan.pluginChanges,
    requiresApproval: plan.requiresApproval,
  };
}

function assertSkillRequirementsAvailable(
  booted: BootedDaemon,
  skill: InstalledSkillRecord,
): void {
  const enabledPlugins = new Set(
    booted.installedPlugins
      .filter((plugin) => plugin.status === "enabled")
      .map((plugin) => plugin.manifest.id),
  );
  for (const pluginId of skill.manifest.requiredPlugins) {
    if (!enabledPlugins.has(pluginId)) {
      throw new Error(
        `Skill '${skill.manifest.id}' requires enabled plugin '${pluginId}'.`,
      );
    }
  }

  const availableCapabilities = new Set(
    booted.installedPlugins
      .filter((plugin) => plugin.status === "enabled")
      .flatMap((plugin) => plugin.manifest.capabilities),
  );
  for (const capability of skill.manifest.requiredCapabilities) {
    if (!availableCapabilities.has(capability)) {
      throw new Error(
        `Skill '${skill.manifest.id}' requires capability '${capability}'.`,
      );
    }
  }
}

interface SkillRenderContext {
  input: JsonValue;
  steps: Map<string, JsonValue>;
  vars: Map<string, JsonValue>;
}

function renderSkillTemplate(value: JsonValue, context: SkillRenderContext): JsonValue {
  if (typeof value === "string") {
    return renderSkillString(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderSkillTemplate(item, context));
  }
  if (isJsonObject(value)) {
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const rendered = renderSkillTemplate(item, context);
      if (rendered !== undefined) {
        output[key] = rendered;
      }
    }
    return output;
  }
  return value;
}

function renderSkillString(value: string, context: SkillRenderContext): JsonValue {
  const exact = value.match(/^\{\{([^}]+)\}\}$/);
  if (exact?.[1]) {
    return readSkillPath(exact[1].trim(), context) ?? "";
  }
  return value.replace(/\{\{([^}]+)\}\}/g, (_match, expression: string) =>
    stringifyTemplateValue(readSkillPath(expression.trim(), context)),
  );
}

function readSkillPath(
  path: string,
  context: SkillRenderContext,
): JsonValue | undefined {
  if (path === "input") {
    return context.input;
  }
  if (path === "item") {
    return context.vars.get("item");
  }
  if (path.startsWith("input.")) {
    return readPath(context.input, path.slice("input.".length));
  }
  if (path.startsWith("vars.")) {
    const parts = path.slice("vars.".length).split(".");
    const [name, ...rest] = parts;
    if (!name) {
      return undefined;
    }
    const value = context.vars.get(name);
    return rest.length === 0 ? value : readPath(value, rest.join("."));
  }
  if (path.startsWith("item.")) {
    return readPath(context.vars.get("item"), path.slice("item.".length));
  }
  if (path.startsWith("steps.")) {
    const parts = path.slice("steps.".length).split(".");
    const [stepId, ...rest] = parts;
    if (!stepId) {
      return undefined;
    }
    const output = context.steps.get(stepId);
    if (rest[0] === "output") {
      return rest.length === 1 ? output : readPath(output, rest.slice(1).join("."));
    }
  }
  return undefined;
}

function readSkillCondition(expression: string, context: SkillRenderContext): boolean {
  const value = readSkillPath(expression, context);
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 0 && value !== "false";
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return value !== null && value !== undefined;
}

function readPath(value: JsonValue | undefined, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const part of path.split(".").filter(Boolean)) {
    if (!isJsonObject(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function stringifyTemplateValue(value: JsonValue | undefined): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isFileNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
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
  response.writeHead(statusCode, {
    "access-control-allow-headers": "content-type,x-andy-webhook-secret",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": "http://127.0.0.1:8790",
    "content-type": "application/json",
  });
  response.end(`${JSON.stringify(body)}\n`);
}
