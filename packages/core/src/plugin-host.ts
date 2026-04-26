import type { AuditSink } from "@andy/audit";
import type {
  AnyToolDefinition,
  PluginDefinition,
  PluginExecutionMode,
  PluginManifest,
  PluginManifestTool,
  ToolContext,
} from "@andy/plugin-sdk";
import { isJsonValue, type JsonValue } from "@andy/types";
import { Effect } from "effect";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import {
  PluginHostUnsupportedError,
  type PluginSandboxError,
  SubprocessPluginExecutionError,
  ToolSandboxIncompatibleError,
  WorkerPluginExecutionError,
} from "./errors.js";
import {
  isWorkerPluginHostApiRequest,
  isWorkerPluginHostResponse,
  type WorkerPluginHostApiRequest,
  type WorkerPluginHostResponse,
} from "./plugin-worker-protocol.js";
import {
  buildSandboxedLaunchCommand,
  PluginSandboxFactory,
  type PluginSandbox,
  type ProcessIsolationProfile,
} from "./plugin-sandbox.js";
import { stringifyCause } from "./utils.js";

export interface PluginHostHandle {
  pluginId: string;
  executionMode: PluginExecutionMode;
  health(): PluginHostHealth;
  stop(): Effect.Effect<void, PluginSandboxError>;
}

export type PluginHostHealth =
  | {
      status: "running";
      pluginId: string;
      executionMode: PluginExecutionMode;
      startedAt: Date;
      runtime?: "bun" | "binary";
    }
  | {
      status: "stopped";
      pluginId: string;
      executionMode: PluginExecutionMode;
      startedAt: Date;
      stoppedAt: Date;
      runtime?: "bun" | "binary";
    }
  | {
      status: "crashed";
      pluginId: string;
      executionMode: PluginExecutionMode;
      startedAt: Date;
      crashedAt: Date;
      exitCode?: number;
      signal?: string;
      reason: string;
      runtime?: "bun" | "binary";
    };

export interface WorkerPluginHostHandle extends PluginHostHandle {
  plugin: PluginDefinition;
  sandboxRoot?: string;
}

export interface PluginHost {
  start(
    plugin: PluginDefinition,
  ): Effect.Effect<PluginHostHandle, PluginHostUnsupportedError>;
}

export interface ManifestPluginHost {
  startManifest(
    manifest: PluginManifest,
  ): Effect.Effect<
    WorkerPluginHostHandle,
    PluginHostUnsupportedError | PluginSandboxError | ToolSandboxIncompatibleError
  >;
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
      let health: PluginHostHealth = {
        status: "running",
        pluginId: plugin.id,
        executionMode,
        startedAt: new Date(),
      };
      yield* self.#audit.record({
        type: "plugin.host.started",
        pluginId: plugin.id,
        executionMode,
      });
      const handle: PluginHostHandle = {
        pluginId: plugin.id,
        executionMode,
        health: () => health,
        stop: () =>
          Effect.sync(() => {
            health = {
              status: "stopped",
              pluginId: plugin.id,
              executionMode,
              startedAt: health.startedAt,
              stoppedAt: new Date(),
            };
          }).pipe(
            Effect.zipRight(
              self.#audit.record({
                type: "plugin.host.stopped",
                pluginId: plugin.id,
                executionMode,
              }),
            ),
          ),
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

export class WorkerManifestPluginHost implements ManifestPluginHost {
  readonly #audit: AuditSink;
  readonly #hostApiHandler: HostedPluginHostApiHandler | undefined;
  readonly #workers = new Map<string, Worker>();
  readonly #pending = new Map<
    string,
    {
      resolve(response: WorkerPluginHostResponse): void;
      reject(cause: unknown): void;
    }
  >();

  constructor(options: {
    audit: AuditSink;
    hostApiHandler?: HostedPluginHostApiHandler;
  }) {
    this.#audit = options.audit;
    this.#hostApiHandler = options.hostApiHandler;
  }

