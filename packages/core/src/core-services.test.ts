import { ConsoleAuditSink } from "@andy/audit";
import { definePlugin, defineTool } from "@andy/plugin-sdk";
import { CapabilityPolicy } from "@andy/policy";
import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAiSdkTools } from "./ai-tools.js";
import { ApprovalManager } from "./approvals.js";
import { BackgroundJobScheduler } from "./background.js";
import { CancellationRegistry, withTimeout } from "./cancellation.js";
import { CommunicationBridge } from "./communication.js";
import { InMemoryEventBus } from "./events.js";
import { AgentRuntime } from "./runtime.js";
import { InMemorySecretBroker } from "./secrets.js";
import { JsonFileCoreStateStore } from "./state.js";
import { TraceManager } from "./tracing.js";
import {
  SubprocessManifestPluginHost,
  WorkerManifestPluginHost,
} from "./plugin-host.js";

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
    const store = new JsonFileCoreStateStore(join(dir, "state.json"));
    await Effect.runPromise(
      store.save({
        plugins: [],
        sessions: [],
        approvals: [],
        backgroundJobs: [],
      }),
    );

    const loaded = await Effect.runPromise(store.load());

    expect(loaded).toEqual({
      plugins: [],
      sessions: [],
      approvals: [],
      backgroundJobs: [],
    });
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
