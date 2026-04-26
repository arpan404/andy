import type { AuditEvent, AuditSink } from "@andy/audit";
import {
  assertManifestBoundPlugin,
  type AnyToolDefinition,
  type PluginDefinition,
} from "@andy/plugin-sdk";
import type { PolicyEngine } from "@andy/policy";
import { qualifyToolName } from "@andy/tool-catalog";
import type { JsonValue } from "@andy/types";
import {
  createScratchFileSystem,
  type AgentFileSystem,
  type MemoryFileSystemOptions,
} from "@andy/vfs";
import { Effect } from "effect";
import {
  type AgentRuntimeError,
  PluginDisabledError,
  PluginNotRegisteredError,
  PluginRegistrationError,
  ToolHostPrivilegeDeniedError,
  ToolApprovalRequiredError,
  ToolAlreadyRegisteredError,
  ToolNameAmbiguousError,
  ToolNotRegisteredError,
  ToolPolicyDeniedError,
} from "./errors.js";
import { ApprovalManager } from "./approvals.js";
import { toAiSdkToolName } from "./ai-tools.js";
import { createPluginHostApi } from "./host-api.js";
import type { RuntimeToolRecord, ToolExecutionResult } from "./types.js";
import { stringifyCause } from "./utils.js";

export interface AgentRuntimeOptions {
  audit: AuditSink;
  policy: PolicyEngine;
  scratchFs?: AgentFileSystem;
  approvalManager?: ApprovalManager;
  hostPrivilegePolicy?: HostPrivilegePolicy;
  pluginStorageFactory?: (pluginId: string) => AgentFileSystem;
}

export interface HostPrivilegePolicy {
  allowedPluginIds: ReadonlySet<string>;
  requireLocalSource?: boolean;
}

interface RegisteredTool {
  pluginId: string;
  qualifiedName: string;
  definition: AnyToolDefinition;
}

type PluginStatus = "enabled" | "disabled" | "removed";

interface RegisteredPlugin {
  definition: PluginDefinition;
  status: PluginStatus;
  storageFs: AgentFileSystem;
}

export interface PluginRuntimeRecord {
  pluginId: string;
  name: string;
  version: string;
  status: PluginStatus;
  toolCount: number;
}

export class AgentRuntime {
  readonly #audit: AuditSink;
  readonly #policy: PolicyEngine;
  readonly #approvalManager: ApprovalManager;
  readonly #hostPrivilegePolicy: HostPrivilegePolicy;
  readonly #scratchFs: AgentFileSystem;
  readonly #pluginStorageFactory: (pluginId: string) => AgentFileSystem;
  readonly #plugins = new Map<string, RegisteredPlugin>();
  readonly #tools = new Map<string, RegisteredTool>();
  readonly #aliases = new Map<string, Set<string>>();

