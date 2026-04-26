import type { ToolDefinition } from "@andy/plugin-sdk";
import type { JsonValue } from "@andy/types";
import { Effect } from "effect";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type PolicyDecision =
  | { type: "allow" }
  | { type: "deny"; reason: string }
  | { type: "ask"; reason: string };

export interface PolicyContext {
  pluginId?: string;
  userId?: string;
  channelId?: string;
  sessionId?: string;
  taskId?: string;
  risk?: string;
}

export interface PolicyEngine {
  decide(
    tool: ToolDefinition,
    input: JsonValue,
    context?: PolicyContext,
  ): PolicyDecision;
}

export interface CapabilityPolicyOptions {
  allowedCapabilities: Set<string>;
  approvalRequiredCapabilities?: Set<string>;
  deniedPlugins?: Set<string>;
  approvalRequiredChannels?: Set<string>;
}

export interface PolicyRule {
  id: string;
  effect: "allow" | "deny" | "ask";
  reason: string;
  capabilities?: ReadonlySet<string>;
  pluginIds?: ReadonlySet<string>;
  userIds?: ReadonlySet<string>;
  channelIds?: ReadonlySet<string>;
  risks?: ReadonlySet<string>;
  taskIds?: ReadonlySet<string>;
}

export interface TemporaryPolicyGrant {
  id: string;
  pluginId?: string;
  capability: string;
  taskId?: string;
  userId?: string;
  channelId?: string;
  expiresAt: Date;
}

export interface PolicyConfig {
  allowedCapabilities: readonly string[];
  approvalRequiredCapabilities?: readonly string[];
  deniedPlugins?: readonly string[];
  approvalRequiredChannels?: readonly string[];
  approvalRequiredRisks?: readonly string[];
  rules?: readonly SerializedPolicyRule[];
  grants?: readonly SerializedTemporaryPolicyGrant[];
}

export interface SerializedPolicyRule {
  id: string;
  effect: "allow" | "deny" | "ask";
  reason: string;
  capabilities?: readonly string[];
  pluginIds?: readonly string[];
  userIds?: readonly string[];
  channelIds?: readonly string[];
  risks?: readonly string[];
  taskIds?: readonly string[];
}

export interface SerializedTemporaryPolicyGrant {
  id: string;
  pluginId?: string;
  capability: string;
  taskId?: string;
  userId?: string;
  channelId?: string;
  expiresAt: string;
}

export class CapabilityPolicy implements PolicyEngine {
  readonly #allowedCapabilities: Set<string>;
  readonly #approvalRequiredCapabilities: Set<string>;
  readonly #deniedPlugins: Set<string>;
  readonly #approvalRequiredChannels: Set<string>;

  constructor(options: CapabilityPolicyOptions) {
    this.#allowedCapabilities = options.allowedCapabilities;
    this.#approvalRequiredCapabilities =
      options.approvalRequiredCapabilities ?? new Set();
    this.#deniedPlugins = options.deniedPlugins ?? new Set();
    this.#approvalRequiredChannels = options.approvalRequiredChannels ?? new Set();
  }

  decide(
    tool: ToolDefinition,
    _input: JsonValue,
    context: PolicyContext = {},
  ): PolicyDecision {
    if (context.pluginId && this.#deniedPlugins.has(context.pluginId)) {
      return {
        type: "deny",
        reason: `Plugin '${context.pluginId}' is denied by policy.`,
      };
    }

    if (context.channelId && this.#approvalRequiredChannels.has(context.channelId)) {
      return {
        type: "ask",
        reason: `Channel '${context.channelId}' requires approval.`,
      };
    }

    for (const capability of tool.capabilities) {
      if (!this.#allowedCapabilities.has(capability)) {
        return {
          type: "deny",
          reason: `Capability '${capability}' is not allowed.`,
        };
      }

      if (this.#approvalRequiredCapabilities.has(capability)) {
        return {
          type: "ask",
          reason: `Capability '${capability}' requires approval.`,
        };
      }
    }

    return { type: "allow" };
  }
}

export class RulePolicy implements PolicyEngine {
  readonly #fallback: PolicyEngine;
  readonly #rules: readonly PolicyRule[];
  readonly #grants: readonly TemporaryPolicyGrant[];

  constructor(options: {
    fallback: PolicyEngine;
    rules: readonly PolicyRule[];
    grants?: readonly TemporaryPolicyGrant[];
  }) {
    this.#fallback = options.fallback;
    this.#rules = options.rules;
    this.#grants = options.grants ?? [];
  }

  decide(
    tool: ToolDefinition,
    input: JsonValue,
    context: PolicyContext = {},
  ): PolicyDecision {
    const grant = this.#grants.find((item) => matchesGrant(item, tool, context));
    if (grant) {
      return { type: "allow" };
    }

    for (const rule of this.#rules) {
      if (matchesRule(rule, tool, context)) {
        if (rule.effect === "allow") {
          return { type: "allow" };
        }

        return {
          type: rule.effect,
          reason: rule.reason,
        };
      }
    }

    return this.#fallback.decide(tool, input, context);
  }
}

