import { ConsoleAuditSink } from "@andy/audit";
import { definePlugin, defineTool } from "@andy/plugin-sdk";
import { CapabilityPolicy } from "@andy/policy";
import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import { buildAiSdkTools } from "./ai-tools.js";
import { ApprovalManager } from "./approvals.js";
import { BackgroundJobScheduler } from "./background.js";
import { InMemoryEventBus } from "./events.js";
import { AgentRuntime } from "./runtime.js";
import { InMemorySecretBroker } from "./secrets.js";
import { TraceManager } from "./tracing.js";

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
});
