import type { AuditSink } from "@andy/audit";
import type { PluginDefinition, PluginManifest } from "@andy/plugin-sdk";
import { Effect } from "effect";
import type {
  ManifestPluginHost,
  PluginHostHandle,
  PluginHostHealth,
  WorkerPluginHostHandle,
} from "./plugin-host.js";
import type { AgentRuntime } from "./runtime.js";
import type {
  PluginHostUnsupportedError,
  PluginNotRegisteredError,
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
  readonly #manifests = new Map<string, PluginManifest>();

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
    | PluginNotRegisteredError
  > {
    const self = this;
    return Effect.fn("PluginLifecycleManager.start")(function* () {
      if (self.#handles.has(manifest.id)) {
        yield* self.stop(manifest.id);
      }
      const handle = yield* self.#host.startManifest(manifest);
      const existing = self.#runtime
        .listPlugins()
        .find((plugin) => plugin.pluginId === manifest.id);
      if (existing) {
        yield* self.#runtime.enablePlugin(manifest.id);
      } else {
        yield* self.#runtime
          .registerPlugin(handle.plugin)
          .pipe(Effect.tapError(() => handle.stop().pipe(Effect.ignore)));
      }
      self.#handles.set(manifest.id, handle);
      self.#manifests.set(manifest.id, manifest);
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
        yield* self.#runtime.disablePlugin(pluginId).pipe(Effect.ignore);
        return;
      }

      yield* self.#runtime.disablePlugin(pluginId).pipe(Effect.ignore);
      yield* handle.stop();
      self.#handles.delete(pluginId);
      self.#manifests.delete(pluginId);
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

  health(): readonly PluginHostHealth[] {
    return this.list().map((handle) => handle.health());
  }

  restartCrashed(): Effect.Effect<
    readonly {
      pluginId: string;
      status: "restarted" | "disabled";
      reason?: string;
    }[],
    | PluginHostUnsupportedError
    | PluginSandboxError
    | ToolSandboxIncompatibleError
    | PluginRegistrationError
    | ToolAlreadyRegisteredError
    | ToolHostPrivilegeDeniedError
    | PluginNotRegisteredError
  > {
    const self = this;
    return Effect.fn("PluginLifecycleManager.restartCrashed")(function* () {
      const results: {
        pluginId: string;
        status: "restarted" | "disabled";
        reason?: string;
      }[] = [];
      for (const handle of self.list()) {
        const health = handle.health();
        if (health.status !== "crashed") {
          continue;
        }

        const manifest = self.#manifests.get(handle.pluginId);
        if (!manifest) {
          yield* self.#runtime.disablePlugin(handle.pluginId).pipe(Effect.ignore);
          self.#handles.delete(handle.pluginId);
          results.push({
            pluginId: handle.pluginId,
            status: "disabled",
            reason: "Missing manifest for crashed plugin.",
          });
          continue;
        }

        const restart = yield* Effect.either(self.start(manifest));
        if (restart._tag === "Right") {
          results.push({ pluginId: handle.pluginId, status: "restarted" });
          continue;
        }

        yield* self.#runtime.disablePlugin(handle.pluginId).pipe(Effect.ignore);
        self.#handles.delete(handle.pluginId);
        self.#manifests.delete(handle.pluginId);
        results.push({
          pluginId: handle.pluginId,
          status: "disabled",
          reason: String(restart.left),
        });
      }

      return results;
    })();
  }
}
