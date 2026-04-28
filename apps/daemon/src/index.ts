#!/usr/bin/env node
import { ConsoleAuditSink } from "@andy/audit";
import {
  SqliteStructuredMemoryStore,
  type StructuredMemorySensitivity,
  type StructuredMemoryQuery,
  type StructuredMemoryRecord,
  type StructuredMemoryStore,
  type StructuredMemoryType,
} from "@andy/memory";
import {
  AgentKernel,
  CommunicationSendError,
  createAndyDaemon,
  type DurableTaskGraph,
  type DurableTaskRun,
  type DurableTaskStepDefinition,
  JsonFileCoreStateStore,
  OsSecretBroker,
  SqliteCoreStateStore,
  type ProvenanceLabel,
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
  parsePluginSignatureFile,
  SqlitePluginRegistry,
  type InstalledPluginRecord,
  type PluginTrustRecord,
  type TrustedPluginPublisher,
  verifyPluginManifestSignature,
} from "@andy/plugin-manager";
import { parsePluginManifest, type PluginManifest } from "@andy/plugin-sdk";
import {
  createSkillInstallPlan,
  JsonFileSkillRegistry,
  SqliteSkillRegistry,
  type InstalledSkillRecord,
  type SkillInstallPlan,
} from "@andy/skill-manager";
import { parseSkillManifest, type SkillManifest } from "@andy/skill-sdk";
import {
  createPolicyEngineFromConfig,
  JsonFilePolicyStore,
  SqlitePolicyStore,
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
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createServer as createNetServer, type Socket } from "node:net";

interface DaemonConfig {
  statePath: string;
  stateStore: DaemonStateStoreConfig;
  pluginRegistryPath: string;
  skillRegistryPath: string;
  pluginInstallRoot: string;
  policyPath: string;
  secretFallbackPath: string;
  trustedPublishers: TrustedPluginPublisher[];
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

interface DaemonStateStoreConfig {
  kind: "json" | "sqlite";
  path: string;
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
  pluginRegistry: PluginRegistryStore;
  skillRegistry: SkillRegistryStore;
  structuredMemory: StructuredMemoryStore;
  startedPluginIds: string[];
  installedPlugins: InstalledPluginRecord[];
  installedSkills: InstalledSkillRecord[];
}

interface PluginRegistryStore {
  install(
    plan: ReturnType<typeof createInstallPlan>,
  ): Effect.Effect<InstalledPluginRecord, unknown>;
  enable(pluginId: string): Effect.Effect<InstalledPluginRecord, unknown>;
  disable(pluginId: string): Effect.Effect<InstalledPluginRecord, unknown>;
  remove(pluginId: string): Effect.Effect<InstalledPluginRecord, unknown>;
  upgrade(
    plan: ReturnType<typeof createInstallPlan>,
    approval: "approved" | "not-approved",
  ): Effect.Effect<InstalledPluginRecord, unknown>;
  get(pluginId: string): Effect.Effect<InstalledPluginRecord, unknown>;
  list(): Effect.Effect<readonly InstalledPluginRecord[], unknown>;
}

interface SkillRegistryStore {
  install(plan: SkillInstallPlan): Effect.Effect<InstalledSkillRecord, unknown>;
  enable(skillId: string): Effect.Effect<InstalledSkillRecord, unknown>;
  disable(skillId: string): Effect.Effect<InstalledSkillRecord, unknown>;
  remove(skillId: string): Effect.Effect<InstalledSkillRecord, unknown>;
  upgrade(
    plan: SkillInstallPlan,
    approval: "approved" | "not-approved",
  ): Effect.Effect<InstalledSkillRecord, unknown>;
  get(skillId: string): Effect.Effect<InstalledSkillRecord, unknown>;
  list(): Effect.Effect<readonly InstalledSkillRecord[], unknown>;
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

if (args.has("--acp")) {
  await runAcpStdioServer(booted);
  await Effect.runPromise(shutdownDaemon(booted));
  process.exit(0);
}

const acpSocketServer = await startAcpSocketServer(booted);
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
    acpSocketPath: getAcpSocketPath(),
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
  await new Promise<void>((resolveClose) =>
    acpSocketServer.close(() => resolveClose()),
  );
  await Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        platform() === "win32"
          ? Promise.resolve()
          : rm(getAcpSocketPath(), { force: true }),
      catch: (cause) => cause,
    }).pipe(Effect.ignore),
  );
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
    const pluginRegistry = createPluginRegistry(config);
    const skillRegistry = createSkillRegistry(config);
    const policyStore = createPolicyStore(config);
    const structuredMemory = createStructuredMemoryStore(config);
    const policyConfig = yield* policyStore.load(createDefaultPolicyConfig(config));
    const audit = new ConsoleAuditSink();
    const secretBroker = new OsSecretBroker({
      audit,
      fallbackPath: resolveDataPath(config.secretFallbackPath),
    });
    yield* secretBroker.load();
    const services = yield* createAndyDaemon({
      audit,
      policy: createPolicyEngineFromConfig(policyConfig),
      stateStore: createCoreStateStore(config),
      secretBroker,
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
      structuredMemory,
      startedPluginIds,
      installedPlugins: [...installedPlugins],
      installedSkills: [...installedSkills],
    };
  })();
}

function createPluginRegistry(config: DaemonConfig): PluginRegistryStore {
  return config.stateStore.kind === "sqlite"
    ? new SqlitePluginRegistry(resolveDataPath(config.stateStore.path))
    : new JsonFilePluginRegistry(resolveDataPath(config.pluginRegistryPath));
}

function createSkillRegistry(config: DaemonConfig): SkillRegistryStore {
  return config.stateStore.kind === "sqlite"
    ? new SqliteSkillRegistry(resolveDataPath(config.stateStore.path))
    : new JsonFileSkillRegistry(resolveDataPath(config.skillRegistryPath));
}

function createPolicyStore(
  config: DaemonConfig,
): JsonFilePolicyStore | SqlitePolicyStore {
  return config.stateStore.kind === "sqlite"
    ? new SqlitePolicyStore(resolveDataPath(config.stateStore.path))
    : new JsonFilePolicyStore(resolveDataPath(config.policyPath));
}