  constructor(options: AgentRuntimeOptions) {
    this.#audit = options.audit;
    this.#policy = options.policy;
    this.#approvalManager =
      options.approvalManager ?? new ApprovalManager({ audit: options.audit });
    this.#hostPrivilegePolicy = options.hostPrivilegePolicy ?? {
      allowedPluginIds: new Set(),
      requireLocalSource: true,
    };
    this.#scratchFs = options.scratchFs ?? createScratchFileSystem();
    this.#pluginStorageFactory =
      options.pluginStorageFactory ??
      ((pluginId) => createPluginStorageFileSystem({ cwd: `/plugins/${pluginId}` }));
  }

  registerPlugin(
    plugin: PluginDefinition,
  ): Effect.Effect<
    void,
    PluginRegistrationError | ToolAlreadyRegisteredError | ToolHostPrivilegeDeniedError
  > {
    const self = this;
    return Effect.fn("AgentRuntime.registerPlugin")(function* () {
      yield* Effect.try({
        try: () => assertManifestBoundPlugin(plugin),
        catch: (cause) =>
          new PluginRegistrationError({
            pluginId: plugin.id,
            message: `Plugin '${plugin.id}' failed manifest validation.`,
            cause: stringifyCause(cause),
          }),
      });

      yield* self.#validateHostPrivilegedTools(plugin);

      const storageFs =
        self.#plugins.get(plugin.id)?.storageFs ??
        self.#pluginStorageFactory(plugin.id);
      self.#plugins.set(plugin.id, {
        definition: plugin,
        status: "enabled",
        storageFs,
      });

      for (const tool of plugin.tools) {
        const qualifiedName = qualifyToolName(plugin.id, tool.name);
        if (self.#tools.has(qualifiedName)) {
          return yield* Effect.fail(
            new ToolAlreadyRegisteredError({
              pluginId: plugin.id,
              toolName: qualifiedName,
              message: `Tool '${qualifiedName}' is already registered.`,
            }),
          );
        }

        self.#tools.set(qualifiedName, {
          pluginId: plugin.id,
          qualifiedName,
          definition: tool,
        });
        self.#addAlias(tool.name, qualifiedName);
      }

      yield* self.#audit.record({
        type: "plugin.registered",
        pluginId: plugin.id,
        toolCount: plugin.tools.length,
      });
    })();
  }

  #validateHostPrivilegedTools(
    plugin: PluginDefinition,
  ): Effect.Effect<void, ToolHostPrivilegeDeniedError> {
    const self = this;
    return Effect.fn("AgentRuntime.validateHostPrivilegedTools")(function* () {
      for (const tool of plugin.tools) {
        const requiresUnsandboxed =
          tool.sandbox?.isolation === "unsandboxed" ||
          tool.sandbox?.requiresHostPrivileges === true;
        if (!requiresUnsandboxed) {
          continue;
        }

        if (!self.#hostPrivilegePolicy.allowedPluginIds.has(plugin.id)) {
          return yield* Effect.fail(
            new ToolHostPrivilegeDeniedError({
              pluginId: plugin.id,
              toolName: tool.name,
              message: `Plugin '${plugin.id}' tool '${tool.name}' requires unsandboxed host privileges but the runtime did not allow this plugin.`,
            }),
          );
        }

        if (
          self.#hostPrivilegePolicy.requireLocalSource !== false &&
          plugin.source?.type !== "local"
        ) {
          return yield* Effect.fail(
            new ToolHostPrivilegeDeniedError({
              pluginId: plugin.id,
              toolName: tool.name,
              message: `Plugin '${plugin.id}' tool '${tool.name}' requires unsandboxed host privileges but is not installed from a local trusted source.`,
            }),
          );
        }
      }
    })();
  }

  enablePlugin(pluginId: string): Effect.Effect<void, PluginNotRegisteredError> {
    const self = this;
    return Effect.fn("AgentRuntime.enablePlugin")(function* () {
      const plugin = self.#plugins.get(pluginId);
      if (!plugin || plugin.status === "removed") {
        return yield* Effect.fail(
          new PluginNotRegisteredError({
            pluginId,
            message: `Plugin '${pluginId}' is not registered.`,
          }),
        );
      }

      self.#plugins.set(pluginId, { ...plugin, status: "enabled" });
      yield* self.#audit.record({ type: "plugin.enabled", pluginId });
    })();
  }

  disablePlugin(pluginId: string): Effect.Effect<void, PluginNotRegisteredError> {
    const self = this;
    return Effect.fn("AgentRuntime.disablePlugin")(function* () {
      const plugin = self.#plugins.get(pluginId);
      if (!plugin || plugin.status === "removed") {
        return yield* Effect.fail(
          new PluginNotRegisteredError({
            pluginId,
            message: `Plugin '${pluginId}' is not registered.`,
          }),
        );
      }

      self.#plugins.set(pluginId, { ...plugin, status: "disabled" });
      yield* self.#audit.record({ type: "plugin.disabled", pluginId });
    })();
  }

  removePlugin(pluginId: string): Effect.Effect<void, PluginNotRegisteredError> {
    const self = this;
    return Effect.fn("AgentRuntime.removePlugin")(function* () {
      const plugin = self.#plugins.get(pluginId);
      if (!plugin || plugin.status === "removed") {
        return yield* Effect.fail(
          new PluginNotRegisteredError({
            pluginId,
            message: `Plugin '${pluginId}' is not registered.`,
          }),
        );
      }

      for (const tool of plugin.definition.tools) {
        const qualifiedName = qualifyToolName(pluginId, tool.name);
        self.#tools.delete(qualifiedName);
        self.#removeAlias(tool.name, qualifiedName);
      }

      self.#plugins.set(pluginId, { ...plugin, status: "removed" });
      yield* self.#audit.record({ type: "plugin.removed", pluginId });
    })();
  }

  executeTool(
    toolName: string,
    input: JsonValue,
  ): Effect.Effect<ToolExecutionResult, AgentRuntimeError> {
    const self = this;
    return Effect.fn("AgentRuntime.executeTool")(function* () {
      const registeredTool =
        self.#tools.get(toolName) ?? (yield* self.#resolveAlias(toolName));
      if (!registeredTool) {
        return yield* Effect.fail(
          new ToolNotRegisteredError({
            toolName,
            message: `Tool '${toolName}' is not registered.`,
          }),
        );
      }
      const plugin = self.#plugins.get(registeredTool.pluginId);
      if (!plugin || plugin.status === "removed") {
        return yield* Effect.fail(
          new PluginNotRegisteredError({
            pluginId: registeredTool.pluginId,
            message: `Plugin '${registeredTool.pluginId}' is not registered.`,
          }),
        );
      }

      if (plugin.status !== "enabled") {
        return yield* Effect.fail(
          new PluginDisabledError({
            pluginId: registeredTool.pluginId,
            message: `Plugin '${registeredTool.pluginId}' is disabled.`,
          }),
        );
      }

      const runId = crypto.randomUUID();
      yield* self.#audit.record({ type: "tool.requested", runId, toolName });

      const decision = self.#policy.decide(registeredTool.definition, input, {
        pluginId: registeredTool.pluginId,
        risk: registeredTool.definition.risk,
      });
      const policyEvent: AuditEvent =
        "reason" in decision
          ? {
              type: "policy.decision",
              runId,
              toolName,
              decision: decision.type,
              reason: decision.reason,
            }
          : {
              type: "policy.decision",
              runId,
              toolName,
              decision: decision.type,
            };
      yield* self.#audit.record(policyEvent);

      if (decision.type === "ask") {
        const approval = yield* self.#approvalManager.create({
          runId,
          toolName,
          input,
          reason: decision.reason,
        });
        return yield* Effect.fail(
          new ToolApprovalRequiredError({
            approvalId: approval.id,
            toolName,
            reason: decision.reason,
            message: decision.reason,
          }),
        );
      }

      if (decision.type === "deny") {
        return yield* Effect.fail(
          new ToolPolicyDeniedError({
            toolName,
            reason: decision.reason,
            message: decision.reason,
          }),
        );
      }

      const output = yield* registeredTool.definition.execute(input, {
        pluginId: registeredTool.pluginId,
        runId,
        host: createPluginHostApi({
          pluginId: plugin.definition.id,
          runId,
          declaredCapabilities: new Set(plugin.definition.capabilities),
          audit: self.#audit,
          executeTool: (targetToolName, targetInput) =>
            self.executeTool(targetToolName, targetInput),
        }),
        storageFs: plugin.storageFs,
        scratchFs: self.#scratchFs,
      });

      yield* self.#audit.record({ type: "tool.completed", runId, toolName });

      return { runId, output };
    })();
  }

  listTools(): readonly RuntimeToolRecord[] {
    return [...this.#tools.values()]
      .map((tool) => {
        const aliasCount = this.#aliases.get(tool.definition.name)?.size ?? 0;
        const isLocalNameAmbiguous = aliasCount > 1;
        const record: RuntimeToolRecord = {
          name: tool.qualifiedName,
          qualifiedName: tool.qualifiedName,
          aiToolName: toAiSdkToolName(tool.qualifiedName),
          pluginId: tool.pluginId,
          localName: tool.definition.name,
          description: tool.definition.description,
          capabilities: tool.definition.capabilities,
          risk: tool.definition.risk,
          ...(tool.definition.inputSchema
            ? { inputSchema: tool.definition.inputSchema }
            : {}),
          ...(tool.definition.outputSchema
            ? { outputSchema: tool.definition.outputSchema }
            : {}),
          isLocalNameAmbiguous,
        };
        if (!isLocalNameAmbiguous) {
          record.localAlias = tool.definition.name;
        }

        return record;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  resolveModelToolName(modelToolName: string): string {
    return (
      this.listTools().find((tool) => tool.aiToolName === modelToolName)
        ?.qualifiedName ?? modelToolName
    );
  }

  listPlugins(): ReadonlyArray<PluginRuntimeRecord> {
    return [...this.#plugins.values()]
      .filter((plugin) => plugin.status !== "removed")
      .map((plugin) => ({
        pluginId: plugin.definition.id,
        name: plugin.definition.name,
        version: plugin.definition.version,
        status: plugin.status,
        toolCount: plugin.definition.tools.length,
      }))
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  }

  #addAlias(localName: string, qualifiedName: string): void {
    const existing = this.#aliases.get(localName) ?? new Set<string>();
    existing.add(qualifiedName);
    this.#aliases.set(localName, existing);
  }

  #removeAlias(localName: string, qualifiedName: string): void {
    const existing = this.#aliases.get(localName);
    if (!existing) {
      return;
    }

    existing.delete(qualifiedName);
    if (existing.size === 0) {
      this.#aliases.delete(localName);
      return;
    }

    this.#aliases.set(localName, existing);
  }

  #resolveAlias(
    toolName: string,
  ): Effect.Effect<RegisteredTool | undefined, ToolNameAmbiguousError> {
    const matches = [...(this.#aliases.get(toolName) ?? [])].sort();
    if (matches.length === 0) {
      return Effect.succeed(undefined);
    }

    if (matches.length > 1) {
      return Effect.fail(
        new ToolNameAmbiguousError({
          toolName,
          matches,
          message: `Tool '${toolName}' is ambiguous. Use a fully qualified tool name.`,
        }),
      );
    }

    const [qualifiedName] = matches;
    if (!qualifiedName) {
      return Effect.succeed(undefined);
    }

    return Effect.succeed(this.#tools.get(qualifiedName));
  }
}

function createPluginStorageFileSystem(
  options: MemoryFileSystemOptions,
): AgentFileSystem {
  return createScratchFileSystem(options);
}
