import type { AuditSink } from "@andy/audit";
import type { PluginDefinition, PluginManifest } from "@andy/plugin-sdk";
import { Effect } from "effect";
import type {
  ManifestPluginHost,
  PluginHostHandle,
  WorkerPluginHostHandle,
} from "./plugin-host.js";
import type { AgentRuntime } from "./runtime.js";
import type {
  PluginHostUnsupportedError,
  PluginRegistrationError,
  PluginSandboxError,
  ToolAlreadyRegisteredError,
  ToolHostPrivilegeDeniedError,
  ToolSandboxIncompatibleError,
} from "./errors.js";

export type ManagedPluginHostHandle = PluginHostHandle | WorkerPluginHostHandle;

export class PluginLifecycleManager {
  readonly #audit: AuditSink;
  readonly #runtime: AgentRuntime;
  readonly #host: ManifestPluginHost;
  readonly #handles = new Map<string, ManagedPluginHostHandle>();

  constructor(options: {
    audit: AuditSink;
    runtime: AgentRuntime;
    host: ManifestPluginHost;
  }) {
    this.#audit = options.audit;
    this.#runtime = options.runtime;
    this.#host = options.host;
  }

  start(
    manifest: PluginManifest,
  ): Effect.Effect<
    WorkerPluginHostHandle,
    | PluginHostUnsupportedError
    | PluginSandboxError
    | ToolSandboxIncompatibleError
    | PluginRegistrationError
    | ToolAlreadyRegisteredError
    | ToolHostPrivilegeDeniedError
  > {
    const self = this;
    return Effect.fn("PluginLifecycleManager.start")(function* () {
      const handle = yield* self.#host.startManifest(manifest);
      yield* self.#runtime
        .registerPlugin(handle.plugin)
        .pipe(Effect.tapError(() => handle.stop().pipe(Effect.ignore)));
      self.#handles.set(manifest.id, handle);
      yield* self.#audit.record({
        type: "plugin.lifecycle.started",
        pluginId: manifest.id,
        executionMode: handle.executionMode,
      });
      return handle;
    })();
  }

  registerTrusted(
    plugin: PluginDefinition,
  ): Effect.Effect<
    void,
    PluginRegistrationError | ToolAlreadyRegisteredError | ToolHostPrivilegeDeniedError
  > {
    const self = this;
    return Effect.fn("PluginLifecycleManager.registerTrusted")(function* () {
      yield* self.#runtime.registerPlugin(plugin);
      yield* self.#audit.record({
        type: "plugin.lifecycle.started",
        pluginId: plugin.id,
        executionMode: "trusted-in-process",
      });
    })();
  }

  stop(pluginId: string): Effect.Effect<void, PluginSandboxError> {
    const self = this;
    return Effect.fn("PluginLifecycleManager.stop")(function* () {
      const handle = self.#handles.get(pluginId);
      if (!handle) {
        return;
      }

      yield* handle.stop();
      self.#handles.delete(pluginId);
      yield* self.#audit.record({
        type: "plugin.lifecycle.stopped",
        pluginId,
        executionMode: handle.executionMode,
      });
    })();
  }

  stopAll(): Effect.Effect<void, PluginSandboxError> {
    const self = this;
    return Effect.fn("PluginLifecycleManager.stopAll")(function* () {
      for (const pluginId of [...self.#handles.keys()]) {
        yield* self.stop(pluginId);
      }
    })();
  }

  list(): readonly ManagedPluginHostHandle[] {
    return [...this.#handles.values()].sort((a, b) =>
      a.pluginId.localeCompare(b.pluginId),
    );
  }
}