  startManifest(
    manifest: PluginManifest,
  ): Effect.Effect<
    WorkerPluginHostHandle,
    PluginHostUnsupportedError | ToolSandboxIncompatibleError
  > {
    const self = this;
    return Effect.fn("WorkerManifestPluginHost.startManifest")(function* () {
      const executionMode = manifest.executionMode ?? "worker";
      if (executionMode !== "worker") {
        return yield* Effect.fail(
          new PluginHostUnsupportedError({
            pluginId: manifest.id,
            executionMode,
            message: `WorkerManifestPluginHost cannot start '${executionMode}' plugin '${manifest.id}'.`,
          }),
        );
      }
      yield* validateManifestToolSandboxCompatibility(manifest, executionMode);

      const worker = new Worker(manifest.entry, { type: "module" });
      let health: PluginHostHealth = {
        status: "running",
        pluginId: manifest.id,
        executionMode,
        startedAt: new Date(),
      };
      worker.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (!isWorkerPluginHostResponse(message)) {
          if (isWorkerPluginHostApiRequest(message)) {
            self.#handleWorkerHostApiRequest(worker, manifest, message);
          }
          return;
        }

        const pending = self.#pending.get(message.requestId);
        if (!pending) {
          return;
        }

        self.#pending.delete(message.requestId);
        pending.resolve(message);
      };
      worker.onerror = (event) => {
        health = {
          status: "crashed",
          pluginId: manifest.id,
          executionMode,
          startedAt: health.startedAt,
          crashedAt: new Date(),
          reason: event.message,
        };
        for (const [requestId, pending] of self.#pending.entries()) {
          self.#pending.delete(requestId);
          pending.reject(event);
        }
      };
      self.#workers.set(manifest.id, worker);
      yield* self.#audit.record({
        type: "plugin.host.started",
        pluginId: manifest.id,
        executionMode,
      });

      const handle: WorkerPluginHostHandle = {
        pluginId: manifest.id,
        executionMode,
        plugin: createWorkerPluginDefinition({
          manifest,
          executeTool: (toolName, input) =>
            self.#executeWorkerTool({ worker, manifest, toolName, input }),
        }),
        health: () => health,
        stop: () =>
          Effect.sync(() => {
            health = {
              status: "stopped",
              pluginId: manifest.id,
              executionMode,
              startedAt: health.startedAt,
              stoppedAt: new Date(),
            };
            worker.terminate();
            self.#workers.delete(manifest.id);
          }).pipe(
            Effect.zipRight(
              self.#audit.record({
                type: "plugin.host.stopped",
                pluginId: manifest.id,
                executionMode,
              }),
            ),
          ),
      };
      return handle;
    })();
  }

  #executeWorkerTool(options: {
    worker: Worker;
    manifest: PluginManifest;
    toolName: string;
    input: JsonValue;
  }): Effect.Effect<JsonValue, WorkerPluginExecutionError> {
    const self = this;
    return Effect.fn("WorkerManifestPluginHost.executeWorkerTool")(function* () {
      const requestId = crypto.randomUUID();
      yield* self.#audit.record({
        type: "plugin.host.tool_requested",
        pluginId: options.manifest.id,
        toolName: options.toolName,
        requestId,
      });

      const response = yield* Effect.tryPromise({
        try: () =>
          new Promise<WorkerPluginHostResponse>((resolve, reject) => {
            self.#pending.set(requestId, { resolve, reject });
            options.worker.postMessage({
              type: "andy.tool.execute",
              requestId,
              pluginId: options.manifest.id,
              toolName: options.toolName,
              input: options.input,
            });
          }),
        catch: (cause) =>
          new WorkerPluginExecutionError({
            pluginId: options.manifest.id,
            toolName: options.toolName,
            message: `Worker plugin '${options.manifest.id}' tool '${options.toolName}' failed.`,
            cause: stringifyCause(cause),
          }),
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            self.#pending.delete(requestId);
            options.worker.terminate();
          }),
        ),
      );

      if (response.type === "andy.tool.error") {
        return yield* Effect.fail(
          new WorkerPluginExecutionError({
            pluginId: options.manifest.id,
            toolName: options.toolName,
            message: response.message,
            cause: response.cause,
          }),
        );
      }

      if (!isJsonValue(response.output)) {
        return yield* Effect.fail(
          new WorkerPluginExecutionError({
            pluginId: options.manifest.id,
            toolName: options.toolName,
            message: `Worker plugin '${options.manifest.id}' tool '${options.toolName}' returned non-JSON output.`,
          }),
        );
      }

      yield* self.#audit.record({
        type: "plugin.host.tool_completed",
        pluginId: options.manifest.id,
        toolName: options.toolName,
        requestId,
      });
      return response.output;
    })();
  }

  #handleWorkerHostApiRequest(
    worker: Worker,
    manifest: PluginManifest,
    request: WorkerPluginHostApiRequest,
  ): void {
    Effect.runPromise(
      executeHostedPluginHostApi(this.#hostApiHandler, manifest, request).pipe(
        Effect.tap((output) =>
          Effect.sync(() =>
            worker.postMessage({
              type: "andy.host_api.result",
              requestId: request.requestId,
              output,
            }),
          ),
        ),
        Effect.catchAll((cause) =>
          Effect.sync(() =>
            worker.postMessage({
              type: "andy.host_api.error",
              requestId: request.requestId,
              message: stringifyCause(cause),
            }),
          ),
        ),
      ),
    );
  }
}

