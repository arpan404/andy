import type { ToolDefinition } from "@andy/plugin-sdk";
import type { JsonValue } from "@andy/types";

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
