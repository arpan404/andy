import type { AuditSink } from "@andy/audit";
import {
  type PluginHostApi,
  PluginHostCapabilityDeniedError,
  PluginHostToolCallError,
} from "@andy/plugin-sdk";
import type { JsonObject, JsonValue } from "@andy/types";
import { Effect } from "effect";
import type { AgentRuntimeError } from "./errors.js";
import type { ToolExecutionResult } from "./types.js";
import { stringifyCause } from "./utils.js";

export interface PluginHostApiFactoryOptions {
  pluginId: string;
  runId: string;
  declaredCapabilities: ReadonlySet<string>;
  audit: AuditSink;
  executeTool(
    toolName: string,
    input: JsonValue,
  ): Effect.Effect<ToolExecutionResult, AgentRuntimeError>;
}

export function createPluginHostApi(
  options: PluginHostApiFactoryOptions,
): PluginHostApi {
  const requestCapability = Effect.fn("PluginHostApi.requestCapability")(function* (
    capability: string,
  ) {
    if (!options.declaredCapabilities.has(capability)) {
      return yield* Effect.fail(
        new PluginHostCapabilityDeniedError({
          pluginId: options.pluginId,
          capability,
          message: `Plugin '${options.pluginId}' requested undeclared capability '${capability}'.`,
        }),
      );
    }

    return { pluginId: options.pluginId, capability };
  });

  const callTool = Effect.fn("PluginHostApi.callTool")(function* (request: {
    capability: string;
    toolName: string;
    input: JsonValue;
  }) {
    yield* requestCapability(request.capability);
    yield* options.audit.record({
      type: "plugin.host_api.requested",
      pluginId: options.pluginId,
      runId: options.runId,
      capability: request.capability,
      toolName: request.toolName,
    });

    const result = yield* options.executeTool(request.toolName, request.input).pipe(
      Effect.mapError(
        (cause) =>
          new PluginHostToolCallError({
            pluginId: options.pluginId,
            toolName: request.toolName,
            message: `Plugin '${options.pluginId}' host API call to '${request.toolName}' failed.`,
            cause: stringifyCause(cause),
          }),
      ),
    );

    return result.output;
  });

  const forward = (capability: string, toolName: string, input: JsonObject) =>
    callTool({ capability, toolName, input });

  return {
    requestCapability,
    callTool,
    memory: {
      save: (input: JsonObject) => forward("memory.save", "memory.save", input),
      fetch: (input: JsonObject) => forward("memory.fetch", "memory.fetch", input),
      query: (input: JsonObject) => forward("memory.query", "memory.query", input),
      forget: (input: JsonObject) => forward("memory.forget", "memory.forget", input),
      list: (input: JsonObject) => forward("memory.list", "memory.list", input),
    },
    filesystem: {
      read: (input: JsonObject) => forward("filesystem.read", "filesystem.read", input),
      write: (input: JsonObject) =>
        forward("filesystem.write", "filesystem.write", input),
      delete: (input: JsonObject) =>
        forward("filesystem.delete", "filesystem.delete", input),
      list: (input: JsonObject) => forward("filesystem.read", "filesystem.list", input),
    },
    messaging: {
      send: (input: JsonObject) => forward("messaging.send", "messaging.send", input),
      receive: (input: JsonObject) =>
        forward("messaging.receive", "messaging.receive", input),
    },
    background: {
      run: (input: JsonObject) => forward("background.run", "background.run", input),
      schedule: (input: JsonObject) =>
        forward("background.schedule", "background.schedule", input),
      cancel: (input: JsonObject) =>
        forward("background.cancel", "background.cancel", input),
    },
    swarm: {
      spawn: (input: JsonObject) => forward("swarm.spawn", "swarm.spawn", input),
      delegate: (input: JsonObject) =>
        forward("swarm.delegate", "swarm.delegate", input),
      join: (input: JsonObject) => forward("swarm.join", "swarm.join", input),
      cancel: (input: JsonObject) => forward("swarm.cancel", "swarm.cancel", input),
    },
    secrets: {
      get: (input: JsonObject) => forward("secrets.get", "secrets.get", input),
    },
  };
}