export interface SubprocessPluginHostOptions {
  audit: AuditSink;
  hostApiHandler?: HostedPluginHostApiHandler;
  sandboxFactory?: PluginSandboxFactory;
  bunExecutable?: string;
  keepSandboxAfterStop?: boolean;
  baseSandboxDir?: string;
  processIsolation?: ProcessIsolationProfile;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
}

export type HostedPluginHostApiHandler = (
  request: WorkerPluginHostApiRequest,
) => Effect.Effect<JsonValue, unknown>;

export class SubprocessManifestPluginHost implements ManifestPluginHost {
  readonly #audit: AuditSink;
  readonly #hostApiHandler: HostedPluginHostApiHandler | undefined;
  readonly #sandboxFactory: PluginSandboxFactory;
  readonly #bunExecutable: string;
  readonly #keepSandboxAfterStop: boolean;
  readonly #baseSandboxDir: string | undefined;
  readonly #processIsolation: ProcessIsolationProfile;
  readonly #requestTimeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #pending = new Map<
    string,
    {
      resolve(response: WorkerPluginHostResponse): void;
      reject(cause: unknown): void;
    }
  >();

  constructor(options: SubprocessPluginHostOptions) {
    this.#audit = options.audit;
    this.#hostApiHandler = options.hostApiHandler;
    this.#sandboxFactory = options.sandboxFactory ?? new PluginSandboxFactory();
    this.#bunExecutable = options.bunExecutable ?? "bun";
    this.#keepSandboxAfterStop = options.keepSandboxAfterStop ?? false;
    this.#baseSandboxDir = options.baseSandboxDir;
    this.#processIsolation = options.processIsolation ?? {
      kind: "process-boundary",
    };
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
  }

  startManifest(
    manifest: PluginManifest,
  ): Effect.Effect<
    WorkerPluginHostHandle,
    PluginHostUnsupportedError | PluginSandboxError | ToolSandboxIncompatibleError
  > {
    const self = this;
    return Effect.fn("SubprocessManifestPluginHost.startManifest")(function* () {
      const executionMode = manifest.executionMode ?? "subprocess";
      if (executionMode !== "subprocess") {
        return yield* Effect.fail(
          new PluginHostUnsupportedError({
            pluginId: manifest.id,
            executionMode,
            message: `SubprocessManifestPluginHost cannot start '${executionMode}' plugin '${manifest.id}'.`,
          }),
        );
      }
      yield* validateManifestToolSandboxCompatibility(manifest, executionMode);

      const sandbox = yield* self.#sandboxFactory.create({
        pluginId: manifest.id,
        keepAfterStop: self.#keepSandboxAfterStop,
        ...(self.#baseSandboxDir ? { baseDir: self.#baseSandboxDir } : {}),
      });
      const launchCommand = yield* buildSandboxedLaunchCommand({
        bunExecutable: self.#bunExecutable,
        entry: manifest.entry,
        ...(manifest.binaryEntrypoint && existsSync(manifest.binaryEntrypoint)
          ? { binaryEntrypoint: manifest.binaryEntrypoint }
          : {}),
        profile: self.#processIsolation,
        sandbox,
      });
      const child = spawn(launchCommand.command, [...launchCommand.args], {
        cwd: sandbox.root,
        env: createSandboxEnvironment({ manifest, sandbox }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let health: PluginHostHealth = {
        status: "running",
        pluginId: manifest.id,
        executionMode,
        startedAt: new Date(),
        runtime: launchCommand.runtime,
      };
      let stopping = false;
      const stdout = createInterface({ input: child.stdout });
      stdout.on("line", (line) => self.#handleSubprocessLine(line, child, manifest));
      child.once("error", (error) => self.#rejectPending(error));
      child.once("exit", (code, signal) => {
        if (!stopping) {
          health = {
            status: "crashed",
            pluginId: manifest.id,
            executionMode,
            startedAt: health.startedAt,
            crashedAt: new Date(),
            runtime: launchCommand.runtime,
            ...(typeof code === "number" ? { exitCode: code } : {}),
            ...(signal ? { signal } : {}),
            reason: `Plugin subprocess exited with code ${String(code)} signal ${String(signal)}.`,
          };
        }
        self.#rejectPending(
          new Error(
            `Plugin subprocess '${manifest.id}' exited with code ${String(code)} signal ${String(signal)}.`,
          ),
        );
      });

      yield* self.#audit.record({
        type: "plugin.host.started",
        pluginId: manifest.id,
        executionMode,
        runtime: launchCommand.runtime,
      });

      const handle: WorkerPluginHostHandle = {
        pluginId: manifest.id,
        executionMode,
        sandboxRoot: sandbox.root,
        plugin: createHostedPluginDefinition({
          manifest,
          executeTool: (toolName, input) =>
            self.#executeSubprocessTool({ child, manifest, toolName, input }),
        }),
        health: () => health,
        stop: () =>
          Effect.sync(() => {
            stopping = true;
            health = {
              status: "stopped",
              pluginId: manifest.id,
              executionMode,
              startedAt: health.startedAt,
              stoppedAt: new Date(),
              runtime: launchCommand.runtime,
            };
          }).pipe(
            Effect.zipRight(
              stopSubprocessPlugin({
                audit: self.#audit,
                child,
                executionMode,
                manifest,
                sandbox,
                stdout,
              }),
            ),
          ),
      };
      return handle;
    })();
  }

  #handleSubprocessLine(
    line: string,
    child: ChildProcessWithoutNullStreams,
    manifest: PluginManifest,
  ): void {
    if (Buffer.byteLength(line, "utf8") > this.#maxMessageBytes) {
      this.#rejectPending(
        new Error(
          `Plugin subprocess '${manifest.id}' emitted a message larger than ${this.#maxMessageBytes} bytes.`,
        ),
      );
      return;
    }

    const message = parseWorkerHostMessage(line);
    if (!message) {
      return;
    }

    if (isWorkerPluginHostApiRequest(message)) {
      this.#handleSubprocessHostApiRequest(child, manifest, message);
      return;
    }

    const pending = this.#pending.get(message.requestId);
    if (!pending) {
      return;
    }

    this.#pending.delete(message.requestId);
    pending.resolve(message);
  }

  #rejectPending(cause: unknown): void {
    for (const [requestId, pending] of this.#pending.entries()) {
      this.#pending.delete(requestId);
      pending.reject(cause);
    }
  }

  #handleSubprocessHostApiRequest(
    child: ChildProcessWithoutNullStreams,
    manifest: PluginManifest,
    request: WorkerPluginHostApiRequest,
  ): void {
    Effect.runPromise(
      executeHostedPluginHostApi(this.#hostApiHandler, manifest, request).pipe(
        Effect.tap((output) =>
          Effect.sync(() =>
            child.stdin.write(
              `${JSON.stringify({
                type: "andy.host_api.result",
                requestId: request.requestId,
                output,
              })}\n`,
            ),
          ),
        ),
        Effect.catchAll((cause) =>
          Effect.sync(() =>
            child.stdin.write(
              `${JSON.stringify({
                type: "andy.host_api.error",
                requestId: request.requestId,
                message: stringifyCause(cause),
              })}\n`,
            ),
          ),
        ),
      ),
    );
  }

  #executeSubprocessTool(options: {
    child: ChildProcessWithoutNullStreams;
    manifest: PluginManifest;
    toolName: string;
    input: JsonValue;
  }): Effect.Effect<JsonValue, SubprocessPluginExecutionError> {
    const self = this;
    return Effect.fn("SubprocessManifestPluginHost.executeSubprocessTool")(
      function* () {
        const requestId = crypto.randomUUID();
        yield* self.#audit.record({
          type: "plugin.host.tool_requested",
          pluginId: options.manifest.id,
          toolName: options.toolName,
          requestId,
        });

        const response = yield* Effect.tryPromise({
          try: () =>
            new Promise<WorkerPluginHostResponse>((resolve, reject) => {
              const timeout = setTimeout(() => {
                self.#pending.delete(requestId);
                reject(
                  new Error(
                    `Subprocess plugin '${options.manifest.id}' tool '${options.toolName}' timed out after ${self.#requestTimeoutMs}ms.`,
                  ),
                );
              }, self.#requestTimeoutMs);
              self.#pending.set(requestId, { resolve, reject });
              options.child.stdin.write(
                `${JSON.stringify({
                  type: "andy.tool.execute",
                  requestId,
                  pluginId: options.manifest.id,
                  toolName: options.toolName,
                  input: options.input,
                })}\n`,
                (error) => {
                  if (error) {
                    clearTimeout(timeout);
                    self.#pending.delete(requestId);
                    reject(error);
                  }
                },
              );
            }),
          catch: (cause) =>
            new SubprocessPluginExecutionError({
              pluginId: options.manifest.id,
              toolName: options.toolName,
              message: `Subprocess plugin '${options.manifest.id}' tool '${options.toolName}' failed.`,
              cause: stringifyCause(cause),
            }),
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              self.#pending.delete(requestId);
              if (!options.child.killed) {
                options.child.kill("SIGTERM");
              }
            }),
          ),
        );

        if (response.type === "andy.tool.error") {
          return yield* Effect.fail(
            new SubprocessPluginExecutionError({
              pluginId: options.manifest.id,
              toolName: options.toolName,
              message: response.message,
              cause: response.cause,
            }),
          );
        }

        if (!isJsonValue(response.output)) {
          return yield* Effect.fail(
            new SubprocessPluginExecutionError({
              pluginId: options.manifest.id,
              toolName: options.toolName,
              message: `Subprocess plugin '${options.manifest.id}' tool '${options.toolName}' returned non-JSON output.`,
            }),
          );
        }

        yield* self.#audit.record({
          type: "plugin.host.tool_completed",
          pluginId: options.manifest.id,
          toolName: options.toolName,
          requestId,
        });
        return response.output;
      },
    )();
  }
}

