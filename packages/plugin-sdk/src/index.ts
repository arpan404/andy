import type { JsonObject, JsonValue } from "@andy/types";
import type { AgentFileSystem } from "@andy/vfs";
import type { Effect } from "effect";
import { Schema } from "effect";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type Capability = string;

export type ToolInput = JsonValue;

export type ToolOutput = JsonValue;

export interface ToolExecutionError {
  readonly _tag: string;
  readonly message: string;
}

export type PluginExecutionMode =
  | "metadata"
  | "trusted-in-process"
  | "subprocess"
  | "worker"
  | "container"
  | "remote";

export type PluginLifecycleStatus =
  | "installed"
  | "enabled"
  | "disabled"
  | "upgrading"
  | "removed";

export interface PluginCapabilityGrant {
  pluginId: string;
  capability: Capability;
}

export interface PluginStorageScope {
  kind: "ephemeral" | "persistent";
  namespace: string;
}

export interface PluginHostApi {
  requestCapability(
    capability: Capability,
  ): Effect.Effect<PluginCapabilityGrant, PluginHostCapabilityDeniedError>;
  callTool(
    request: PluginToolCallRequest,
  ): Effect.Effect<JsonValue, PluginHostApiError>;
  memory: PluginMemoryApi;
  filesystem: PluginFileSystemApi;
  messaging: PluginMessagingApi;
  background: PluginBackgroundApi;
  swarm: PluginSwarmApi;
  secrets: PluginSecretApi;
}

export interface PluginToolCallRequest {
  capability: Capability;
  toolName: string;
  input: JsonValue;
}

export interface PluginMemoryApi {
  save(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
  fetch(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
  query(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
  forget(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
  list(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
}

export interface PluginFileSystemApi {
  read(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
  write(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
  delete(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
  list(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
}

export interface PluginMessagingApi {
  send(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
  receive(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
}

export interface PluginBackgroundApi {
  run(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
  schedule(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
  cancel(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
}

export interface PluginSwarmApi {
  spawn(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
  delegate(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
  join(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
  cancel(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
}

export interface PluginSecretApi {
  get(input: JsonObject): Effect.Effect<JsonValue, PluginHostApiError>;
}

export interface ToolContext {
  pluginId: string;
  runId: string;
  host: PluginHostApi;
  storageFs: AgentFileSystem;
  scratchFs: AgentFileSystem;
}

export interface ToolDefinition<
  TInput extends ToolInput = ToolInput,
  TOutput extends ToolOutput = ToolOutput,
  TError extends ToolExecutionError = ToolExecutionError,
> {
  name: string;
  description: string;
  capabilities: Capability[];
  risk: RiskLevel;
  execute(input: TInput, context: ToolContext): Effect.Effect<TOutput, TError>;
}

export type AnyToolDefinition = ToolDefinition<
  ToolInput,
  ToolOutput,
  ToolExecutionError
>;

export interface PluginDefinition<
  TTools extends readonly AnyToolDefinition[] = readonly AnyToolDefinition[],
> {
  id: string;
  name: string;
  version: string;
  source?: PluginSource;
  capabilities: Capability[];
  permissions?: PluginPermissions;
  tools: TTools;
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
  executionMode?: PluginExecutionMode;
  source?: PluginSource;
  permissions?: PluginPermissions;
  swarm?: SwarmManifest;
  memory?: MemoryManifest;
}

export interface PluginPermissions {
  network?: {
    allowedHosts: string[];
  };
  secrets?: {
    scopes: string[];
  };
  storage?: {
    scopes: PluginStorageScope[];
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

export const PluginSourceSchema = Schema.Struct({
  type: Schema.Literal("local", "github", "marketplace"),
  reference: Schema.String,
});

export const SensitiveFilesystemRootSchema = Schema.Struct({
  path: Schema.String,
  reason: Schema.String,
  dataClasses: Schema.Array(
    Schema.Literal(
      "os",
      "app_data",
      "credentials",
      "browser_profile",
      "messages",
      "contacts",
      "calendar",
      "photos",
      "health",
      "financial",
      "other",
    ),
  ),
});

export const PluginManifestSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  entry: Schema.String,
  capabilities: Schema.Array(Schema.String),
  risk: Schema.Literal("low", "medium", "high", "critical"),
  executionMode: Schema.optional(
    Schema.Literal(
      "metadata",
      "trusted-in-process",
      "subprocess",
      "worker",
      "container",
      "remote",
    ),
  ),
  source: Schema.optional(PluginSourceSchema),
  permissions: Schema.optional(
    Schema.Struct({
      network: Schema.optional(
        Schema.Struct({
          allowedHosts: Schema.Array(Schema.String),
        }),
      ),
      secrets: Schema.optional(
        Schema.Struct({
          scopes: Schema.Array(Schema.String),
        }),
      ),
      storage: Schema.optional(
        Schema.Struct({
          scopes: Schema.Array(
            Schema.Struct({
              kind: Schema.Literal("ephemeral", "persistent"),
              namespace: Schema.String,
            }),
          ),
        }),
      ),
      filesystem: Schema.optional(
        Schema.Struct({
          readRoots: Schema.optional(Schema.Array(Schema.String)),
          writeRoots: Schema.optional(Schema.Array(Schema.String)),
          sensitiveReadRoots: Schema.optional(
            Schema.Array(SensitiveFilesystemRootSchema),
          ),
        }),
      ),
    }),
  ),
  swarm: Schema.optional(
    Schema.Struct({
      maxAgents: Schema.Number,
      maxDepth: Schema.Number,
      allowedAgentRoles: Schema.Array(Schema.String),
      allowedCapabilities: Schema.Array(Schema.String),
      requiresApprovalAboveAgents: Schema.optional(Schema.Number),
    }),
  ),
  memory: Schema.optional(
    Schema.Struct({
      scopes: Schema.Array(
        Schema.Literal("user", "project", "session", "agent", "plugin"),
      ),
      namespaces: Schema.Array(Schema.String),
      retention: Schema.Literal("ephemeral", "persistent", "user_controlled"),
      semanticSearch: Schema.optional(Schema.Boolean),
      requiresApprovalForScopes: Schema.optional(
        Schema.Array(Schema.Literal("user", "project", "session", "agent", "plugin")),
      ),
    }),
  ),
});

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

export class PluginHostCapabilityDeniedError extends Schema.TaggedError<PluginHostCapabilityDeniedError>()(
  "PluginHostCapabilityDeniedError",
  {
    pluginId: Schema.String,
    capability: Schema.String,
    message: Schema.String,
  },
) {}

export class PluginHostToolCallError extends Schema.TaggedError<PluginHostToolCallError>()(
  "PluginHostToolCallError",
  {
    pluginId: Schema.String,
    toolName: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.String),
  },
) {}

export type PluginHostApiError =
  | PluginHostCapabilityDeniedError
  | PluginHostToolCallError;

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

export function parsePluginManifest(input: unknown): PluginManifest {
  return Schema.decodeUnknownSync(PluginManifestSchema)(input) as PluginManifest;
}

export function defineTool<
  TInput extends ToolInput,
  TOutput extends ToolOutput,
  TError extends ToolExecutionError = never,
>(
  tool: ToolDefinition<TInput, TOutput, TError>,
): ToolDefinition<TInput, TOutput, TError> {
  return tool;
}

export function definePlugin<const TPlugin extends PluginDefinition>(
  plugin: TPlugin,
): TPlugin {
  assertManifestBoundPlugin(plugin);
  return plugin;
}
