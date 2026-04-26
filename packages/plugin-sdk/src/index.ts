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
  source?: PluginSource;
  capabilities: Capability[];
  tools: ToolDefinition[];
}

export interface PluginSource {
  type: "local" | "github" | "marketplace";
  reference: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  capabilities: Capability[];
  risk: RiskLevel;
  source?: PluginSource;
  permissions?: PluginPermissions;
}

export interface PluginPermissions {
  network?: {
    allowedHosts: string[];
  };
  filesystem?: {
    readRoots?: string[];
    writeRoots?: string[];
  };
}

export function assertManifestBoundPlugin(plugin: PluginDefinition): void {
  const declaredCapabilities = new Set(plugin.capabilities);

  for (const tool of plugin.tools) {
    for (const capability of tool.capabilities) {
      if (!declaredCapabilities.has(capability)) {
        throw new Error(
          `Plugin '${plugin.id}' tool '${tool.name}' requests undeclared capability '${capability}'.`,
        );
      }
    }
  }
}

export function defineTool<TInput = unknown, TOutput = unknown>(
  tool: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  return tool;
}

export function definePlugin(plugin: PluginDefinition): PluginDefinition {
  assertManifestBoundPlugin(plugin);
  return plugin;
}