function createWorkerPluginDefinition(options: {
  manifest: PluginManifest;
  executeTool(
    toolName: string,
    input: JsonValue,
  ): Effect.Effect<JsonValue, WorkerPluginExecutionError>;
}): PluginDefinition {
  return createHostedPluginDefinition(options);
}

function createHostedPluginDefinition(options: {
  manifest: PluginManifest;
  executeTool(
    toolName: string,
    input: JsonValue,
  ): Effect.Effect<
    JsonValue,
    WorkerPluginExecutionError | SubprocessPluginExecutionError
  >;
}): PluginDefinition {
  return {
    id: options.manifest.id,
    name: options.manifest.name,
    version: options.manifest.version,
    capabilities: options.manifest.capabilities,
    tools: (options.manifest.tools ?? []).map((tool) =>
      createWorkerToolDefinition(tool, options.executeTool),
    ),
    ...(options.manifest.source ? { source: options.manifest.source } : {}),
    ...(options.manifest.permissions
      ? { permissions: options.manifest.permissions }
      : {}),
  };
}

function createWorkerToolDefinition(
  tool: PluginManifestTool,
  executeTool: (
    toolName: string,
    input: JsonValue,
  ) => Effect.Effect<
    JsonValue,
    WorkerPluginExecutionError | SubprocessPluginExecutionError
  >,
): AnyToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    capabilities: tool.capabilities,
    risk: tool.risk,
    ...(tool.sandbox ? { sandbox: tool.sandbox } : {}),
    ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    execute(input: JsonValue, _context: ToolContext) {
      return executeTool(tool.name, input);
    },
  };
}