export class RiskThresholdPolicy implements PolicyEngine {
  readonly #fallback: PolicyEngine;
  readonly #approvalRequiredRisks: ReadonlySet<string>;

  constructor(options: {
    fallback: PolicyEngine;
    approvalRequiredRisks: ReadonlySet<string>;
  }) {
    this.#fallback = options.fallback;
    this.#approvalRequiredRisks = options.approvalRequiredRisks;
  }

  decide(
    tool: ToolDefinition,
    input: JsonValue,
    context: PolicyContext = {},
  ): PolicyDecision {
    const risk = context.risk ?? tool.risk;
    if (this.#approvalRequiredRisks.has(risk)) {
      return {
        type: "ask",
        reason: `Risk level '${risk}' requires approval.`,
      };
    }
    return this.#fallback.decide(tool, input, context);
  }
}

export function createPolicyEngineFromConfig(config: PolicyConfig): PolicyEngine {
  const fallback = new CapabilityPolicy({
    allowedCapabilities: new Set(config.allowedCapabilities),
    approvalRequiredCapabilities: new Set(config.approvalRequiredCapabilities ?? []),
    deniedPlugins: new Set(config.deniedPlugins ?? []),
    approvalRequiredChannels: new Set(config.approvalRequiredChannels ?? []),
  });
  const riskPolicy = new RiskThresholdPolicy({
    fallback,
    approvalRequiredRisks: new Set(config.approvalRequiredRisks ?? []),
  });
  return new RulePolicy({
    fallback: riskPolicy,
    rules: (config.rules ?? []).map(deserializeRule),
    grants: (config.grants ?? []).map(deserializeGrant),
  });
}

export class JsonFilePolicyStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  load(fallback: PolicyConfig): Effect.Effect<PolicyConfig, unknown> {
    const self = this;
    return Effect.fn("JsonFilePolicyStore.load")(function* () {
      const loaded = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await readFile(self.#path, "utf8");
          } catch (cause) {
            if (isFileNotFound(cause)) {
              return undefined;
            }
            throw cause;
          }
        },
        catch: (cause) => cause,
      });
      if (loaded === undefined) {
        yield* self.save(fallback);
        return fallback;
      }
      return normalizePolicyConfig(JSON.parse(loaded), fallback);
    })();
  }

  save(config: PolicyConfig): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.fn("JsonFilePolicyStore.save")(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(self.#path), { recursive: true });
          const tempPath = `${self.#path}.${process.pid}.${crypto.randomUUID()}.tmp`;
          await writeFile(
            tempPath,
            `${JSON.stringify(
              {
                schemaVersion: 1,
                value: config,
              },
              null,
              2,
            )}\n`,
            "utf8",
          );
          await rename(tempPath, self.#path);
        },
        catch: (cause) => cause,
      });
    })();
  }
}

function matchesRule(
  rule: PolicyRule,
  tool: ToolDefinition,
  context: PolicyContext,
): boolean {
  if (
    rule.capabilities &&
    !tool.capabilities.some((capability) => rule.capabilities?.has(capability))
  ) {
    return false;
  }

  if (rule.pluginIds && (!context.pluginId || !rule.pluginIds.has(context.pluginId))) {
    return false;
  }

  if (rule.userIds && (!context.userId || !rule.userIds.has(context.userId))) {
    return false;
  }

  if (
    rule.channelIds &&
    (!context.channelId || !rule.channelIds.has(context.channelId))
  ) {
    return false;
  }

  if (rule.risks && (!context.risk || !rule.risks.has(context.risk))) {
    return false;
  }

  if (rule.taskIds && (!context.taskId || !rule.taskIds.has(context.taskId))) {
    return false;
  }

  return true;
}

function matchesGrant(
  grant: TemporaryPolicyGrant,
  tool: ToolDefinition,
  context: PolicyContext,
): boolean {
  if (grant.expiresAt.getTime() <= Date.now()) {
    return false;
  }

  if (!tool.capabilities.includes(grant.capability)) {
    return false;
  }

  if (grant.pluginId && grant.pluginId !== context.pluginId) {
    return false;
  }

  if (grant.taskId && grant.taskId !== context.taskId) {
    return false;
  }

  if (grant.userId && grant.userId !== context.userId) {
    return false;
  }

  if (grant.channelId && grant.channelId !== context.channelId) {
    return false;
  }

  return true;
}

function deserializeRule(rule: SerializedPolicyRule): PolicyRule {
  return {
    id: rule.id,
    effect: rule.effect,
    reason: rule.reason,
    ...(rule.capabilities ? { capabilities: new Set(rule.capabilities) } : {}),
    ...(rule.pluginIds ? { pluginIds: new Set(rule.pluginIds) } : {}),
    ...(rule.userIds ? { userIds: new Set(rule.userIds) } : {}),
    ...(rule.channelIds ? { channelIds: new Set(rule.channelIds) } : {}),
    ...(rule.risks ? { risks: new Set(rule.risks) } : {}),
    ...(rule.taskIds ? { taskIds: new Set(rule.taskIds) } : {}),
  };
}

