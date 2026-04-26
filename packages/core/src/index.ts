import type { AuditSink } from "@andy/audit";
import {
  assertManifestBoundPlugin,
  type PluginDefinition,
  type ToolDefinition,
} from "@andy/plugin-sdk";
import type { PolicyEngine } from "@andy/policy";
import { createScratchFileSystem, type AgentFileSystem } from "@andy/vfs";

export interface AgentRuntimeOptions {
  audit: AuditSink;
  policy: PolicyEngine;
  scratchFs?: AgentFileSystem;
}

export interface ToolExecutionResult<TOutput = unknown> {
  runId: string;
  output: TOutput;
}

interface RegisteredTool {
  pluginId: string;
  definition: ToolDefinition;
}

export class AgentRuntime {
  readonly #audit: AuditSink;
  readonly #policy: PolicyEngine;
  readonly #scratchFs: AgentFileSystem;
  readonly #tools = new Map<string, RegisteredTool>();

  constructor(options: AgentRuntimeOptions) {
    this.#audit = options.audit;
    this.#policy = options.policy;
    this.#scratchFs = options.scratchFs ?? createScratchFileSystem();
  }

  registerPlugin(plugin: PluginDefinition): void {
    assertManifestBoundPlugin(plugin);

    for (const tool of plugin.tools) {
      if (this.#tools.has(tool.name)) {
        throw new Error(`Tool '${tool.name}' is already registered.`);
      }

      this.#tools.set(tool.name, {
        pluginId: plugin.id,
        definition: tool,
      });
    }

    void this.#audit.record({
      type: "plugin.registered",
      pluginId: plugin.id,
      toolCount: plugin.tools.length,
    });
  }

  async executeTool<TOutput = unknown>(
    toolName: string,
    input: unknown,
  ): Promise<ToolExecutionResult<TOutput>> {
    const registeredTool = this.#tools.get(toolName);
    if (!registeredTool) {
      throw new Error(`Tool '${toolName}' is not registered.`);
    }

    const runId = crypto.randomUUID();
    await this.#audit.record({ type: "tool.requested", runId, toolName });

    const decision = this.#policy.decide(registeredTool.definition, input);
    await this.#audit.record({
      type: "policy.decision",
      runId,
      toolName,
      decision: decision.type,
      reason: "reason" in decision ? decision.reason : undefined,
    });

    if (decision.type === "deny" || decision.type === "ask") {
      throw new Error(decision.reason);
    }

    const output = await registeredTool.definition.execute(input, {
      pluginId: registeredTool.pluginId,
      runId,
      scratchFs: this.#scratchFs,
    });

    await this.#audit.record({ type: "tool.completed", runId, toolName });

    return { runId, output: output as TOutput };
  }
}