function createStructuredMemoryStore(config: DaemonConfig): StructuredMemoryStore {
  return new SqliteStructuredMemoryStore({
    path:
      config.stateStore.kind === "sqlite"
        ? resolveDataPath(config.stateStore.path)
        : resolveDataPath(".andy/structured-memory.sqlite"),
  });
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

function toInstallManifest(
  manifest: PluginManifest,
  sourceRoot: string,
): PluginManifest {
  return {
    ...manifest,
    entry: relativizeEntry(manifest.entry, sourceRoot),
    ...(manifest.binaryEntrypoint
      ? {
          binaryEntrypoint: relativizeEntry(manifest.binaryEntrypoint, sourceRoot),
        }
      : {}),
  };
}

function loadPluginTrust(
  manifest: PluginManifest,
  sourceRoot: string,
  config: DaemonConfig,
): Effect.Effect<PluginTrustRecord, unknown> {
  return Effect.fn("daemon.loadPluginTrust")(function* () {
    const signaturePath = resolve(sourceRoot, "plugin.signature.json");
    const signature = yield* Effect.either(
      Effect.tryPromise({
        try: async () =>
          parsePluginSignatureFile(JSON.parse(await readFile(signaturePath, "utf8"))),
        catch: (cause) => cause,
      }),
    );
    if (signature._tag === "Left") {
      if (isFileNotFound(signature.left)) {
        return { signatureStatus: "unsigned" as const };
      }
      return yield* Effect.fail(signature.left);
    }
    return verifyPluginManifestSignature({
      manifest,
      signature: signature.right,
      trustedPublishers: config.trustedPublishers,
    });
  })();
}

function seedPluginRegistryFromConfig(
  registry: PluginRegistryStore,
  skillRegistry: SkillRegistryStore,
  config: DaemonConfig,
): Effect.Effect<void, unknown> {
  return Effect.fn("daemon.seedPluginRegistryFromConfig")(function* () {
    for (const plugin of config.plugins) {
      const manifest = yield* loadManifest(plugin.manifestPath);
      const sourceRoot = dirname(resolveAssetPath(plugin.manifestPath));
      const installManifest = toInstallManifest(manifest, sourceRoot);
      const trust = yield* loadPluginTrust(installManifest, sourceRoot, config);
      const source = {
        type: "local" as const,
        path: sourceRoot,
      };
      const existing = yield* Effect.either(registry.get(manifest.id));
      if (existing._tag === "Left") {
        yield* registry.install(
          createInstallPlan(source, installManifest, undefined, { trust }),
        );
      } else {
        const nextManifest = installManifest;
        if (JSON.stringify(existing.right.manifest) !== JSON.stringify(nextManifest)) {
          yield* registry.upgrade(
            createInstallPlan(source, nextManifest, existing.right, { trust }),
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
  registry: SkillRegistryStore,
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
  registry: SkillRegistryStore,
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

function getAcpSocketPath(): string {
  if (platform() === "win32") {
    const name = dataRoot.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return `\\\\.\\pipe\\andy-${name}`;
  }
  return resolveDataPath(".andy/andy.sock");
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
    stateStore: {
      kind: "sqlite",
      path: ".andy/andy.sqlite",
    },
    pluginRegistryPath: ".andy/plugins.json",
    skillRegistryPath: ".andy/skills.json",
    pluginInstallRoot: ".andy/github-plugins",
    policyPath: ".andy/policy.json",
    secretFallbackPath: ".andy/secrets.json",
    trustedPublishers: [],
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
      "browser.navigate",
      "browser.inspect",
      "browser.click",
      "browser.type",
      "browser.screenshot",
      "browser.submit_form",
      "codex.run",
      "codex.thread",
      "mcp.connect",
      "mcp.list_tools",
      "mcp.call_tool",
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
      "browser.navigate",
      "browser.click",
      "browser.type",
      "browser.screenshot",
      "browser.submit_form",
      "codex.run",
      "codex.thread",
      "mcp.connect",
      "mcp.call_tool",
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
      { manifestPath: "plugins/browser/plugin.json", enabled: false },
      { manifestPath: "plugins/codex/plugin.json", enabled: false },
      { manifestPath: "plugins/mcp-client/plugin.json", enabled: false },
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
    stateStore: parseStateStoreConfig(record.stateStore, defaults.stateStore),
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
    secretFallbackPath:
      typeof record.secretFallbackPath === "string"
        ? record.secretFallbackPath
        : ".andy/secrets.json",
    trustedPublishers: parseTrustedPublishers(record.trustedPublishers),
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

function parseStateStoreConfig(
  value: unknown,
  defaults: DaemonStateStoreConfig,
): DaemonStateStoreConfig {
  if (typeof value !== "object" || value === null) {
    return defaults;
  }
  const record = value as Partial<DaemonStateStoreConfig>;
  const kind =
    record.kind === "json" || record.kind === "sqlite" ? record.kind : "sqlite";
  const path =
    typeof record.path === "string"
      ? record.path
      : kind === "json"
        ? ".andy/state.json"
        : ".andy/andy.sqlite";
  return { kind, path };
}

function createCoreStateStore(config: DaemonConfig) {
  if (config.stateStore.kind === "json") {
    return new JsonFileCoreStateStore(resolveDataPath(config.stateStore.path));
  }
  return new SqliteCoreStateStore(resolveDataPath(config.stateStore.path));
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

function parseTrustedPublishers(value: unknown): TrustedPluginPublisher[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): TrustedPluginPublisher[] => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const record = item as Partial<TrustedPluginPublisher>;
    if (typeof record.id !== "string" || typeof record.publicKey !== "string") {
      return [];
    }
    return [{ id: record.id, publicKey: record.publicKey }];
  });
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
    stateStore: booted.config.stateStore,
    pluginRegistryPath: booted.config.pluginRegistryPath,
    skillRegistryPath: booted.config.skillRegistryPath,
    pluginInstallRoot: booted.config.pluginInstallRoot,
    policyPath: booted.config.policyPath,
    secretFallbackPath: booted.config.secretFallbackPath,
    pluginHosts: booted.services.lifecycle.health(),
    installedPlugins: booted.installedPlugins.map((plugin) => ({
      pluginId: plugin.manifest.id,
      status: plugin.status,
      source: plugin.source,
      trust: plugin.trust ?? { signatureStatus: "unsigned" },
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

interface ObservabilityQuery {
  fromSequence?: string;
  limit?: string;
  type?: string;
  traceId?: string;
  sessionId?: string;
  parentTraceId?: string;
  name?: string;
}

interface EventFilterRecord {
  type?: unknown;
  traceId?: unknown;
  sessionId?: unknown;
}

function queryEvents(booted: BootedDaemon, query: ObservabilityQuery) {
  const fromSequence = parsePositiveNumber(query.fromSequence) ?? 1;
  const limit = parsePositiveNumber(query.limit) ?? 100;
  const type = query.type;
  const traceId = query.traceId;
  const sessionId = query.sessionId;
  return booted.services.eventBus
    .replay(fromSequence)
    .filter((envelope) => {
      const event = envelope.event as EventFilterRecord;
      return (
        (!type || event.type === type) &&
        (!traceId || event.traceId === traceId) &&
        (!sessionId || event.sessionId === sessionId)
      );
    })
    .slice(-limit)
    .map((envelope) => ({
      ...envelope,
      publishedAt: envelope.publishedAt.toISOString(),
    }));
}

function queryTraces(booted: BootedDaemon, query: ObservabilityQuery) {
  const limit = parsePositiveNumber(query.limit) ?? 100;
  const parentTraceId = query.parentTraceId;
  const traceId = query.traceId;
  const name = query.name;
  return booted.services.traces
    .list()
    .filter(
      (trace) =>
        (!traceId || trace.traceId === traceId) &&
        (!parentTraceId || trace.parentTraceId === parentTraceId) &&
        (!name || trace.name.includes(name)),
    )
    .slice(-limit)
    .map((trace) => ({
      ...trace,
      startedAt: trace.startedAt.toISOString(),
    }));
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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

type JsonRpcId = string | number | null;
type JsonRpcWriter = (message: JsonValue) => void;

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

interface AcpSessionState {
  andySessionId: string;
  cwd: string;
  cancellationTokenId?: string;
}

async function runAcpStdioServer(booted: BootedDaemon): Promise<void> {
  const sessions = new Map<string, AcpSessionState>();
  const lines = createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const write: JsonRpcWriter = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  for await (const line of lines) {
    await handleAcpLine(booted, sessions, line, write);
  }
}

async function startAcpSocketServer(booted: BootedDaemon) {
  const socketPath = getAcpSocketPath();
  if (platform() !== "win32") {
    await mkdir(dirname(socketPath), { recursive: true });
    await rm(socketPath, { force: true });
  }
  const sessions = new Map<string, AcpSessionState>();
  const server = createNetServer((socket) => {
    void handleAcpSocket(booted, sessions, socket);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  return server;
}

async function handleAcpSocket(
  booted: BootedDaemon,
  sessions: Map<string, AcpSessionState>,
  socket: Socket,
): Promise<void> {
  const lines = createInterface({
    input: socket,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const write: JsonRpcWriter = (message) => {
    socket.write(`${JSON.stringify(message)}\n`);
  };
  for await (const line of lines) {
    await handleAcpLine(booted, sessions, line, write);
  }
}

async function handleAcpLine(
  booted: BootedDaemon,
  sessions: Map<string, AcpSessionState>,
  line: string,
  write: JsonRpcWriter,
): Promise<void> {
  if (!line.trim()) {
    return;
  }

  let message: JsonRpcRequest;
  try {
    const parsed: unknown = JSON.parse(line);
    message = isJsonObject(parsed) ? (parsed as JsonRpcRequest) : {};
  } catch (cause) {
    write(jsonRpcError(null, -32700, "Parse error", stringifyUnknown(cause)));
    return;
  }

  if (typeof message.method !== "string") {
    if (message.id !== undefined) {
      write(jsonRpcError(message.id, -32600, "Invalid Request"));
    }
    return;
  }

  if (message.id === undefined) {
    await Effect.runPromise(
      handleAcpNotification(booted, sessions, message).pipe(
        Effect.catchAll((cause) =>
          Effect.sync(() =>
            console.error(
              JSON.stringify({
                ts: new Date().toISOString(),
                transport: "acp",
                error: stringifyUnknown(cause),
              }),
            ),
          ),
        ),
      ),
    );
    return;
  }

  const result = await Effect.runPromise(
    handleAcpRequest(booted, sessions, message, write).pipe(Effect.either),
  );
  if (result._tag === "Left") {
    write(jsonRpcError(message.id, -32000, stringifyUnknown(result.left)));
    return;
  }
  write(jsonRpcResult(message.id, result.right));
}

function handleAcpNotification(
  booted: BootedDaemon,
  sessions: Map<string, AcpSessionState>,
  message: JsonRpcRequest,
): Effect.Effect<void, unknown> {
  return Effect.fn("daemon.acp.notification")(function* () {
    if (message.method !== "session/cancel") {
      return;
    }
    const params = isJsonObject(message.params) ? message.params : {};
    const sessionId = optionalJsonString(params, "sessionId");
    if (!sessionId) {
      return;
    }
    const session = sessions.get(sessionId);
    if (!session?.cancellationTokenId) {
      return;
    }
    yield* booted.services.cancellation.cancel(
      session.cancellationTokenId,
      "ACP session cancellation requested by client.",
    );
  })();
}

function handleAcpRequest(
  booted: BootedDaemon,
  sessions: Map<string, AcpSessionState>,
  message: JsonRpcRequest,
  write: JsonRpcWriter,
): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("daemon.acp.request")(function* () {
    const method = message.method ?? "";
    switch (method) {
      case "initialize":
        return createAcpInitializeResponse(message.params);
      case "session/new":
        return yield* createAcpSession(booted, sessions, message.params);
      case "session/resume":
      case "session/load":
        return yield* resumeAcpSession(sessions, message.params);
      case "session/list":
        return listAcpSessions(booted);
      case "session/close":
        return yield* closeAcpSession(booted, sessions, message.params);
      case "session/prompt":
        return yield* promptAcpSession(booted, sessions, message.params, write);
      default:
        if (method.startsWith("andy.")) {
          return yield* handleTypedAcpAndyMethod(booted, method, message.params);
        }
        return yield* Effect.fail(new Error(`Unsupported ACP method '${method}'.`));
    }
  })();
}

function createAcpInitializeResponse(params: unknown): JsonValue {
  const requestedVersion = isJsonObject(params)
    ? optionalJsonString(params, "protocolVersion")
    : undefined;
  return {
    protocolVersion: requestedVersion ?? "1",
    agentInfo: {
      name: "Andy",
      version: "0.1.0",
    },
    agentCapabilities: {
      loadSession: true,
      mcpCapabilities: {
        http: false,
        sse: false,
      },
      promptCapabilities: {
        audio: false,
        embeddedContext: false,
        image: true,
      },
      sessionCapabilities: {
        list: true,
        resume: true,
        close: true,
      },
    },
    authMethods: [],
  };
}

function handleTypedAcpAndyMethod(
  booted: BootedDaemon,
  method: string,
  params: unknown,
): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("daemon.acp.typedAndyMethod")(function* () {
    const payload = isJsonObject(params) ? params : {};
    const query = readAcpQuery(payload);
    const body = readJsonProperty(payload, "body") ?? toJsonValue(payload);
    const id =
      optionalJsonString(payload, "id") ??
      optionalJsonString(payload, "pluginId") ??
      optionalJsonString(payload, "skillId") ??
      optionalJsonString(payload, "approvalId") ??
      optionalJsonString(payload, "providerId");
    const action = optionalJsonString(payload, "action");

    switch (method) {
      case "andy.health":
        return yield* typedDaemonRequest(booted, "GET", "/health", {}, query);
      case "andy.status":
        return yield* typedDaemonRequest(booted, "GET", "/status", {}, query);
      case "andy.config.get":
        return yield* typedDaemonRequest(booted, "GET", "/config", {}, query);
      case "andy.config.upsertModelProvider":
        return yield* typedDaemonRequest(
          booted,
          "POST",
          "/config/model-provider",
          body,
          query,
        );
      case "andy.config.setModelProviderEnabled":
        return yield* typedDaemonRequest(
          booted,
          "POST",
          `/config/model-provider/${encodeURIComponent(requireAcpId(id, method))}/${readAcpEnabledAction(payload)}`,
          {},
          query,
        );
      case "andy.config.updateRemoteControl":
        return yield* typedDaemonRequest(
          booted,
          "POST",
          "/config/remote-control",
          body,
          query,
        );
      case "andy.agent.run":
        return yield* typedDaemonRequest(booted, "POST", "/agent/run", body, query);
      case "andy.voice.turn":
        return yield* typedDaemonRequest(booted, "POST", "/voice/turn", body, query);
      case "andy.voice.stop":
        return yield* typedDaemonRequest(booted, "POST", "/voice/stop", {}, query);
      case "andy.plugins.list":
        return yield* typedDaemonRequest(booted, "GET", "/plugins", {}, query);
      case "andy.plugins.installLocal":
        return yield* typedDaemonRequest(
          booted,
          "POST",
          "/plugins/install-local",
          body,
          query,
        );
      case "andy.plugins.reviewLocal":
        return yield* typedDaemonRequest(
          booted,
          "POST",
          "/plugins/review-local",
          body,
          query,
        );
      case "andy.plugins.installGithub":
        return yield* typedDaemonRequest(
          booted,
          "POST",
          "/plugins/install-github",
          body,
          query,
        );
      case "andy.plugins.setEnabled":
        return yield* typedDaemonRequest(
          booted,
          "POST",
          `/plugins/${encodeURIComponent(requireAcpId(id, method))}/${readAcpEnabledAction(payload)}`,
          {},
          query,
        );
      case "andy.plugins.remove":
        return yield* typedDaemonRequest(
          booted,
          "POST",
          `/plugins/${encodeURIComponent(requireAcpId(id, method))}/remove`,
          {},
          query,
        );
      case "andy.plugins.restartCrashed":
        return yield* typedDaemonRequest(
          booted,
          "POST",
          "/plugins/restart-crashed",
          {},
          query,
        );
      case "andy.skills.list":
        return yield* typedDaemonRequest(booted, "GET", "/skills", {}, query);
      case "andy.skills.installLocal":
        return yield* typedDaemonRequest(
          booted,
          "POST",
          "/skills/install-local",
          body,
          query,
        );
      case "andy.skills.reviewLocal":
        return yield* typedDaemonRequest(
          booted,
          "POST",
          "/skills/review-local",
          body,
          query,
        );
      case "andy.skills.setEnabled":
        return yield* typedDaemonRequest(
          booted,
          "POST",
          `/skills/${encodeURIComponent(requireAcpId(id, method))}/${readAcpEnabledAction(payload)}`,
          {},
          query,
        );
      case "andy.skills.remove":
        return yield* typedDaemonRequest(
          booted,
          "POST",
          `/skills/${encodeURIComponent(requireAcpId(id, method))}/remove`,
          {},
          query,
        );
      case "andy.skills.run":
        return yield* typedDaemonRequest(
          booted,
          "POST",
          `/skills/${encodeURIComponent(requireAcpId(id, method))}/run`,
          body,
          query,
        );
      case "andy.approvals.list":
        return yield* typedDaemonRequest(booted, "GET", "/approvals", {}, query);
      case "andy.approvals.decide":
        return yield* typedDaemonRequest(
          booted,
          "POST",
          `/approvals/${encodeURIComponent(requireAcpId(id, method))}/${readAcpDecision(action, method)}`,
          {},
          query,
        );
      case "andy.events.query":
        return yield* typedDaemonRequest(booted, "GET", "/events", {}, query);
      case "andy.logs.query":
        return yield* typedDaemonRequest(booted, "GET", "/logs", {}, query);
      case "andy.traces.query":
        return yield* typedDaemonRequest(booted, "GET", "/traces", {}, query);
      case "andy.tasks.list":
        return toJsonValue(listDurableTasks(booted));
      case "andy.tasks.runSkill":
        return yield* typedDaemonRequest(
          booted,
          "POST",
          "/tasks/run-skill",
          body,
          query,
        );
      case "andy.memory.list":
        return yield* listStructuredMemory(booted, payload);
      case "andy.memory.approve":
        return yield* approveStructuredMemory(booted, requireAcpId(id, method));
      case "andy.memory.reject":
        return yield* rejectStructuredMemory(booted, requireAcpId(id, method));
      case "andy.memory.forget":
        return yield* forgetStructuredMemory(booted, requireAcpId(id, method));
      default:
        return yield* Effect.fail(new Error(`Unsupported ACP method '${method}'.`));
    }
  })();
}

function typedDaemonRequest(
  booted: BootedDaemon,
  method: string,
  path: string,
  body: JsonValue,
  query: Record<string, string>,
): Effect.Effect<JsonValue, unknown> {
  return handleDaemonApiRequest(booted, { method, path, body, query }).pipe(
    Effect.map(toJsonValue),
  );
}

function requireAcpId(id: string | undefined, method: string): string {
  if (!id) {
    throw new Error(`${method} requires an id.`);
  }
  return id;
}

function readAcpEnabledAction(payload: JsonObject): "enable" | "disable" {
  const action = optionalJsonString(payload, "action");
  if (action === "enable" || action === "disable") {
    return action;
  }
  const enabled = readJsonBoolean(payload, "enabled");
  return enabled === false ? "disable" : "enable";
}

function readAcpDecision(
  action: string | undefined,
  method: string,
): "approve" | "deny" {
  if (action === "approve" || action === "deny") {
    return action;
  }
  throw new Error(`${method} requires action approve or deny.`);
}

function readAcpQuery(payload: JsonObject): Record<string, string> {
  const queryValue = readJsonProperty(payload, "query");
  const source = isJsonObject(queryValue) ? queryValue : payload;
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      key !== "body" &&
      key !== "id" &&
      key !== "pluginId" &&
      key !== "skillId" &&
      key !== "approvalId" &&
      key !== "providerId" &&
      key !== "action" &&
      key !== "enabled" &&
      typeof value === "string"
    ) {
      query[key] = value;
    }
  }
  return query;
}

function createAcpSession(
  booted: BootedDaemon,
  sessions: Map<string, AcpSessionState>,
  params: unknown,
): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("daemon.acp.sessionNew")(function* () {
    const payload = isJsonObject(params) ? params : {};
    const cwd = optionalJsonString(payload, "cwd") ?? process.cwd();
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, {
      andySessionId: `acp:${sessionId}`,
      cwd,
    });
    yield* booted.services.saveState();
    return {
      sessionId,
      modes: null,
      configOptions: null,
    };
  })();
}

function resumeAcpSession(
  sessions: Map<string, AcpSessionState>,
  params: unknown,
): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("daemon.acp.sessionResume")(function* () {
    const payload = isJsonObject(params) ? params : {};
    const sessionId = optionalJsonString(payload, "sessionId");
    if (!sessionId) {
      return yield* Effect.fail(new Error("ACP sessionId is required."));
    }
    const cwd = optionalJsonString(payload, "cwd") ?? process.cwd();
    sessions.set(sessionId, {
      andySessionId: sessionId.startsWith("acp:") ? sessionId : `acp:${sessionId}`,
      cwd,
    });
    return {
      configOptions: null,
      modes: null,
    };
  })();
}

function listAcpSessions(booted: BootedDaemon): JsonValue {
  return {
    sessions: booted.services.sessions.list().map((session) => ({
      sessionId: session.id,
      updatedAt: session.updatedAt.toISOString(),
    })),
    nextCursor: null,
  };
}

function closeAcpSession(
  booted: BootedDaemon,
  sessions: Map<string, AcpSessionState>,
  params: unknown,
): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("daemon.acp.sessionClose")(function* () {
    const payload = isJsonObject(params) ? params : {};
    const sessionId = optionalJsonString(payload, "sessionId");
    if (!sessionId) {
      return yield* Effect.fail(new Error("ACP sessionId is required."));
    }
    const session = sessions.get(sessionId);
    if (session?.cancellationTokenId) {
      yield* booted.services.cancellation.cancel(
        session.cancellationTokenId,
        "ACP session closed.",
      );
    }
    sessions.delete(sessionId);
    return {};
  })();
}

function promptAcpSession(
  booted: BootedDaemon,
  sessions: Map<string, AcpSessionState>,
  params: unknown,
  write: JsonRpcWriter,
): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("daemon.acp.sessionPrompt")(function* () {
    const payload = isJsonObject(params) ? params : {};
    const sessionId = optionalJsonString(payload, "sessionId");
    if (!sessionId) {
      return yield* Effect.fail(new Error("ACP sessionId is required."));
    }
    const session =
      sessions.get(sessionId) ??
      ({
        andySessionId: `acp:${sessionId}`,
        cwd: process.cwd(),
      } satisfies AcpSessionState);
    const prompt = readJsonProperty(payload, "prompt");
    const normalized = normalizeAcpPrompt(prompt);
    const modelProviderId = selectAcpModelProvider(booted.config);
    const runner = yield* booted.services.modelProviders.createRunner(modelProviderId);
    const token = yield* booted.services.cancellation.create();
    sessions.set(sessionId, {
      ...session,
      cancellationTokenId: token.id,
    });
    const kernel = new AgentKernel({
      runtime: booted.services.runtime,
      llm: runner,
      audit: booted.services.audit,
      cancellation: booted.services.cancellation,
      sessionStore: booted.services.sessions,
    });
    const result = yield* Effect.either(
      kernel.run({
        sessionId: session.andySessionId,
        userMessage: normalized.text,
        channelId: "acp",
        conversationId: sessionId,
        cancellationTokenId: token.id,
        ...(normalized.images.length > 0 ? { images: normalized.images } : {}),
      }),
    );
    yield* booted.services.saveState();
    if (result._tag === "Left") {
      if (String(result.left).includes("cancelled")) {
        return { stopReason: "cancelled" };
      }
      return yield* Effect.fail(result.left);
    }
    write(
      jsonRpcNotification("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: result.right.response,
          },
        },
      }),
    );
    return { stopReason: "end_turn" };
  })();
}

function normalizeAcpPrompt(value: JsonValue | undefined): {
  text: string;
  images: { data: string; mediaType?: string }[];
} {
  const blocks = Array.isArray(value) ? value : [];
  const text: string[] = [];
  const images: { data: string; mediaType?: string }[] = [];
  for (const block of blocks) {
    if (!isJsonObject(block)) {
      continue;
    }
    const type = optionalJsonString(block, "type");
    if (type === "text") {
      const blockText = optionalJsonString(block, "text");
      if (blockText) {
        text.push(blockText);
      }
      continue;
    }
    if (type === "image") {
      const data =
        optionalJsonString(block, "data") ??
        optionalJsonString(block, "image") ??
        optionalJsonString(block, "imageBase64");
      const mediaType =
        optionalJsonString(block, "mediaType") ?? optionalJsonString(block, "mimeType");
      if (data) {
        images.push({
          data,
          ...(mediaType ? { mediaType } : {}),
        });
      }
      continue;
    }
    const uri = optionalJsonString(block, "uri");
    if (uri) {
      text.push(`Context resource: ${uri}`);
    }
  }
  return {
    text: text.join("\n\n").trim() || "Continue.",
    images,
  };
}

function selectAcpModelProvider(config: DaemonConfig): string {
  const provider = config.modelProviders.find((item) => item.enabled);
  if (!provider) {
    throw new Error(
      "No enabled model provider is configured. Enable an AI SDK provider before using ACP prompts.",
    );
  }
  return provider.id;
}

function jsonRpcResult(id: JsonRpcId | undefined, result: JsonValue): JsonValue {
  return {
    jsonrpc: "2.0",
    ...(id !== undefined ? { id } : {}),
    result,
  };
}

function jsonRpcError(
  id: JsonRpcId | undefined,
  code: number,
  message: string,
  data?: JsonValue | string,
): JsonValue {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

function jsonRpcNotification(method: string, params: JsonValue): JsonValue {
  return { jsonrpc: "2.0", method, params };
}

function toJsonValue(value: unknown): JsonValue {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  return isJsonValue(normalized) ? normalized : String(value);
}

function stringifyUnknown(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function startHttpServer(booted: BootedDaemon) {
  const server = createHttpServer((request, response) => {
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
    if (!url.pathname.startsWith("/webhooks/")) {
      writeJson(response, 404, {
        error: "http_disabled_for_local_clients",
        message:
          "Local daemon operations use ACP stdio. HTTP is only enabled for health checks and external webhook ingress.",
      });
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
    if (request.method === "GET" && url.pathname === "/events") {
      writeJson(response, 200, {
        events: queryEvents(booted, Object.fromEntries(url.searchParams)),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/logs") {
      writeJson(response, 200, {
        logs: queryEvents(booted, Object.fromEntries(url.searchParams)),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/traces") {
      writeJson(response, 200, {
        traces: queryTraces(booted, Object.fromEntries(url.searchParams)),
      });
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
      if (decision === "approve") {
        yield* completeTaskApproval(
          booted,
          approvalId,
          toJsonValue("output" in result ? result.output : result),
        );
      } else {
        yield* failTaskApproval(booted, approvalId, "Approval denied.");
      }
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

function handleDaemonApiRequest(
  booted: BootedDaemon,
  request: {
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: JsonValue;
  },
): Effect.Effect<unknown, unknown> {
  return Effect.fn("daemon.handleDaemonApiRequest")(function* () {
    const method = request.method.toUpperCase();
    const path = request.path;
    const body = request.body ?? {};
    const query = request.query ?? {};

    if (method === "GET" && path === "/health") {
      return { status: "ok" };
    }
    if (method === "GET" && path === "/status") {
      return createStatus(booted);
    }
    if (method === "GET" && path === "/config") {
      return { config: sanitizeConfig(booted.config) };
    }
    if (method === "GET" && path === "/events") {
      return { events: queryEvents(booted, query) };
    }
    if (method === "GET" && path === "/logs") {
      return { logs: queryEvents(booted, query) };
    }
    if (method === "GET" && path === "/traces") {
      return { traces: queryTraces(booted, query) };
    }
    if (method === "GET" && path === "/tasks") {
      return listDurableTasks(booted);
    }
    if (method === "POST" && path === "/config/model-provider") {
      return yield* upsertModelProviderConfig(booted, body);
    }
    const modelProviderActionMatch = path.match(
      /^\/config\/model-provider\/([^/]+)\/(enable|disable)$/,
    );
    if (method === "POST" && modelProviderActionMatch) {
      const [, providerId, action] = modelProviderActionMatch;
      if (!providerId || !action) {
        return yield* Effect.fail(new Error("not_found"));
      }
      return yield* setModelProviderEnabled(booted, providerId, action === "enable");
    }
    if (method === "POST" && path === "/config/remote-control") {
      return yield* updateRemoteControlConfig(booted, body);
    }
    if (method === "GET" && path === "/approvals") {
      return { approvals: booted.services.approvals.list() };
    }
    if (method === "GET" && path === "/plugins") {
      const plugins = yield* booted.pluginRegistry.list();
      return {
        plugins: plugins.map(serializeInstalledPlugin),
        hosts: booted.services.lifecycle.health(),
      };
    }
    if (method === "GET" && path === "/skills") {
      const skills = yield* booted.skillRegistry.list();
      return { skills: skills.map(serializeInstalledSkill) };
    }
    if (method === "POST" && path === "/agent/run") {
      return yield* runAgentRequest(booted, body);
    }
    if (method === "POST" && path === "/voice/turn") {
      const result = yield* Effect.either(runVoiceTurn(booted, body));
      if (result._tag === "Left") {
        if (String(result.left).includes("ToolApprovalRequiredError")) {
          yield* booted.services.saveState();
          return {
            status: "approval_required",
            approvals: booted.services.approvals.list(),
          };
        }
        return yield* Effect.fail(result.left);
      }
      return result.right;
    }
    if (method === "POST" && path === "/voice/stop") {
      const result = yield* booted.services.runtime.executeTool(
        "andy.voice.output.voice.stop",
        {},
      );
      return { output: result.output };
    }
    if (method === "POST" && path === "/plugins/install-local") {
      return yield* installLocalPlugin(booted, body);
    }
    if (method === "POST" && path === "/plugins/review-local") {
      return yield* reviewLocalPlugin(booted, body);
    }
    if (method === "POST" && path === "/plugins/install-github") {
      return yield* installGitHubPlugin(booted, body);
    }
    const pluginActionMatch = path.match(
      /^\/plugins\/([^/]+)\/(enable|disable|remove)$/,
    );
    if (method === "POST" && pluginActionMatch) {
      const [, pluginId, action] = pluginActionMatch;
      if (!pluginId || !action) {
        return yield* Effect.fail(new Error("not_found"));
      }
      return yield* mutatePluginLifecycle(booted, pluginId, action);
    }
    if (method === "POST" && path === "/plugins/restart-crashed") {
      const result = yield* booted.services.lifecycle.restartCrashed();
      yield* refreshInstalledPlugins(booted);
      yield* booted.services.saveState();
      return { plugins: result };
    }
    if (method === "POST" && path === "/skills/install-local") {
      return yield* installLocalSkill(booted, body);
    }
    if (method === "POST" && path === "/skills/review-local") {
      return yield* reviewLocalSkill(booted, body);
    }
    if (method === "POST" && path === "/tasks/run-skill") {
      return yield* runSkillWorkflow(booted, readTaskSkillId(body), body);
    }
    const skillActionMatch = path.match(/^\/skills\/([^/]+)\/(enable|disable|remove)$/);
    if (method === "POST" && skillActionMatch) {
      const [, skillId, action] = skillActionMatch;
      if (!skillId || !action) {
        return yield* Effect.fail(new Error("not_found"));
      }
      return yield* mutateSkillLifecycle(booted, skillId, action);
    }
    const skillRunMatch = path.match(/^\/skills\/([^/]+)\/run$/);
    if (method === "POST" && skillRunMatch) {
      const [, skillId] = skillRunMatch;
      if (!skillId) {
        return yield* Effect.fail(new Error("not_found"));
      }
      const result = yield* Effect.either(runSkillWorkflow(booted, skillId, body));
      if (result._tag === "Left") {
        if (String(result.left).includes("ToolApprovalRequiredError")) {
          yield* booted.services.saveState();
          return {
            status: "approval_required",
            approvals: booted.services.approvals.list(),
          };
        }
        return yield* Effect.fail(result.left);
      }
      return result.right;
    }
    const approvalMatch = path.match(/^\/approvals\/([^/]+)\/(approve|deny)$/);
    if (method === "POST" && approvalMatch) {
      const [, approvalId, decision] = approvalMatch;
      if (!approvalId || !decision) {
        return yield* Effect.fail(new Error("not_found"));
      }
      const result =
        decision === "approve"
          ? yield* booted.services.approvalResume.resumeApproved(approvalId)
          : yield* booted.services.approvalResume.deny(approvalId);
      if (decision === "approve") {
        yield* completeTaskApproval(
          booted,
          approvalId,
          toJsonValue("output" in result ? result.output : result),
        );
      } else {
        yield* failTaskApproval(booted, approvalId, "Approval denied.");
      }
      yield* booted.services.saveState();
      return { approvalId, decision, result };
    }

    return yield* Effect.fail(
      new Error(`Unsupported daemon API route ${method} ${path}`),
    );
  })();
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
    const installManifest = toInstallManifest(manifest, sourceRoot);
    const trust = yield* loadPluginTrust(installManifest, sourceRoot, booted.config);
    const existing = yield* Effect.either(booted.pluginRegistry.get(manifest.id));
    const plan = createInstallPlan(
      { type: "local", path: sourceRoot },
      installManifest,
      existing._tag === "Right" ? existing.right : undefined,
      { trust },
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
    const installManifest = toInstallManifest(manifest, sourceRoot);
    const trust = yield* loadPluginTrust(installManifest, sourceRoot, booted.config);
    const existing = yield* Effect.either(booted.pluginRegistry.get(manifest.id));
    const plan = createInstallPlan(
      { type: "local", path: sourceRoot },
      installManifest,
      existing._tag === "Right" ? existing.right : undefined,
      { trust },
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
    const installManifest = toInstallManifest(manifest, checkoutPath);
    const trust = yield* loadPluginTrust(installManifest, checkoutPath, booted.config);
    const plan = createInstallPlan(
      source,
      installManifest,
      existing._tag === "Right" ? existing.right : undefined,
      { trust },
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
    taskGraphId: string;
    taskRunId: string;
    status: DurableTaskRun["status"];
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
    const graph = yield* registerSkillTaskGraph(booted, record, workflow);
    const idempotencyKey = readSkillRunIdempotencyKey(body, skillId, workflow.name);
    const run = yield* booted.services.tasks.createRun({
      graphId: graph.id,
      input,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    const executed = yield* executeDurableTaskRun(booted, run.id);
    yield* booted.services.saveState();
    return {
      skillId,
      workflow: workflow.name,
      taskGraphId: graph.id,
      taskRunId: executed.id,
      status: executed.status,
      results: taskRunResults(graph, executed),
    };
  })();
}

function registerSkillTaskGraph(
  booted: BootedDaemon,
  skill: InstalledSkillRecord,
  workflow: SkillManifest["workflows"][number],
): Effect.Effect<DurableTaskGraph, Error> {
  return booted.services.tasks.registerGraph({
    id: `skill:${skill.manifest.id}:${workflow.name}:${skill.manifest.version}`,
    name: `${skill.manifest.id}/${workflow.name}`,
    version: skill.manifest.version,
    trigger: { type: "manual" },
    steps: workflow.steps.map((step, index): DurableTaskStepDefinition => {
      const previous = workflow.steps[index - 1];
      return {
        id: step.id,
        name: step.description ?? step.id,
        toolName: step.toolName,
        input: step.input,
        ...(previous ? { dependsOn: [previous.id] } : {}),
        metadata: {
          type: "skill.step",
          skillId: skill.manifest.id,
          workflow: workflow.name,
          ...(step.when ? { when: step.when } : {}),
          ...(step.forEach ? { forEach: step.forEach } : {}),
          ...(step.continueOnError ? { continueOnError: true } : {}),
          ...(step.saveAs ? { saveAs: step.saveAs } : {}),
        },
      };
    }),
  });
}

function executeDurableTaskRun(
  booted: BootedDaemon,
  runId: string,
): Effect.Effect<DurableTaskRun, unknown> {
  return Effect.fn("daemon.executeDurableTaskRun")(function* () {
    const holderId = `daemon:${process.pid}`;
    let latest = findTaskRun(booted, runId);
    while (latest.status !== "completed" && latest.status !== "failed") {
      const ready = yield* booted.services.tasks.readySteps(runId);
      if (ready.length === 0) {
        break;
      }
      for (const step of ready) {
        const leased = yield* booted.services.tasks.acquireLease({
          runId,
          stepId: step.id,
          holderId,
          leaseMs: 60_000,
        });
        if (!leased) {
          continue;
        }
        const graph = requireTaskGraph(booted, latest.graphId);
        const definition = requireTaskStepDefinition(graph, leased.definitionId);
        const stepResult = yield* executeDurableSkillStep(
          booted,
          graph,
          findTaskRun(booted, runId),
          leased.id,
          definition,
        );
        latest = stepResult;
        yield* booted.services.saveState();
        if (latest.status === "failed") {
          return latest;
        }
      }
      latest = findTaskRun(booted, runId);
    }
    return latest;
  })();
}

function executeDurableSkillStep(
  booted: BootedDaemon,
  graph: DurableTaskGraph,
  run: DurableTaskRun,
  leasedStepId: string,
  definition: DurableTaskStepDefinition,
): Effect.Effect<DurableTaskRun, unknown> {
  return Effect.fn("daemon.executeDurableSkillStep")(function* () {
    const context = createTaskRenderContext(graph, run);
    const metadata = isJsonObject(definition.metadata) ? definition.metadata : {};
    const when = optionalJsonString(metadata, "when");
    if (when && !readSkillCondition(when, context)) {
      const skipped = yield* booted.services.tasks.skipStep({
        runId: run.id,
        stepId: leasedStepId,
        reason: `Condition '${when}' evaluated false.`,
      });
      return skipped ?? findTaskRun(booted, run.id);
    }
    const forEach = optionalJsonString(metadata, "forEach");
    const eachValue = forEach ? readSkillPath(forEach, context) : undefined;
    const items = Array.isArray(eachValue) ? eachValue : [undefined];
    const outputs: JsonValue[] = [];
    for (const item of items) {
      if (item !== undefined) {
        context.vars.set("item", item);
      }
      const renderedInput = renderSkillTemplate(definition.input, context);
      if (!isJsonObject(renderedInput)) {
        throw new Error(
          `Task step '${definition.id}' did not render object input for '${definition.toolName}'.`,
        );
      }
      const result = yield* Effect.either(
        booted.services.runtime.executeTool(definition.toolName, renderedInput, {
          taskId: run.id,
        }),
      );
      if (result._tag === "Left") {
        const approvalId = readApprovalRequiredId(result.left);
        if (approvalId) {
          yield* booted.services.tasks.requireApproval({
            runId: run.id,
            stepId: leasedStepId,
            approvalId,
          });
          return findTaskRun(booted, run.id);
        }
        if (readJsonBoolean(metadata, "continueOnError")) {
          outputs.push({ error: String(result.left) });
          continue;
        }
        const failed = yield* booted.services.tasks.failStep({
          runId: run.id,
          stepId: leasedStepId,
          error: String(result.left),
        });
        return failed ?? findTaskRun(booted, run.id);
      }
      yield* indexStructuredMemoryOutput(
        booted,
        definition.toolName,
        result.right.output,
        run.id,
      );
      outputs.push(result.right.output);
    }
    context.vars.delete("item");
    const output = outputs.length === 1 ? outputs[0] : outputs;
    const completed = yield* booted.services.tasks.completeStep({
      runId: run.id,
      stepId: leasedStepId,
      ...(output !== undefined ? { output } : {}),
    });
    return completed ?? findTaskRun(booted, run.id);
  })();
}

function createTaskRenderContext(
  graph: DurableTaskGraph,
  run: DurableTaskRun,
): SkillRenderContext {
  const steps = new Map<string, JsonValue>();
  const vars = new Map<string, JsonValue>();
  for (const step of run.steps) {
    if (step.output !== undefined) {
      steps.set(step.definitionId, step.output);
      const definition = graph.steps.find((item) => item.id === step.definitionId);
      const metadata = isJsonObject(definition?.metadata) ? definition.metadata : {};
      const saveAs = optionalJsonString(metadata, "saveAs");
      if (saveAs) {
        vars.set(saveAs, step.output);
      }
    }
  }
  return { input: run.input, steps, vars };
}

function findTaskRun(booted: BootedDaemon, runId: string): DurableTaskRun {
  const run = booted.services.tasks.listRuns().find((item) => item.id === runId);
  if (!run) {
    throw new Error(`Task run '${runId}' not found.`);
  }
  return run;
}

function requireTaskGraph(booted: BootedDaemon, graphId: string): DurableTaskGraph {
  const graph = booted.services.tasks.getGraph(graphId);
  if (!graph) {
    throw new Error(`Task graph '${graphId}' not found.`);
  }
  return graph;
}

function requireTaskStepDefinition(
  graph: DurableTaskGraph,
  definitionId: string,
): DurableTaskStepDefinition {
  const definition = graph.steps.find((item) => item.id === definitionId);
  if (!definition) {
    throw new Error(`Task step definition '${definitionId}' not found.`);
  }
  return definition;
}

function taskRunResults(
  graph: DurableTaskGraph,
  run: DurableTaskRun,
): Array<{ stepId: string; toolName: string; output: JsonValue }> {
  return run.steps.flatMap((step) => {
    const definition = graph.steps.find((item) => item.id === step.definitionId);
    if (!definition || step.output === undefined) {
      return [];
    }
    return [
      { stepId: definition.id, toolName: definition.toolName, output: step.output },
    ];
  });
}

function listDurableTasks(booted: BootedDaemon) {
  return {
    graphs: booted.services.tasks.listGraphs().map(serializeTaskGraph),
    runs: booted.services.tasks.listRuns().map(serializeTaskRun),
  };
}

function listStructuredMemory(
  booted: BootedDaemon,
  params: JsonObject,
): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("daemon.listStructuredMemory")(function* () {
    const query: StructuredMemoryQuery = {};
    const type = optionalJsonString(params, "type");
    const subject = optionalJsonString(params, "subject");
    const sensitivity = optionalJsonString(params, "sensitivity");
    const visibility = optionalJsonString(params, "visibility");
    const text = optionalJsonString(params, "text");
    const limit = Number(optionalJsonString(params, "limit") ?? "");
    if (type && isStructuredMemoryType(type)) query.type = type;
    if (subject) query.subject = subject;
    if (sensitivity && isStructuredMemorySensitivity(sensitivity)) {
      query.sensitivity = sensitivity;
    }
    if (visibility && isStructuredMemoryVisibility(visibility)) {
      query.visibility = visibility;
    }
    if (text) query.text = text;
    if (Number.isInteger(limit) && limit > 0) query.limit = Math.min(limit, 200);
    const memories = yield* booted.structuredMemory.query(query);
    return toJsonValue({ memories: memories.map(serializeStructuredMemory) });
  })();
}

function approveStructuredMemory(
  booted: BootedDaemon,
  id: string,
): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("daemon.approveStructuredMemory")(function* () {
    const memory = yield* booted.structuredMemory.approve(id);
    yield* booted.services.saveState();
    return toJsonValue({ memory: memory ? serializeStructuredMemory(memory) : null });
  })();
}

function rejectStructuredMemory(
  booted: BootedDaemon,
  id: string,
): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("daemon.rejectStructuredMemory")(function* () {
    const rejected = yield* booted.structuredMemory.reject(id);
    yield* booted.services.saveState();
    return { rejected };
  })();
}

function forgetStructuredMemory(
  booted: BootedDaemon,
  id: string,
): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("daemon.forgetStructuredMemory")(function* () {
    const forgotten = yield* booted.structuredMemory.forget(id);
    yield* booted.services.saveState();
    return { forgotten };
  })();
}

function serializeStructuredMemory(record: StructuredMemoryRecord): JsonObject {
  const source = {
    channel: record.source.channel,
    ...(record.source.sessionId ? { sessionId: record.source.sessionId } : {}),
    ...(record.source.toolId ? { toolId: record.source.toolId } : {}),
    ...(record.source.documentId ? { documentId: record.source.documentId } : {}),
  } satisfies JsonObject;
  return {
    id: record.id,
    type: record.type,
    subject: record.subject,
    content: record.content,
    source,
    confidence: record.confidence,
    sensitivity: record.sensitivity,
    visibility: record.visibility,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    ...(record.expiresAt ? { expiresAt: record.expiresAt.toISOString() } : {}),
  };
}

function completeTaskApproval(
  booted: BootedDaemon,
  approvalId: string,
  output: JsonValue,
): Effect.Effect<void, unknown> {
  return Effect.fn("daemon.completeTaskApproval")(function* () {
    const match = findTaskStepByApproval(booted, approvalId);
    if (!match) {
      return;
    }
    const graph = requireTaskGraph(booted, match.run.graphId);
    const definition = requireTaskStepDefinition(graph, match.step.definitionId);
    yield* indexStructuredMemoryOutput(
      booted,
      definition.toolName,
      output,
      match.run.id,
    );
    yield* booted.services.tasks.completeStep({
      runId: match.run.id,
      stepId: match.step.id,
      output,
    });
    yield* executeDurableTaskRun(booted, match.run.id);
  })();
}

function failTaskApproval(
  booted: BootedDaemon,
  approvalId: string,
  error: string,
): Effect.Effect<void, unknown> {
  return Effect.fn("daemon.failTaskApproval")(function* () {
    const match = findTaskStepByApproval(booted, approvalId);
    if (!match) {
      return;
    }
    yield* booted.services.tasks.failStep({
      runId: match.run.id,
      stepId: match.step.id,
      error,
    });
  })();
}

function findTaskStepByApproval(
  booted: BootedDaemon,
  approvalId: string,
):
  | {
      run: DurableTaskRun;
      step: DurableTaskRun["steps"][number];
    }
  | undefined {
  for (const run of booted.services.tasks.listRuns()) {
    const step = run.steps.find((item) => item.approvalId === approvalId);
    if (step) {
      return { run, step };
    }
  }
  return undefined;
}

function indexStructuredMemoryOutput(
  booted: BootedDaemon,
  toolName: string,
  output: JsonValue,
  taskRunId: string,
): Effect.Effect<void, unknown> {
  return Effect.fn("daemon.indexStructuredMemoryOutput")(function* () {
    if (!isMemoryWriteTool(toolName) || !isJsonObject(output)) {
      return;
    }
    const id = optionalJsonString(output, "id");
    const namespace = optionalJsonString(output, "namespace") ?? "memory";
    const key = optionalJsonString(output, "key") ?? id ?? "memory";
    const value = readJsonProperty(output, "value");
    const source =
      optionalJsonString(output, "source") ??
      optionalJsonString(output, "trust") ??
      "andy";
    const tags = readJsonProperty(output, "tags");
    const sensitivity = inferMemorySensitivity(output);
    yield* booted.structuredMemory.save({
      ...(id ? { id } : {}),
      type: inferMemoryType(output, toolName, Array.isArray(tags) ? tags : []),
      subject: `${namespace}.${key}`,
      content: stringifyTemplateValue(value ?? output),
      source: {
        channel: "tool",
        sessionId: taskRunId,
        toolId: toolName,
        documentId: source,
      },
      confidence: inferMemoryConfidence(output),
      sensitivity,
      visibility: sensitivity === "high" ? "user-review-required" : "assistant",
    });
  })();
}

function isMemoryWriteTool(toolName: string): boolean {
  return toolName.endsWith(".memory.save") || toolName.endsWith(".memory.save_fact");
}

function inferMemoryType(
  output: JsonObject,
  toolName: string,
  tags: readonly unknown[],
): StructuredMemoryType {
  const explicit = optionalJsonString(output, "type");
  if (isStructuredMemoryType(explicit)) {
    return explicit;
  }
  if (toolName.endsWith(".memory.save_fact") || tags.includes("fact")) {
    return "fact";
  }
  return "preference";
}

function inferMemorySensitivity(output: JsonObject): StructuredMemorySensitivity {
  const explicit = optionalJsonString(output, "sensitivity");
  if (isStructuredMemorySensitivity(explicit)) {
    return explicit;
  }
  const scope = optionalJsonString(output, "scope");
  return scope === "user" ? "high" : "medium";
}

function inferMemoryConfidence(output: JsonObject): number {
  const confidence = readJsonProperty(output, "confidence");
  return typeof confidence === "number" ? confidence : 0.5;
}

function serializeTaskGraph(graph: DurableTaskGraph) {
  return {
    ...graph,
    createdAt: graph.createdAt.toISOString(),
    updatedAt: graph.updatedAt.toISOString(),
  };
}

function serializeTaskRun(run: DurableTaskRun) {
  return {
    ...run,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    steps: run.steps.map((step) => ({
      ...step,
      updatedAt: step.updatedAt.toISOString(),
      ...(step.runAfter ? { runAfter: step.runAfter.toISOString() } : {}),
      ...(step.lease
        ? {
            lease: {
              ...step.lease,
              expiresAt: step.lease.expiresAt.toISOString(),
            },
          }
        : {}),
    })),
  };
}

function readApprovalRequiredId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as { _tag?: unknown; approvalId?: unknown };
  return record._tag === "ToolApprovalRequiredError" &&
    typeof record.approvalId === "string"
    ? record.approvalId
    : undefined;
}

function readSkillRunIdempotencyKey(
  body: JsonValue,
  skillId: string,
  workflow: string,
): string | undefined {
  if (!isJsonObject(body)) {
    return undefined;
  }
  const idempotencyKey = optionalJsonString(body, "idempotencyKey");
  return idempotencyKey ? `${skillId}:${workflow}:${idempotencyKey}` : undefined;
}

function readTaskSkillId(body: JsonValue): string {
  if (!isJsonObject(body)) {
    throw new Error("skillId is required.");
  }
  const skillId = optionalJsonString(body, "skillId");
  if (!skillId) {
    throw new Error("skillId is required.");
  }
  return skillId;
}

function isStructuredMemoryType(
  value: string | undefined,
): value is StructuredMemoryType {
  return (
    value === "preference" ||
    value === "fact" ||
    value === "relationship" ||
    value === "project" ||
    value === "procedure" ||
    value === "episode"
  );
}

function isStructuredMemorySensitivity(
  value: string | undefined,
): value is StructuredMemorySensitivity {
  return value === "low" || value === "medium" || value === "high";
}

function isStructuredMemoryVisibility(
  value: string | undefined,
): value is StructuredMemoryRecord["visibility"] {
  return (
    value === "assistant" ||
    value === "user-review-required" ||
    value === "hidden-until-approved"
  );
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
          provenance?: unknown;
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
    const provenance = normalizeProvenanceLabels(payload.provenance);
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
      ...(provenance.length > 0 ? { provenance } : {}),
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

function normalizeProvenanceLabels(value: unknown): readonly ProvenanceLabel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): ProvenanceLabel[] => {
    if (!isJsonObject(item)) {
      return [];
    }
    const sourceId = optionalJsonString(item, "sourceId");
    const sourceType = optionalJsonString(item, "sourceType");
    const trust = optionalJsonString(item, "trust");
    const domain = optionalJsonString(item, "domain");
    if (!sourceId || !isProvenanceSourceType(sourceType) || !isTrustLevel(trust)) {
      return [];
    }
    return [
      {
        sourceId,
        sourceType,
        trust,
        ...(domain ? { domain } : {}),
      },
    ];
  });
}

function isProvenanceSourceType(
  value: string | undefined,
): value is ProvenanceLabel["sourceType"] {
  return (
    value === "user" ||
    value === "system" ||
    value === "browser" ||
    value === "email" ||
    value === "document" ||
    value === "calendar" ||
    value === "messaging" ||
    value === "file" ||
    value === "tool"
  );
}

function isTrustLevel(value: string | undefined): value is ProvenanceLabel["trust"] {
  return (
    value === "trusted_user" ||
    value === "trusted_system" ||
    value === "trusted_tool" ||
    value === "untrusted"
  );
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
    trust: plugin.trust ?? { signatureStatus: "unsigned" },
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
    trust: plan.trust,
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
