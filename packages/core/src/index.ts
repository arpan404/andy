import type { AuditSink } from "@andy/audit";
import {
  assertManifestBoundPlugin,
  type PluginDefinition,
  type ToolDefinition,
} from "@andy/plugin-sdk";
import type { PolicyEngine } from "@andy/policy";
import { createScratchFileSystem, type AgentFileSystem } from "@andy/vfs";
import { Effect, Schema } from "effect";

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

export class PluginRegistrationError extends Schema.TaggedError<PluginRegistrationError>()(
  "PluginRegistrationError",
  {
    pluginId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.String),
  },
) {}

export class ToolAlreadyRegisteredError extends Schema.TaggedError<ToolAlreadyRegisteredError>()(
  "ToolAlreadyRegisteredError",
  {
    pluginId: Schema.String,
    toolName: Schema.String,
    message: Schema.String,
  },
) {}

export class ToolNotRegisteredError extends Schema.TaggedError<ToolNotRegisteredError>()(
  "ToolNotRegisteredError",
  {
    toolName: Schema.String,
    message: Schema.String,
  },
) {}

export class ToolPolicyDeniedError extends Schema.TaggedError<ToolPolicyDeniedError>()(
  "ToolPolicyDeniedError",
  {
    toolName: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

export type AgentRuntimeError =
  | PluginRegistrationError
  | ToolAlreadyRegisteredError
  | ToolNotRegisteredError
  | ToolPolicyDeniedError
  | unknown;

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

  registerPlugin(
    plugin: PluginDefinition,
  ): Effect.Effect<void, PluginRegistrationError | ToolAlreadyRegisteredError> {
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

      for (const tool of plugin.tools) {
        if (self.#tools.has(tool.name)) {
          return yield* Effect.fail(
            new ToolAlreadyRegisteredError({
              pluginId: plugin.id,
              toolName: tool.name,
              message: `Tool '${tool.name}' is already registered.`,
            }),
          );
        }

        self.#tools.set(tool.name, {
          pluginId: plugin.id,
          definition: tool,
        });
      }

      yield* self.#audit.record({
        type: "plugin.registered",
        pluginId: plugin.id,
        toolCount: plugin.tools.length,
      });
    })();
  }

  executeTool<TOutput = unknown>(
    toolName: string,
    input: unknown,
  ): Effect.Effect<ToolExecutionResult<TOutput>, AgentRuntimeError> {
    const self = this;
    return Effect.fn("AgentRuntime.executeTool")(function* () {
      const registeredTool = self.#tools.get(toolName);
      if (!registeredTool) {
        return yield* Effect.fail(
          new ToolNotRegisteredError({
            toolName,
            message: `Tool '${toolName}' is not registered.`,
          }),
        );
      }

      const runId = crypto.randomUUID();
      yield* self.#audit.record({ type: "tool.requested", runId, toolName });

      const decision = self.#policy.decide(registeredTool.definition, input);
      yield* self.#audit.record({
        type: "policy.decision",
        runId,
        toolName,
        decision: decision.type,
        reason: "reason" in decision ? decision.reason : undefined,
      });

      if (decision.type === "deny" || decision.type === "ask") {
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
        scratchFs: self.#scratchFs,
      });

      yield* self.#audit.record({ type: "tool.completed", runId, toolName });

      return { runId, output: output as TOutput };
    })();
  }
}

function stringifyCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
