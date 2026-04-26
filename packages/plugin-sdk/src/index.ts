import type { AgentFileSystem } from "@andy/vfs";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type Capability = string;

export interface ToolContext {
  pluginId: string;
  runId: string;
  scratchFs: AgentFileSystem;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  capabilities: Capability[];
  risk: RiskLevel;
  execute(input: TInput, context: ToolContext): Promise<TOutput> | TOutput;
}

export interface PluginDefinition {
  id: string;
  name: string;
  version: string;
  capabilities: Capability[];
  tools: ToolDefinition[];
}

export function defineTool<TInput = unknown, TOutput = unknown>(
  tool: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  return tool;
}

export function definePlugin(plugin: PluginDefinition): PluginDefinition {
  return plugin;
}