function validateManifestToolSandboxCompatibility(
  manifest: PluginManifest,
  executionMode: PluginExecutionMode,
): Effect.Effect<void, ToolSandboxIncompatibleError> {
  return Effect.fn("PluginHost.validateManifestToolSandboxCompatibility")(function* () {
    for (const tool of manifest.tools ?? []) {
      if (
        tool.sandbox?.requiresHostPrivileges &&
        executionMode !== "trusted-in-process"
      ) {
        return yield* Effect.fail(
          new ToolSandboxIncompatibleError({
            pluginId: manifest.id,
            toolName: tool.name,
            executionMode,
            message: `Tool '${tool.name}' requires host privileges and cannot run in '${executionMode}'.`,
          }),
        );
      }

      if (
        tool.sandbox &&
        !tool.sandbox.compatibleExecutionModes.includes(executionMode)
      ) {
        return yield* Effect.fail(
          new ToolSandboxIncompatibleError({
            pluginId: manifest.id,
            toolName: tool.name,
            executionMode,
            message: `Tool '${tool.name}' is not compatible with '${executionMode}'.`,
          }),
        );
      }
    }
  })();
}

function createSandboxEnvironment(options: {
  manifest: PluginManifest;
  sandbox: PluginSandbox;
}): NodeJS.ProcessEnv {
  const environment = process.env as {
    PATH?: string;
  };
  return {
    PATH: environment.PATH ?? "",
    HOME: options.sandbox.root,
    TMPDIR: options.sandbox.scratchRoot,
    ANDY_PLUGIN_FILESYSTEM_READ_ROOTS:
      options.manifest.permissions?.filesystem?.readRoots?.join(",") ?? "",
    ANDY_PLUGIN_FILESYSTEM_WRITE_ROOTS:
      options.manifest.permissions?.filesystem?.writeRoots?.join(",") ?? "",
    ANDY_PLUGIN_FILESYSTEM_SENSITIVE_READ_ROOTS:
      options.manifest.permissions?.filesystem?.sensitiveReadRoots
        ?.map((root) => root.path)
        .join(",") ?? "",
    ANDY_PLUGIN_NETWORK_HOSTS:
      options.manifest.permissions?.network?.allowedHosts.join(",") ?? "",
    ANDY_PLUGIN_ID: options.manifest.id,
    ANDY_PLUGIN_SANDBOX_ROOT: options.sandbox.root,
    ANDY_PLUGIN_SCRATCH_ROOT: options.sandbox.scratchRoot,
    ANDY_PLUGIN_STORAGE_ROOT: options.sandbox.storageRoot,
  };
}

