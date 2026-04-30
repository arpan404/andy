import { ConsoleAuditSink } from "@andy/audit";
import { definePlugin, defineTool, parsePluginManifest } from "@andy/plugin-sdk";
import { CapabilityPolicy } from "@andy/policy";
import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildAiSdkTools } from "./ai-tools.js";
import { ApprovalResumeEngine, createApprovalToolResult } from "./approval-resume.js";
import { ApprovalManager } from "./approvals.js";
import { BackgroundJobScheduler } from "./background.js";
import { BackgroundJobExecutor } from "./background-executor.js";
import { CancellationRegistry, withTimeout } from "./cancellation.js";
import { CommunicationBridge } from "./communication.js";
import { InMemoryEventBus } from "./events.js";
import { AgentRuntime } from "./runtime.js";
import { InMemorySecretBroker, JsonFileSecretBroker } from "./secrets.js";
import { JsonFileCoreStateStore } from "./state.js";
import { TraceManager } from "./tracing.js";
import { DefaultHostedPluginHostApi } from "./host-api-handler.js";
import { PluginLifecycleManager } from "./plugin-lifecycle.js";
import {
  LocalPluginPackageInstaller,
  PluginInstaller,
  StaticPluginManifestFetcher,
} from "./plugin-installer.js";
import { createAndyDaemon } from "./daemon.js";
import {
  SubprocessManifestPluginHost,
  WorkerManifestPluginHost,
  type WorkerPluginHostHandle,
} from "./plugin-host.js";
import {
  buildSandboxedLaunchCommand,
  PluginSandboxFactory,
  verifyProcessIsolationProfile,
} from "./plugin-sandbox.js";