function deserializeGrant(grant: SerializedTemporaryPolicyGrant): TemporaryPolicyGrant {
  return {
    id: grant.id,
    capability: grant.capability,
    expiresAt: new Date(grant.expiresAt),
    ...(grant.pluginId ? { pluginId: grant.pluginId } : {}),
    ...(grant.taskId ? { taskId: grant.taskId } : {}),
    ...(grant.userId ? { userId: grant.userId } : {}),
    ...(grant.channelId ? { channelId: grant.channelId } : {}),
  };
}

function normalizePolicyConfig(value: unknown, fallback: PolicyConfig): PolicyConfig {
  const maybeEnvelope =
    typeof value === "object" && value !== null && "value" in value
      ? (value as { value?: unknown }).value
      : value;
  const record =
    typeof maybeEnvelope === "object" && maybeEnvelope !== null
      ? (maybeEnvelope as Partial<PolicyConfig>)
      : {};
  const config: PolicyConfig = {
    allowedCapabilities: Array.isArray(record.allowedCapabilities)
      ? record.allowedCapabilities.filter(
          (item): item is string => typeof item === "string",
        )
      : fallback.allowedCapabilities,
    ...(Array.isArray(record.approvalRequiredCapabilities)
      ? {
          approvalRequiredCapabilities: record.approvalRequiredCapabilities.filter(
            (item): item is string => typeof item === "string",
          ),
        }
      : fallback.approvalRequiredCapabilities
        ? { approvalRequiredCapabilities: fallback.approvalRequiredCapabilities }
        : {}),
    ...(Array.isArray(record.deniedPlugins)
      ? {
          deniedPlugins: record.deniedPlugins.filter(
            (item): item is string => typeof item === "string",
          ),
        }
      : fallback.deniedPlugins
        ? { deniedPlugins: fallback.deniedPlugins }
        : {}),
    ...(Array.isArray(record.approvalRequiredChannels)
      ? {
          approvalRequiredChannels: record.approvalRequiredChannels.filter(
            (item): item is string => typeof item === "string",
          ),
        }
      : fallback.approvalRequiredChannels
        ? { approvalRequiredChannels: fallback.approvalRequiredChannels }
        : {}),
    ...(Array.isArray(record.approvalRequiredRisks)
      ? {
          approvalRequiredRisks: record.approvalRequiredRisks.filter(
            (item): item is string => typeof item === "string",
          ),
        }
      : fallback.approvalRequiredRisks
        ? { approvalRequiredRisks: fallback.approvalRequiredRisks }
        : {}),
    ...(Array.isArray(record.rules)
      ? { rules: record.rules.flatMap(parseSerializedRule) }
      : fallback.rules
        ? { rules: fallback.rules }
        : {}),
    ...(Array.isArray(record.grants)
      ? { grants: record.grants.flatMap(parseSerializedGrant) }
      : fallback.grants
        ? { grants: fallback.grants }
        : {}),
  };
  return config;
}

function parseSerializedRule(value: unknown): SerializedPolicyRule[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Partial<SerializedPolicyRule>;
  if (
    typeof record.id !== "string" ||
    typeof record.reason !== "string" ||
    !isRuleEffect(record.effect)
  ) {
    return [];
  }
  return [
    {
      id: record.id,
      effect: record.effect,
      reason: record.reason,
      ...(Array.isArray(record.capabilities)
        ? { capabilities: record.capabilities.filter(isString) }
        : {}),
      ...(Array.isArray(record.pluginIds)
        ? { pluginIds: record.pluginIds.filter(isString) }
        : {}),
      ...(Array.isArray(record.userIds)
        ? { userIds: record.userIds.filter(isString) }
        : {}),
      ...(Array.isArray(record.channelIds)
        ? { channelIds: record.channelIds.filter(isString) }
        : {}),
      ...(Array.isArray(record.risks) ? { risks: record.risks.filter(isString) } : {}),
      ...(Array.isArray(record.taskIds)
        ? { taskIds: record.taskIds.filter(isString) }
        : {}),
    },
  ];
}

function parseSerializedGrant(value: unknown): SerializedTemporaryPolicyGrant[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Partial<SerializedTemporaryPolicyGrant>;
  if (
    typeof record.id !== "string" ||
    typeof record.capability !== "string" ||
    typeof record.expiresAt !== "string"
  ) {
    return [];
  }
  return [
    {
      id: record.id,
      capability: record.capability,
      expiresAt: record.expiresAt,
      ...(typeof record.pluginId === "string" ? { pluginId: record.pluginId } : {}),
      ...(typeof record.taskId === "string" ? { taskId: record.taskId } : {}),
      ...(typeof record.userId === "string" ? { userId: record.userId } : {}),
      ...(typeof record.channelId === "string" ? { channelId: record.channelId } : {}),
    },
  ];
}

function isRuleEffect(value: unknown): value is SerializedPolicyRule["effect"] {
  return value === "allow" || value === "deny" || value === "ask";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFileNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}
