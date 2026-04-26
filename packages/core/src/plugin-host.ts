import type { AuditSink } from "@andy/audit";
import type { PluginDefinition, PluginExecutionMode } from "@andy/plugin-sdk";
import { Effect } from "effect";
import { PluginHostUnsupportedError } from "./errors.js";

export interface PluginHostHandle {
  pluginId: string;
  executionMode: PluginExecutionMode;
  stop(): Effect.Effect<void>;
}

export interface PluginHost {
  start(
    plugin: PluginDefinition,
  ): Effect.Effect<PluginHostHandle, PluginHostUnsupportedError>;
}

export class TrustedInProcessPluginHost implements PluginHost {
  readonly #audit: AuditSink;

  constructor(options: { audit: AuditSink }) {
    this.#audit = options.audit;
  }

  start(
    plugin: PluginDefinition,
  ): Effect.Effect<PluginHostHandle, PluginHostUnsupportedError> {
    const self = this;
    return Effect.fn("TrustedInProcessPluginHost.start")(function* () {
      const executionMode: PluginExecutionMode = "trusted-in-process";
      yield* self.#audit.record({
        type: "plugin.host.started",
        pluginId: plugin.id,
        executionMode,
      });
      const handle: PluginHostHandle = {
        pluginId: plugin.id,
        executionMode,
        stop: () =>
          self.#audit.record({
            type: "plugin.host.stopped",
            pluginId: plugin.id,
            executionMode,
          }),
      };
      return handle;
    })();
  }
}

export class UnsupportedSandboxPluginHost implements PluginHost {
  start(
    plugin: PluginDefinition,
  ): Effect.Effect<PluginHostHandle, PluginHostUnsupportedError> {
    return Effect.fail(
      new PluginHostUnsupportedError({
        pluginId: plugin.id,
        executionMode: "subprocess",
        message:
          "Sandboxed plugin host execution is not implemented yet. Use trusted in-process only for reviewed first-party development plugins.",
      }),
    );
  }
}