describe("core kernel services", () => {
  test("creates approval requests for ask policy decisions", async () => {
    const audit = new ConsoleAuditSink();
    const approvals = new ApprovalManager({ audit });
    const runtime = new AgentRuntime({
      audit,
      approvalManager: approvals,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["shell.execute"]),
        approvalRequiredCapabilities: new Set(["shell.execute"]),
      }),
    });
    Effect.runSync(
      runtime.registerPlugin(
        definePlugin({
          id: "andy.shell",
          name: "Shell",
          version: "0.1.0",
          capabilities: ["shell.execute"],
          tools: [
            defineTool({
              name: "shell.execute",
              description: "Execute shell commands.",
              capabilities: ["shell.execute"],
              risk: "critical",
              execute() {
                return Effect.succeed({ executed: true });
              },
            }),
          ],
        }),
      ),
    );

    const result = await Effect.runPromiseExit(
      runtime.executeTool("shell.execute", { command: "date" }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("ToolApprovalRequiredError");
    }
    expect(approvals.list()).toHaveLength(1);
    expect(approvals.list()[0]?.toolName).toBe("shell.execute");
  });

  test("maps AI SDK tool names back to qualified runtime tools", async () => {
    const runtime = new AgentRuntime({
      audit: new ConsoleAuditSink(),
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["memory.save"]),
      }),
    });
    Effect.runSync(
      runtime.registerPlugin(
        definePlugin({
          id: "andy.memory.markdown",
          name: "Markdown Memory",
          version: "0.1.0",
          capabilities: ["memory.save"],
          tools: [
            defineTool({
              name: "memory.save",
              description: "Save memory.",
              capabilities: ["memory.save"],
              risk: "medium",
              inputSchema: {
                type: "object",
                properties: {
                  key: { type: "string" },
                },
                required: ["key"],
              },
              execute() {
                return Effect.succeed({ saved: true });
              },
            }),
          ],
        }),
      ),
    );

    const [record] = runtime.listTools();
    expect(record).toBeDefined();
    const tools = buildAiSdkTools(runtime.listTools());

    expect(Object.keys(tools)).toEqual([record?.aiToolName]);
    expect(runtime.resolveModelToolName(record?.aiToolName ?? "")).toBe(
      "andy.memory.markdown.memory.save",
    );
  });

  test("persists core state snapshots to JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "andy-core-state-"));
    const path = join(dir, "state.json");
    const store = new JsonFileCoreStateStore(path);
    await Effect.runPromise(
      store.save({
        plugins: [],
        sessions: [],
        approvals: [],
        backgroundJobs: [],
      }),
    );

    const loaded = await Effect.runPromise(store.load());
    const raw = JSON.parse(await readFile(path, "utf8")) as { schemaVersion?: unknown };

    expect(loaded).toEqual({
      plugins: [],
      sessions: [],
      approvals: [],
      backgroundJobs: [],
    });
    expect(raw.schemaVersion).toBe(1);
  });

  test("hydrates daemon approvals and background jobs from durable state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "andy-daemon-state-"));
    const store = new JsonFileCoreStateStore(join(dir, "state.json"));
    const createdAt = new Date();
    await Effect.runPromise(
      store.save({
        plugins: [],
        sessions: [],
        approvals: [
          {
            id: "approval-1",
            runId: "run-1",
            toolName: "shell.execute",
            input: { command: "date" },
            reason: "Needs approval.",
            status: "pending",
            createdAt,
          },
        ],
        backgroundJobs: [
          {
            id: "job-1",
            pluginId: "andy.background",
            toolName: "background.run",
            input: {},
            status: "scheduled",
            createdAt,
            updatedAt: createdAt,
          },
        ],
      }),
    );

    const daemon = await Effect.runPromise(
      createAndyDaemon({
        audit: new ConsoleAuditSink(),
        policy: new CapabilityPolicy({ allowedCapabilities: new Set() }),
        stateStore: store,
      }),
    );

    expect(daemon.approvals.list()).toHaveLength(1);
    expect(await Effect.runPromise(daemon.background.list())).toHaveLength(1);
    await Effect.runPromise(daemon.saveState());
  });

  test("tracks cancellation tokens and times out effects", async () => {
    const registry = new CancellationRegistry();
    const token = await Effect.runPromise(registry.create());
    const cancelled = await Effect.runPromise(registry.cancel(token.id, "user"));
    const timedOut = await Effect.runPromiseExit(
      withTimeout(Effect.sleep("20 millis"), "1 millis"),
    );

    expect(cancelled?.status).toBe("cancelled");
    expect(registry.get(token.id)?.reason).toBe("user");
    expect(timedOut._tag).toBe("Failure");
  });

  test("gates secrets by declared scope", async () => {
    const broker = new InMemorySecretBroker({ audit: new ConsoleAuditSink() });
    await Effect.runPromise(
      broker.set({
        pluginId: "andy.messaging.telegram",
        scope: "telegram.bot_token",
        value: "secret",
      }),
    );

    const allowed = await Effect.runPromise(
      broker.get({
        pluginId: "andy.messaging.telegram",
        scope: "telegram.bot_token",
        declaredScopes: new Set(["telegram.bot_token"]),
      }),
    );
    const denied = await Effect.runPromiseExit(
      broker.get({
        pluginId: "andy.messaging.telegram",
        scope: "telegram.bot_token",
        declaredScopes: new Set(),
      }),
    );

    expect(allowed).toBe("secret");
    expect(denied._tag).toBe("Failure");
  });

  test("persists encoded secret fallback records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "andy-secret-broker-"));
    const path = join(dir, "secrets.json");
    const broker = new JsonFileSecretBroker({
      audit: new ConsoleAuditSink(),
      path,
    });

    await Effect.runPromise(
      broker.save([
        {
          pluginId: "andy.messaging.telegram",
          scope: "telegram.bot_token",
          value: "telegram-secret",
        },
      ]),
    );
    const loaded = new JsonFileSecretBroker({
      audit: new ConsoleAuditSink(),
      path,
    });
    await Effect.runPromise(loaded.load());

    const value = await Effect.runPromise(
      loaded.get({
        pluginId: "andy.messaging.telegram",
        scope: "telegram.bot_token",
        declaredScopes: new Set(["telegram.bot_token"]),
      }),
    );
    const raw = await readFile(path, "utf8");

    expect(value).toBe("telegram-secret");
    expect(raw).not.toContain("telegram-secret");
  });

  test("publishes trace and background lifecycle events", async () => {
    const events: string[] = [];
    const bus = new InMemoryEventBus();
    bus.subscribe((event) =>
      Effect.sync(() => {
        events.push(event.type);
      }),
    );
    const traceManager = new TraceManager({ eventBus: bus });
    const trace = await Effect.runPromise(traceManager.start({ name: "test" }));
    await Effect.runPromise(traceManager.complete(trace));

    const scheduler = new BackgroundJobScheduler({
      audit: { record: (event) => bus.publish(event) },
    });
    const job = await Effect.runPromise(
      scheduler.schedule({
        pluginId: "andy.background-worker",
        toolName: "background.run",
        input: {},
      }),
    );
    await Effect.runPromise(scheduler.updateStatus(job.id, "running"));

    expect(events).toContain("trace.started");
    expect(events).toContain("trace.completed");
    expect(events).toContain("background.job.created");
    expect(events).toContain("background.job.updated");
  });

  test("replays event history for late subscribers", async () => {
    const events: string[] = [];
    const bus = new InMemoryEventBus();
    await Effect.runPromise(
      bus.publish({ type: "trace.started", traceId: "t1", name: "root" }),
    );
    bus.subscribe(
      (event) =>
        Effect.sync(() => {
          events.push(event.type);
        }),
      { replayFromSequence: 1 },
    );

    expect(bus.replay()).toHaveLength(1);
    expect(events).toEqual(["trace.started"]);
  });

  test("hydrates durable event history with stable sequence numbers", async () => {
    const bus = new InMemoryEventBus();
    await Effect.runPromise(
      bus.hydrate([
        {
          sequence: 10,
          event: { type: "trace.started", traceId: "t1", name: "root" },
          publishedAt: new Date(0),
        },
      ]),
    );
    await Effect.runPromise(
      bus.publish({ type: "trace.completed", traceId: "t1", name: "root" }),
    );

    expect(bus.replay().map((event) => event.sequence)).toEqual([10, 11]);
  });

  test("routes approval requests through the communication bridge", async () => {
    const audit = new ConsoleAuditSink();
    const communication = new CommunicationBridge({ audit });
    const sent: string[] = [];
    await Effect.runPromise(
      communication.registerChannel({
        id: "telegram",
        pluginId: "andy.messaging.telegram",
        send(input) {
          sent.push(input.text);
          return Effect.succeed({ sent: true });
        },
      }),
    );
    const approvals = new ApprovalManager({ audit, communication });

    const request = await Effect.runPromise(
      approvals.create({
        runId: "run-1",
        toolName: "shell.execute",
        input: { command: "date" },
        reason: "Shell execution requires approval.",
        communication: {
          channelId: "telegram",
          conversationId: "user-1",
        },
      }),
    );

    expect(request.status).toBe("pending");
    expect(sent[0]).toContain("Approval required for shell.execute");
    expect(communication.listMessages().at(-1)?.kind).toBe("approval");
  });

  test("runtime approval-gated tools route prompts to channel context", async () => {
    const audit = new ConsoleAuditSink();
    const communication = new CommunicationBridge({ audit });
    const approvals = new ApprovalManager({ audit, communication });
    const sent: string[] = [];
    await Effect.runPromise(
      communication.registerChannel({
        id: "telegram",
        pluginId: "andy.messaging.telegram",
        send(input) {
          sent.push(input.text);
          return Effect.succeed({ sent: true });
        },
      }),
    );
    const runtime = new AgentRuntime({
      audit,
      approvalManager: approvals,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["shell.execute"]),
        approvalRequiredCapabilities: new Set(["shell.execute"]),
      }),
    });
    await Effect.runPromise(
      runtime.registerPlugin(
        definePlugin({
          id: "andy.shell",
          name: "Shell",
          version: "0.1.0",
          capabilities: ["shell.execute"],
          tools: [
            defineTool({
              name: "shell.execute",
              description: "Execute shell commands.",
              capabilities: ["shell.execute"],
              risk: "critical",
              execute() {
                return Effect.succeed({ executed: true });
              },
            }),
          ],
        }),
      ),
    );

    const result = await Effect.runPromiseExit(
      runtime.executeTool(
        "andy.shell.shell.execute",
        { command: "date" },
        { channelId: "telegram", conversationId: "chat-1" },
      ),
    );

    expect(result._tag).toBe("Failure");
    expect(sent[0]).toContain("Approval ID:");
    expect(sent[0]).toContain("/approve");
  });

  test("resumes parked approval actions after approval", async () => {
    const approvals = new ApprovalManager({ audit: new ConsoleAuditSink() });
    const resume = new ApprovalResumeEngine({ approvals });
    const approval = await Effect.runPromise(
      approvals.create({
        runId: "run-approval",
        toolName: "memory.save",
        input: { key: "name" },
        reason: "Memory write requires approval.",
      }),
    );
    await Effect.runPromise(
      resume.park(approval, () =>
        Effect.succeed(createApprovalToolResult({ ok: true })),
      ),
    );

    const result = await Effect.runPromise(resume.resumeApproved(approval.id));

    expect(result.output).toEqual({ ok: true });
    expect(resume.listParked()).toHaveLength(0);
  });

  test("expires parked approval actions", async () => {
    const approvals = new ApprovalManager({ audit: new ConsoleAuditSink() });
    const resume = new ApprovalResumeEngine({ approvals });
    const approval = await Effect.runPromise(
      approvals.create({
        runId: "run-expire",
        toolName: "memory.save",
        input: { key: "name" },
        reason: "Memory write requires approval.",
      }),
    );
    await Effect.runPromise(
      resume.park(approval, () =>
        Effect.succeed(createApprovalToolResult({ ok: true })),
      ),
    );

    const expired = await Effect.runPromise(resume.expire(approval.id));

    expect(expired?.status).toBe("expired");
    expect(resume.listParked()).toHaveLength(0);
  });

  test("hydrates parked approval descriptors and resumes after restart", async () => {
    const audit = new ConsoleAuditSink();
    const approvals = new ApprovalManager({ audit });
    const runtime = new AgentRuntime({
      audit,
      approvalManager: approvals,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["memory.save"]),
      }),
    });
    await Effect.runPromise(
      runtime.registerPlugin(
        definePlugin({
          id: "andy.memory.restart",
          name: "Restart Memory",
          version: "0.1.0",
          capabilities: ["memory.save"],
          tools: [
            defineTool({
              name: "memory.save",
              description: "Save memory.",
              capabilities: ["memory.save"],
              risk: "medium",
              execute(input) {
                return Effect.succeed({ saved: input });
              },
            }),
          ],
        }),
      ),
    );
    const approval = await Effect.runPromise(
      approvals.create({
        runId: "run-restart",
        toolName: "andy.memory.restart.memory.save",
        input: { key: "name" },
        reason: "Memory write requires approval.",
      }),
    );
    const resume = new ApprovalResumeEngine({
      approvals,
      executor: (descriptor) =>
        runtime.executeTool(descriptor.toolName, descriptor.input, descriptor.context),
    });
    await Effect.runPromise(
      resume.parkDescriptor(approval, {
        kind: "tool.execute",
        toolName: "andy.memory.restart.memory.save",
        input: { key: "name" },
      }),
    );

    const result = await Effect.runPromise(resume.resumeApproved(approval.id));

    expect(result.output).toEqual({ saved: { key: "name" } });
  });

  test("plans plugin install with validated manifest permission summary", async () => {
    const source = {
      type: "github" as const,
      reference:
        "https://example.com/plugin.json?ref=0123456789012345678901234567890123456789",
    };
    const installer = new PluginInstaller({
      audit: new ConsoleAuditSink(),
      fetcher: new StaticPluginManifestFetcher(
        new Map([
          [
            source.reference,
            {
              id: "andy.test.install",
              name: "Install Test",
              version: "0.1.0",
              entry: "./plugin.ts",
              capabilities: ["memory.save"],
              risk: "low",
              source,
              permissions: {
                network: { allowedHosts: ["api.example.com"] },
              },
              tools: [
                {
                  name: "memory.save",
                  description: "Save memory.",
                  capabilities: ["memory.save"],
                  risk: "low",
                },
              ],
            },
          ],
        ]),
      ),
    });

    const plan = await Effect.runPromise(installer.plan(source));

    expect(plan.requiresApproval).toBe(true);
    expect(plan.permissionSummary).toContain("capability:memory.save");
    expect(plan.permissionSummary).toContain("network:api.example.com");
    expect(plan.pinnedSource.reference).toBe(source.reference);
  });

  test("installs planned plugin package disabled by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "andy-plugin-install-"));
    const source = {
      type: "github" as const,
      reference:
        "https://example.com/plugin.json?ref=0123456789012345678901234567890123456789",
    };
    const plan = {
      source,
      pinnedSource: source,
      manifest: {
        id: "andy.test.package",
        name: "Package Test",
        version: "0.1.0",
        entry: "./plugin.ts",
        capabilities: [],
        risk: "low" as const,
        source,
        tools: [],
      },
      requiresApproval: true,
      approvalReasons: ["review"],
      permissionSummary: [],
    };
    const installer = new LocalPluginPackageInstaller({
      audit: new ConsoleAuditSink(),
      installRoot: dir,
    });

    const installed = await Effect.runPromise(installer.install(plan));

    expect(installed.enabled).toBe(false);
    expect(installed.manifestPath).toContain("plugin.json");
  });

  test("runs manifest-declared tools through a worker plugin host", async () => {
    const audit = new ConsoleAuditSink();
    const host = new WorkerManifestPluginHost({ audit });
    const handle = await Effect.runPromise(
      host.startManifest({
        id: "andy.test.worker",
        name: "Worker Test",
        version: "0.1.0",
        entry: new URL("./worker-plugin-fixture.ts", import.meta.url).href,
        executionMode: "worker",
        capabilities: ["test.echo"],
        risk: "low",
        tools: [
          {
            name: "test.echo",
            description: "Echo input through the worker boundary.",
            capabilities: ["test.echo"],
            risk: "low",
          },
        ],
      }),
    );
    const runtime = new AgentRuntime({
      audit,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["test.echo"]),
      }),
    });
    await Effect.runPromise(runtime.registerPlugin(handle.plugin));

    const result = await Effect.runPromise(
      runtime.executeTool("andy.test.worker.test.echo", { ok: true }),
    );
    await Effect.runPromise(handle.stop());

    expect(result.output).toEqual({
      pluginId: "andy.test.worker",
      input: { ok: true },
    });
  });

  test("lifecycle manager starts hosted plugins and stops handles", async () => {
    const audit = new ConsoleAuditSink();
    const runtime = new AgentRuntime({
      audit,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["test.echo"]),
      }),
    });
    const lifecycle = new PluginLifecycleManager({
      audit,
      runtime,
      host: new WorkerManifestPluginHost({ audit }),
    });

    await Effect.runPromise(
      lifecycle.start({
        id: "andy.test.lifecycle",
        name: "Lifecycle Test",
        version: "0.1.0",
        entry: new URL("./worker-plugin-fixture.ts", import.meta.url).href,
        executionMode: "worker",
        capabilities: ["test.echo"],
        risk: "low",
        tools: [
          {
            name: "test.echo",
            description: "Echo input through the worker boundary.",
            capabilities: ["test.echo"],
            risk: "low",
          },
        ],
      }),
    );

    expect(runtime.listTools().map((tool) => tool.qualifiedName)).toContain(
      "andy.test.lifecycle.test.echo",
    );
    expect(lifecycle.list()).toHaveLength(1);
    await Effect.runPromise(lifecycle.stop("andy.test.lifecycle"));
    expect(lifecycle.list()).toHaveLength(0);
  });

  test("lifecycle stop disables runtime proxy tools", async () => {
    const audit = new ConsoleAuditSink();
    const runtime = new AgentRuntime({
      audit,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["test.echo"]),
      }),
    });
    const lifecycle = new PluginLifecycleManager({
      audit,
      runtime,
      host: new WorkerManifestPluginHost({ audit }),
    });
    await Effect.runPromise(
      lifecycle.start({
        id: "andy.test.disable-on-stop",
        name: "Disable On Stop",
        version: "0.1.0",
        entry: new URL("./worker-plugin-fixture.ts", import.meta.url).href,
        executionMode: "worker",
        capabilities: ["test.echo"],
        risk: "low",
        tools: [
          {
            name: "test.echo",
            description: "Echo input through the worker boundary.",
            capabilities: ["test.echo"],
            risk: "low",
          },
        ],
      }),
    );
    await Effect.runPromise(lifecycle.stop("andy.test.disable-on-stop"));

    const result = await Effect.runPromiseExit(
      runtime.executeTool("andy.test.disable-on-stop.test.echo", { ok: true }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("PluginDisabledError");
    }
  });

  test("lifecycle reports host health and restarts crashed handles", async () => {
    const audit = new ConsoleAuditSink();
    const runtime = new AgentRuntime({
      audit,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["test.echo"]),
      }),
    });
    let starts = 0;
    const host = {
      startManifest(manifest) {
        starts += 1;
        const startedAt = new Date();
        const handle: WorkerPluginHostHandle = {
          pluginId: manifest.id,
          executionMode: "worker",
          plugin: definePlugin({
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            capabilities: manifest.capabilities,
            tools: [
              defineTool({
                name: "test.echo",
                description: "Echo input.",
                capabilities: ["test.echo"],
                risk: "low",
                execute(input) {
                  return Effect.succeed(input);
                },
              }),
            ],
          }),
          health: () =>
            starts === 1
              ? {
                  status: "crashed",
                  pluginId: manifest.id,
                  executionMode: "worker",
                  startedAt,
                  crashedAt: new Date(),
                  reason: "test crash",
                }
              : {
                  status: "running",
                  pluginId: manifest.id,
                  executionMode: "worker",
                  startedAt,
                },
          stop: () => Effect.void,
        };
        return Effect.succeed(handle);
      },
    };
    const lifecycle = new PluginLifecycleManager({
      audit,
      runtime,
      host,
    });

    await Effect.runPromise(
      lifecycle.start({
        id: "andy.test.restart-crashed",
        name: "Restart Crashed",
        version: "0.1.0",
        entry: "./fixture.ts",
        executionMode: "worker",
        capabilities: ["test.echo"],
        risk: "low",
        tools: [
          {
            name: "test.echo",
            description: "Echo input.",
            capabilities: ["test.echo"],
            risk: "low",
          },
        ],
      }),
    );
    expect(lifecycle.health()[0]?.status).toBe("crashed");

    const result = await Effect.runPromise(lifecycle.restartCrashed());

    expect(result).toEqual([
      { pluginId: "andy.test.restart-crashed", status: "restarted" },
    ]);
    expect(lifecycle.health()[0]?.status).toBe("running");
  });

  test("lets sandboxed worker plugins request host APIs through RPC", async () => {
    const audit = new ConsoleAuditSink();
    const host = new WorkerManifestPluginHost({
      audit,
      hostApiHandler(request) {
        return Effect.succeed({
          capability: request.capability,
          toolName: request.toolName,
          input: request.input,
        });
      },
    });
    const handle = await Effect.runPromise(
      host.startManifest({
        id: "andy.test.worker-host-api",
        name: "Worker Host API Test",
        version: "0.1.0",
        entry: new URL("./worker-plugin-fixture.ts", import.meta.url).href,
        executionMode: "worker",
        capabilities: ["test.host_api", "memory.save"],
        risk: "low",
        tools: [
          {
            name: "test.host_api",
            description: "Ask the host to call memory.save.",
            capabilities: ["test.host_api"],
            risk: "low",
          },
        ],
      }),
    );
    const runtime = new AgentRuntime({
      audit,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["test.host_api"]),
      }),
    });
    await Effect.runPromise(runtime.registerPlugin(handle.plugin));

    const result = await Effect.runPromise(
      runtime.executeTool("andy.test.worker-host-api.test.host_api", {
        key: "color",
        value: "blue",
      }),
    );
    await Effect.runPromise(handle.stop());

    expect(result.output).toEqual({
      hostApi: {
        capability: "memory.save",
        toolName: "memory.save",
        input: {
          key: "color",
          value: "blue",
        },
      },
    });
  });

  test("default hosted plugin host API forwards through runtime tools", async () => {
    const runtime = new AgentRuntime({
      audit: new ConsoleAuditSink(),
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["memory.save"]),
      }),
    });
    Effect.runSync(
      runtime.registerPlugin(
        definePlugin({
          id: "andy.memory.markdown",
          name: "Markdown Memory",
          version: "0.1.0",
          capabilities: ["memory.save"],
          tools: [
            defineTool({
              name: "memory.save",
              description: "Save memory",
              capabilities: ["memory.save"],
              risk: "medium",
              execute(input) {
                return Effect.succeed({ saved: input });
              },
            }),
          ],
        }),
      ),
    );
    const api = new DefaultHostedPluginHostApi({ runtime });

    const output = await Effect.runPromise(
      api.call({
        type: "andy.host_api.call",
        requestId: "host-api",
        pluginId: "andy.test",
        capability: "memory.save",
        toolName: "memory.save",
        input: { key: "city", value: "Paris" },
      }),
    );

    expect(output).toEqual({ saved: { key: "city", value: "Paris" } });
  });

  test("background executor runs due jobs through runtime policy", async () => {
    const audit = new ConsoleAuditSink();
    const runtime = new AgentRuntime({
      audit,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["memory.save"]),
      }),
    });
    await Effect.runPromise(
      runtime.registerPlugin(
        definePlugin({
          id: "andy.background.memory",
          name: "Background Memory",
          version: "0.1.0",
          capabilities: ["memory.save"],
          tools: [
            defineTool({
              name: "memory.save",
              description: "Save memory.",
              capabilities: ["memory.save"],
              risk: "medium",
              execute(input) {
                return Effect.succeed({ saved: input });
              },
            }),
          ],
        }),
      ),
    );
    const scheduler = new BackgroundJobScheduler({ audit });
    await Effect.runPromise(
      scheduler.schedule({
        pluginId: "andy.background.memory",
        toolName: "andy.background.memory.memory.save",
        input: { key: "city" },
      }),
    );
    const executor = new BackgroundJobExecutor({ audit, scheduler, runtime });

    const [result] = await Effect.runPromise(executor.runDue());
    const [job] = await Effect.runPromise(scheduler.list());

    expect(result?.output).toEqual({ saved: { key: "city" } });
    expect(job?.status).toBe("completed");
  });

  test("requires strong isolation when requested", async () => {
    const result = await Effect.runPromiseExit(
      verifyProcessIsolationProfile(
        { kind: "process-boundary" },
        { requireStrongIsolation: true },
      ),
    );

    expect(result._tag).toBe("Failure");
  });

  test("builds binary plugin launch commands without Bun", async () => {
    const sandbox = await Effect.runPromise(
      new PluginSandboxFactory().create({ pluginId: "andy.test.binary-launch" }),
    );
    const command = await Effect.runPromise(
      buildSandboxedLaunchCommand({
        bunExecutable: "/missing/bun",
        entry: "/ignored/source.ts",
        binaryEntrypoint: "/plugins/example/dist/plugin",
        profile: { kind: "process-boundary" },
        sandbox,
      }),
    );
    await Effect.runPromise(sandbox.dispose());

    expect(command).toEqual({
      command: "/plugins/example/dist/plugin",
      args: [],
      runtime: "binary",
    });
  });

  test("creates daemon service graph", async () => {
    const daemon = await Effect.runPromise(
      createAndyDaemon({
        audit: new ConsoleAuditSink(),
        policy: new CapabilityPolicy({
          allowedCapabilities: new Set(),
        }),
      }),
    );

    expect(daemon.runtime.listTools()).toEqual([]);
    expect(daemon.communication.listMessages()).toEqual([]);
  });

  test("runs manifest-declared tools through a sandboxed subprocess host", async () => {
    const audit = new ConsoleAuditSink();
    const host = new SubprocessManifestPluginHost({ audit });
    const handle = await Effect.runPromise(
      host.startManifest({
        id: "andy.test.subprocess",
        name: "Subprocess Test",
        version: "0.1.0",
        entry: new URL("./subprocess-plugin-fixture.ts", import.meta.url).pathname,
        executionMode: "subprocess",
        capabilities: ["test.sandbox_echo"],
        risk: "low",
        tools: [
          {
            name: "test.sandbox_echo",
            description: "Echo input and persist it inside sandbox storage.",
            capabilities: ["test.sandbox_echo"],
            risk: "low",
          },
        ],
      }),
    );
    const runtime = new AgentRuntime({
      audit,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["test.sandbox_echo"]),
      }),
    });
    await Effect.runPromise(runtime.registerPlugin(handle.plugin));

    const result = await Effect.runPromise(
      runtime.executeTool("andy.test.subprocess.test.sandbox_echo", { ok: true }),
    );
    await Effect.runPromise(handle.stop());

    expect(result.output).toMatchObject({
      pluginId: "andy.test.subprocess",
      saved: { ok: true },
    });
    expect(result.output).toHaveProperty("sandboxRoot", handle.sandboxRoot);
  });

  test("loads first-party memory-markdown plugin through lifecycle", async () => {
    const audit = new ConsoleAuditSink();
    const manifestText = await readFile(
      resolve("plugins/memory-markdown/plugin.json"),
      "utf8",
    );
    const manifest = {
      ...parsePluginManifest(JSON.parse(manifestText)),
      entry: resolve("plugins/memory-markdown/src/index.ts"),
    };
    const runtime = new AgentRuntime({
      audit,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set([
          "memory.save",
          "memory.query",
          "memory.fetch",
          "memory.forget",
          "memory.list",
          "memory.save_fact",
          "filesystem.read",
          "filesystem.write",
        ]),
      }),
    });
    const lifecycle = new PluginLifecycleManager({
      audit,
      runtime,
      host: new SubprocessManifestPluginHost({ audit }),
    });
    await Effect.runPromise(lifecycle.start(manifest));

    const saved = await Effect.runPromise(
      runtime.executeTool("andy.memory.markdown.memory.save", {
        scope: "user",
        namespace: "preferences",
        key: "editor",
        value: "vim",
        tags: ["dev"],
      }),
    );
    const queried = await Effect.runPromise(
      runtime.executeTool("andy.memory.markdown.memory.query", {
        namespace: "preferences",
        key: "editor",
      }),
    );
    await Effect.runPromise(lifecycle.stop("andy.memory.markdown"));

    expect(saved.output).toMatchObject({
      scope: "user",
      namespace: "preferences",
      key: "editor",
      value: "vim",
    });
    expect(queried.output).toEqual([saved.output]);
  });

  test("loads first-party filesystem plugin with scoped roots", async () => {
    const audit = new ConsoleAuditSink();
    const dir = await mkdtemp(join(tmpdir(), "andy-filesystem-plugin-"));
    const readRoot = join(dir, "read");
    const writeRoot = join(dir, "write");
    const sensitiveRoot = join(dir, "sensitive");
    await mkdir(readRoot, { recursive: true });
    await mkdir(writeRoot, { recursive: true });
    await mkdir(sensitiveRoot, { recursive: true });
    await writeFile(join(readRoot, "note.txt"), "hello", "utf8");
    const manifestText = await readFile(
      resolve("plugins/filesystem/plugin.json"),
      "utf8",
    );
    const manifest = {
      ...parsePluginManifest(JSON.parse(manifestText)),
      entry: resolve("plugins/filesystem/src/index.ts"),
      permissions: {
        filesystem: {
          readRoots: [readRoot],
          writeRoots: [writeRoot],
          sensitiveReadRoots: [
            {
              path: sensitiveRoot,
              reason: "test sensitive read scope",
              dataClasses: ["other"],
            },
          ],
        },
      },
    };
    const runtime = new AgentRuntime({
      audit,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set([
          "filesystem.read",
          "filesystem.write",
          "filesystem.delete",
        ]),
      }),
    });
    const lifecycle = new PluginLifecycleManager({
      audit,
      runtime,
      host: new SubprocessManifestPluginHost({ audit }),
    });
    await Effect.runPromise(lifecycle.start(manifest));

    const read = await Effect.runPromise(
      runtime.executeTool("andy.filesystem.filesystem.read", {
        path: join(readRoot, "note.txt"),
      }),
    );
    const written = await Effect.runPromise(
      runtime.executeTool("andy.filesystem.filesystem.write", {
        path: join(writeRoot, "out.txt"),
        content: "saved",
      }),
    );
    const blocked = await Effect.runPromiseExit(
      runtime.executeTool("andy.filesystem.filesystem.read", {
        path: join(dir, "outside.txt"),
      }),
    );
    await Effect.runPromise(lifecycle.stop("andy.filesystem"));

    expect(read.output).toMatchObject({ content: "hello" });
    expect(written.output).toMatchObject({ path: join(writeRoot, "out.txt") });
    expect(blocked._tag).toBe("Failure");
  });

  test("loads shell plugin but parks execution for approval", async () => {
    const audit = new ConsoleAuditSink();
    const dir = await mkdtemp(join(tmpdir(), "andy-shell-plugin-"));
    const manifestText = await readFile(resolve("plugins/shell/plugin.json"), "utf8");
    const manifest = {
      ...parsePluginManifest(JSON.parse(manifestText)),
      entry: resolve("plugins/shell/src/index.ts"),
      permissions: {
        filesystem: {
          readRoots: [dir],
          writeRoots: [dir],
        },
      },
    };
    const approvals = new ApprovalManager({ audit });
    const runtime = new AgentRuntime({
      audit,
      approvalManager: approvals,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["shell.execute"]),
        approvalRequiredCapabilities: new Set(["shell.execute"]),
      }),
    });
    const lifecycle = new PluginLifecycleManager({
      audit,
      runtime,
      host: new SubprocessManifestPluginHost({ audit }),
    });
    await Effect.runPromise(lifecycle.start(manifest));

    const result = await Effect.runPromiseExit(
      runtime.executeTool("andy.shell.shell.execute", {
        command: "echo",
        args: ["hello"],
        cwd: dir,
      }),
    );
    await Effect.runPromise(lifecycle.stop("andy.shell"));

    expect(result._tag).toBe("Failure");
    expect(approvals.list()[0]?.toolName).toBe("andy.shell.shell.execute");
  });

  test("normalizes first-party Telegram and WhatsApp messages", async () => {
    const audit = new ConsoleAuditSink();
    const runtime = new AgentRuntime({
      audit,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set([
          "messaging.receive",
          "messaging.map_identity",
          "messaging.send",
          "messaging.manage_webhook",
          "messaging.read_contact",
        ]),
      }),
    });
    const lifecycle = new PluginLifecycleManager({
      audit,
      runtime,
      host: new SubprocessManifestPluginHost({ audit }),
    });
    const telegramManifest = {
      ...parsePluginManifest(
        JSON.parse(await readFile(resolve("plugins/telegram/plugin.json"), "utf8")),
      ),
      entry: resolve("plugins/telegram/src/index.ts"),
    };
    const whatsappManifest = {
      ...parsePluginManifest(
        JSON.parse(await readFile(resolve("plugins/whatsapp/plugin.json"), "utf8")),
      ),
      entry: resolve("plugins/whatsapp/src/index.ts"),
    };
    await Effect.runPromise(lifecycle.start(telegramManifest));
    await Effect.runPromise(lifecycle.start(whatsappManifest));

    const telegram = await Effect.runPromise(
      runtime.executeTool("andy.messaging.telegram.telegram.normalizeUpdate", {
        update_id: 1,
        message: {
          message_id: 2,
          chat: { id: 42 },
          from: { id: 7 },
          text: "hi",
        },
      }),
    );
    const whatsapp = await Effect.runPromise(
      runtime.executeTool("andy.messaging.whatsapp.whatsapp.normalizeWebhook", {
        payload: {
          entry: [
            {
              changes: [
                {
                  value: {
                    messages: [
                      { id: "wamid", from: "15551234567", text: { body: "hello" } },
                    ],
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    await Effect.runPromise(lifecycle.stopAll());

    expect(telegram.output).toMatchObject({
      provider: "telegram",
      conversationId: "42",
      senderId: "7",
      text: "hi",
    });
    expect(whatsapp.output).toMatchObject({
      messages: [
        {
          provider: "whatsapp",
          conversationId: "15551234567",
          text: "hello",
        },
      ],
    });
  });

  test("loads first-party browser plugin manifest tools", async () => {
    const audit = new ConsoleAuditSink();
    const runtime = new AgentRuntime({
      audit,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set([
          "browser.navigate",
          "browser.inspect",
          "browser.click",
          "browser.type",
          "browser.screenshot",
          "browser.submit_form",
        ]),
      }),
    });
    const lifecycle = new PluginLifecycleManager({
      audit,
      runtime,
      host: new SubprocessManifestPluginHost({ audit }),
    });
    const manifest = {
      ...parsePluginManifest(
        JSON.parse(await readFile(resolve("plugins/browser/plugin.json"), "utf8")),
      ),
      entry: resolve("plugins/browser/src/index.ts"),
    };

    await Effect.runPromise(lifecycle.start(manifest));
    const tools = runtime.listTools().map((tool) => tool.qualifiedName);
    await Effect.runPromise(lifecycle.stop("andy.browser"));

    expect(tools).toEqual(
      expect.arrayContaining([
        "andy.browser.browser.navigate",
        "andy.browser.browser.inspect",
        "andy.browser.browser.click",
        "andy.browser.browser.type",
        "andy.browser.browser.screenshot",
        "andy.browser.browser.submit_form",
      ]),
    );
  });

  test("loads first-party background, notification, swarm, persistent memory, and semantic memory plugins", async () => {
    const audit = new ConsoleAuditSink();
    const runtime = new AgentRuntime({
      audit,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set([
          "background.run",
          "background.schedule",
          "background.cancel",
          "notification.send",
          "notification.approval_request",
          "swarm.plan",
          "swarm.spawn",
          "swarm.delegate",
          "swarm.join",
          "swarm.cancel",
          "memory.save",
          "memory.save_fact",
          "memory.fetch",
          "memory.query",
          "memory.list",
          "memory.forget",
          "memory.embed",
          "memory.semantic_query",
        ]),
      }),
    });
    const lifecycle = new PluginLifecycleManager({
      audit,
      runtime,
      host: new SubprocessManifestPluginHost({ audit }),
    });
    const manifests = await Promise.all(
      [
        "background-worker",
        "notifications",
        "swarm-orchestrator",
        "memory-persistent",
        "memory-semantic",
      ].map(async (name) => ({
        ...parsePluginManifest(
          JSON.parse(await readFile(resolve(`plugins/${name}/plugin.json`), "utf8")),
        ),
        entry: resolve(`plugins/${name}/src/index.ts`),
      })),
    );
    for (const manifest of manifests) {
      await Effect.runPromise(lifecycle.start(manifest));
    }

    const scheduled = await Effect.runPromise(
      runtime.executeTool("andy.background-worker.background.schedule", {
        taskName: "refresh",
        delayMs: 1000,
        payload: { kind: "test" },
      }),
    );
    const cancelled = await Effect.runPromise(
      runtime.executeTool("andy.background-worker.background.cancel", {
        id: String((scheduled.output as { id?: unknown }).id),
      }),
    );
    const notification = await Effect.runPromise(
      runtime.executeTool("andy.notifications.notification.send", {
        text: "done",
      }),
    );
    const swarm = await Effect.runPromise(
      runtime.executeTool("andy.swarm-orchestrator.swarm.spawn", {
        goal: "review changes",
        roles: ["planner", "reviewer"],
      }),
    );
    const swarmOutput = swarm.output as {
      id: string;
      agents: readonly { id: string }[];
    };
    const delegated = await Effect.runPromise(
      runtime.executeTool("andy.swarm-orchestrator.swarm.delegate", {
        swarmId: swarmOutput.id,
        agentId: swarmOutput.agents[0]?.id,
        task: "inspect tests",
      }),
    );
    const persistentSaved = await Effect.runPromise(
      runtime.executeTool("andy.memory.persistent.memory.save", {
        key: "theme",
        value: "dark",
        namespace: "preferences",
      }),
    );
    const persistentQuery = await Effect.runPromise(
      runtime.executeTool("andy.memory.persistent.memory.query", {
        namespace: "preferences",
        key: "theme",
      }),
    );
    const semanticSaved = await Effect.runPromise(
      runtime.executeTool("andy.memory.semantic.memory.save", {
        key: "project",
        text: "Andy is a plugin-native agent runtime",
        tags: ["architecture"],
      }),
    );
    const semanticQuery = await Effect.runPromise(
      runtime.executeTool("andy.memory.semantic.memory.semantic_query", {
        text: "plugin runtime",
        tags: ["architecture"],
      }),
    );
    await Effect.runPromise(lifecycle.stopAll());

    expect(cancelled.output).toMatchObject({ status: "cancelled" });
    expect(notification.output).toMatchObject({ sent: true, text: "done" });
    expect(delegated.output).toMatchObject({
      swarmId: swarmOutput.id,
      agent: { task: "inspect tests" },
    });
    expect(persistentSaved.output).toMatchObject({
      key: "theme",
      value: "dark",
    });
    expect(persistentQuery.output).toEqual([persistentSaved.output]);
    expect(semanticSaved.output).toMatchObject({ key: "project" });
    expect(semanticQuery.output).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "project" })]),
    );
  });

  test("rejects tools that declare they cannot run in a sandboxed host", async () => {
    const host = new SubprocessManifestPluginHost({ audit: new ConsoleAuditSink() });
    const result = await Effect.runPromiseExit(
      host.startManifest({
        id: "andy.test.host-only",
        name: "Host Only Test",
        version: "0.1.0",
        entry: new URL("./subprocess-plugin-fixture.ts", import.meta.url).pathname,
        executionMode: "subprocess",
        capabilities: ["desktop.keyboard"],
        risk: "high",
        tools: [
          {
            name: "desktop.keyboard",
            description: "A host-only desktop control tool.",
            capabilities: ["desktop.keyboard"],
            risk: "high",
            sandbox: {
              compatibleExecutionModes: ["trusted-in-process"],
              requiresHostPrivileges: true,
              reason: "Desktop keyboard control needs the host accessibility session.",
            },
          },
        ],
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("ToolSandboxIncompatibleError");
    }
  });
});