function parseWorkerHostMessage(
  line: string,
): WorkerPluginHostResponse | WorkerPluginHostApiRequest | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (isWorkerPluginHostResponse(parsed) || isWorkerPluginHostApiRequest(parsed)) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function executeHostedPluginHostApi(
  handler: HostedPluginHostApiHandler | undefined,
  manifest: PluginManifest,
  request: WorkerPluginHostApiRequest,
): Effect.Effect<JsonValue, unknown> {
  if (request.pluginId !== manifest.id) {
    return Effect.succeed({
      denied: true,
      reason: `Host API request plugin id '${request.pluginId}' does not match '${manifest.id}'.`,
    });
  }

  if (!manifest.capabilities.includes(request.capability)) {
    return Effect.succeed({
      denied: true,
      reason: `Plugin '${manifest.id}' did not declare capability '${request.capability}'.`,
    });
  }

  if (!handler) {
    return Effect.succeed({
      denied: true,
      reason: "No host API handler is configured for this plugin host.",
    });
  }

  return handler(request);
}

function stopSubprocessPlugin(options: {
  audit: AuditSink;
  child: ChildProcessWithoutNullStreams;
  executionMode: PluginExecutionMode;
  manifest: PluginManifest;
  sandbox: PluginSandbox;
  stdout: ReadLineInterface;
}): Effect.Effect<void, PluginSandboxError> {
  return Effect.fn("SubprocessManifestPluginHost.stop")(function* () {
    options.stdout.close();
    if (!options.child.killed) {
      options.child.kill("SIGTERM");
    }
    yield* options.audit.record({
      type: "plugin.host.stopped",
      pluginId: options.manifest.id,
      executionMode: options.executionMode,
    });
    yield* options.sandbox.dispose();
  })();
}
