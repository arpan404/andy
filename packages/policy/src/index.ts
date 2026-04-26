import type { ToolDefinition } from "@andy/plugin-sdk";

export type PolicyDecision =
  | { type: "allow" }
  | { type: "deny"; reason: string }
  | { type: "ask"; reason: string };

export interface PolicyEngine {
  decide(tool: ToolDefinition, input: unknown): PolicyDecision;
}

export interface CapabilityPolicyOptions {
  allowedCapabilities: Set<string>;
  approvalRequiredCapabilities?: Set<string>;
}

export class CapabilityPolicy implements PolicyEngine {
  readonly #allowedCapabilities: Set<string>;
  readonly #approvalRequiredCapabilities: Set<string>;

  constructor(options: CapabilityPolicyOptions) {
    this.#allowedCapabilities = options.allowedCapabilities;
    this.#approvalRequiredCapabilities =
      options.approvalRequiredCapabilities ?? new Set();
  }

  decide(tool: ToolDefinition): PolicyDecision {
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
