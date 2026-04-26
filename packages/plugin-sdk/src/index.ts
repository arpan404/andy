import type { AgentFileSystem } from "@andy/vfs";
import type { Effect } from "effect";
import { Schema } from "effect";

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
  execute(input: TInput, context: ToolContext): Effect.Effect<TOutput, unknown>;
}

export interface PluginDefinition {
  id: string;
  name: string;
  version: string;
  source?: PluginSource;
  capabilities: Capability[];
  permissions?: PluginPermissions;
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
  swarm?: SwarmManifest;
  memory?: MemoryManifest;
}

export interface PluginPermissions {
  network?: {
    allowedHosts: string[];
  };
  filesystem?: {
    readRoots?: string[];
    writeRoots?: string[];
    sensitiveReadRoots?: SensitiveFilesystemRoot[];
  };
}

export interface SwarmManifest {
  maxAgents: number;
  maxDepth: number;
  allowedAgentRoles: string[];
  allowedCapabilities: Capability[];
  requiresApprovalAboveAgents?: number;
}

export interface MemoryManifest {
  scopes: MemoryScope[];
  namespaces: string[];
  retention: "ephemeral" | "persistent" | "user_controlled";
  semanticSearch?: boolean;
  requiresApprovalForScopes?: MemoryScope[];
}

export type MemoryScope = "user" | "project" | "session" | "agent" | "plugin";

export interface SensitiveFilesystemRoot {
  path: string;
  reason: string;
  dataClasses: SensitiveDataClass[];
}

export type SensitiveDataClass =
  | "os"
  | "app_data"
  | "credentials"
  | "browser_profile"
  | "messages"
  | "contacts"
  | "calendar"
  | "photos"
  | "health"
  | "financial"
  | "other";

export class PluginToolCapabilityUndeclaredError extends Schema.TaggedError<PluginToolCapabilityUndeclaredError>()(
  "PluginToolCapabilityUndeclaredError",
  {
    pluginId: Schema.String,
    toolName: Schema.String,
    capability: Schema.String,
    message: Schema.String,
  },
) {}

export class PluginSensitiveFilesystemUndeclaredError extends Schema.TaggedError<PluginSensitiveFilesystemUndeclaredError>()(
  "PluginSensitiveFilesystemUndeclaredError",
  {
    pluginId: Schema.String,
    toolName: Schema.String,
    capability: Schema.String,
    message: Schema.String,
  },
) {}

export function assertManifestBoundPlugin(plugin: PluginDefinition): void {
  const declaredCapabilities = new Set(plugin.capabilities);

  for (const tool of plugin.tools) {
    for (const capability of tool.capabilities) {
      if (!declaredCapabilities.has(capability)) {
        throw new PluginToolCapabilityUndeclaredError({
          pluginId: plugin.id,
          toolName: tool.name,
          capability,
          message: `Plugin '${plugin.id}' tool '${tool.name}' requests undeclared capability '${capability}'.`,
        });
      }

      if (
        capability === "filesystem.read_sensitive" &&
        (plugin.permissions?.filesystem?.sensitiveReadRoots?.length ?? 0) === 0
      ) {
        throw new PluginSensitiveFilesystemUndeclaredError({
          pluginId: plugin.id,
          toolName: tool.name,
          capability,
          message: `Plugin '${plugin.id}' tool '${tool.name}' requests sensitive filesystem access without declaring permissions.filesystem.sensitiveReadRoots.`,
        });
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
