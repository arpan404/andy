import { ConsoleAuditSink } from "@andy/audit";
import { definePlugin, defineTool } from "@andy/plugin-sdk";
import { CapabilityPolicy } from "@andy/policy";
import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import { AgentRuntime } from "./runtime.js";
import { ApprovalManager } from "./approvals.js";
import { ApprovalResumeEngine } from "./approval-resume.js";
import { CancellationRegistry } from "./cancellation.js";
import { createRuntime, registerMemorySavePlugin } from "./test-helpers.js";

describe("AgentRuntime tool names", () => {
  test("registers tools with fully qualified names", async () => {
    const runtime = createRuntime(["memory.save"]);
    registerMemorySavePlugin(runtime);

    expect(runtime.listTools()).toEqual([
      expect.objectContaining({
        name: "andy.memory.markdown.memory.save",
        qualifiedName: "andy.memory.markdown.memory.save",
        pluginId: "andy.memory.markdown",
        localName: "memory.save",
        localAlias: "memory.save",
        isLocalNameAmbiguous: false,
      }),
    ]);

    const result = await Effect.runPromise(
      runtime.executeTool("andy.memory.markdown.memory.save", {}),
    );

    expect(result.output).toMatchObject({ saved: true });
  });

  test("allows unambiguous local tool aliases", async () => {
    const runtime = createRuntime(["memory.save"]);
    registerMemorySavePlugin(runtime);

    const result = await Effect.runPromise(runtime.executeTool("memory.save", {}));

    expect(result.output).toMatchObject({ saved: true });
  });

  test("rejects ambiguous local tool aliases", async () => {
    const runtime = createRuntime(["memory.save"]);
    for (const pluginId of ["andy.memory.markdown", "andy.memory.sqlite"]) {
      Effect.runSync(
        runtime.registerPlugin(
          definePlugin({
            id: pluginId,
            name: pluginId,
            version: "0.1.0",
            capabilities: ["memory.save"],
            tools: [
              defineTool({
                name: "memory.save",
                description: "Save memory",
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
    }

    const result = await Effect.runPromiseExit(runtime.executeTool("memory.save", {}));

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("ToolNameAmbiguousError");
    }
  });

  test("keeps duplicate local tool names distinguishable by fully qualified names", async () => {
    const runtime = createRuntime(["memory.save"]);
    registerMemorySavePlugin(runtime, "andy.memory.markdown");
    registerMemorySavePlugin(runtime, "andy.memory.persistent");

    expect(runtime.listTools()).toEqual([
      expect.objectContaining({
        name: "andy.memory.markdown.memory.save",
        qualifiedName: "andy.memory.markdown.memory.save",
        pluginId: "andy.memory.markdown",
        localName: "memory.save",
        isLocalNameAmbiguous: true,
      }),
      expect.objectContaining({
        name: "andy.memory.persistent.memory.save",
        qualifiedName: "andy.memory.persistent.memory.save",
        pluginId: "andy.memory.persistent",
        localName: "memory.save",
        isLocalNameAmbiguous: true,
      }),
    ]);

    const result = await Effect.runPromise(
      runtime.executeTool("andy.memory.persistent.memory.save", {}),
    );

    expect(result.output).toMatchObject({ saved: true });
  });

  test("blocks tools from disabled plugins", async () => {
    const runtime = createRuntime(["memory.save"]);
    registerMemorySavePlugin(runtime);
    await Effect.runPromise(runtime.disablePlugin("andy.memory.markdown"));

    const result = await Effect.runPromiseExit(runtime.executeTool("memory.save", {}));

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("PluginDisabledError");
    }
  });

  test("requires approval when untrusted provenance reaches external side effects", async () => {
    const runtime = createRuntime(["messaging.send"]);
    Effect.runSync(
      runtime.registerPlugin(
        definePlugin({
          id: "andy.messaging.test",
          name: "Test Messaging",
          version: "0.1.0",
          capabilities: ["messaging.send"],
          tools: [
            defineTool({
              name: "messaging.send",
              description: "Send a message",
              capabilities: ["messaging.send"],
              risk: "low",
              execute() {
                return Effect.succeed({ sent: true });
              },
            }),
          ],
        }),
      ),
    );

    const result = await Effect.runPromiseExit(
      runtime.executeTool(
        "andy.messaging.test.messaging.send",
        { text: "send this" },
        {
          provenance: [
            {
              sourceId: "email-1",
              sourceType: "email",
              trust: "untrusted",
              domain: "mail.example",
            },
          ],
        },
      ),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("ToolApprovalRequiredError");
      expect(String(result.cause)).toContain("untrusted source");
    }
  });

  test("gates host API calls by the caller plugin manifest", async () => {
    const runtime = createRuntime(["agent.respond", "memory.save"]);
    registerMemorySavePlugin(runtime);
    Effect.runSync(
      runtime.registerPlugin(
        definePlugin({
          id: "andy.agent",
          name: "Agent",
          version: "0.1.0",
          capabilities: ["agent.respond"],
          tools: [
            defineTool({
              name: "agent.respond",
              description: "Try to save memory without declaring memory.save.",
              capabilities: ["agent.respond"],
              risk: "low",
              execute(_input, context) {
                return context.host.memory.save({
                  scope: "agent",
                  namespace: "test",
                  key: "blocked",
                  value: true,
                });
              },
            }),
          ],
        }),
      ),
    );

    const result = await Effect.runPromiseExit(
      runtime.executeTool("agent.respond", {}),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("PluginHostCapabilityDeniedError");
    }
  });

  test("forwards approved host API calls through policy and tools", async () => {
    const runtime = createRuntime(["agent.respond", "memory.save"]);
    registerMemorySavePlugin(runtime);
    Effect.runSync(
      runtime.registerPlugin(
        definePlugin({
          id: "andy.agent",
          name: "Agent",
          version: "0.1.0",
          capabilities: ["agent.respond", "memory.save"],
          tools: [
            defineTool({
              name: "agent.respond",
              description: "Save memory through the host API.",
              capabilities: ["agent.respond"],
              risk: "low",
              execute(_input, context) {
                return context.host.memory.save({
                  scope: "agent",
                  namespace: "test",
                  key: "allowed",
                  value: true,
                });
              },
            }),
          ],
        }),
      ),
    );

    const result = await Effect.runPromise(runtime.executeTool("agent.respond", {}));

    expect(result.output).toMatchObject({ saved: true });
  });

  test("rejects unsandboxed tools unless the plugin is explicitly trusted", async () => {
    const runtime = createRuntime(["desktop.keyboard"]);
    const result = await Effect.runPromiseExit(
      runtime.registerPlugin(
        definePlugin({
          id: "andy.desktop",
          name: "Desktop",
          version: "0.1.0",
          capabilities: ["desktop.keyboard"],
          tools: [
            defineTool({
              name: "desktop.keyboard",
              description: "Control the host keyboard.",
              capabilities: ["desktop.keyboard"],
              risk: "high",
              sandbox: {
                isolation: "unsandboxed",
                compatibleExecutionModes: ["trusted-in-process"],
                requiresHostPrivileges: true,
                reason: "Desktop control needs the host accessibility session.",
              },
              execute() {
                return Effect.succeed({ typed: true });
              },
            }),
          ],
        }),
      ),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("ToolHostPrivilegeDeniedError");
    }
  });

  test("allows unsandboxed tools only for local trusted plugins", async () => {
    const runtime = new AgentRuntime({
      audit: new ConsoleAuditSink(),
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["desktop.keyboard"]),
      }),
      hostPrivilegePolicy: {
        allowedPluginIds: new Set(["andy.desktop"]),
      },
    });

    await Effect.runPromise(
      runtime.registerPlugin(
        definePlugin({
          id: "andy.desktop",
          name: "Desktop",
          version: "0.1.0",
          source: {
            type: "local",
            reference: "first-party",
          },
          capabilities: ["desktop.keyboard"],
          tools: [
            defineTool({
              name: "desktop.keyboard",
              description: "Control the host keyboard.",
              capabilities: ["desktop.keyboard"],
              risk: "high",
              sandbox: {
                isolation: "unsandboxed",
                compatibleExecutionModes: ["trusted-in-process"],
                requiresHostPrivileges: true,
                reason: "Desktop control needs the host accessibility session.",
              },
              execute() {
                return Effect.succeed({ typed: true });
              },
            }),
          ],
        }),
      ),
    );

    const result = await Effect.runPromise(runtime.executeTool("desktop.keyboard", {}));

    expect(result.output).toEqual({ typed: true });
  });

  test("parks approval-gated tool calls and resumes the exact action", async () => {
    const audit = new ConsoleAuditSink();
    const approvals = new ApprovalManager({ audit });
    const approvalResume = new ApprovalResumeEngine({ approvals });
    let executionCount = 0;
    const runtime = new AgentRuntime({
      audit,
      approvalManager: approvals,
      approvalResume,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["memory.save"]),
        approvalRequiredCapabilities: new Set(["memory.save"]),
      }),
    });
    await Effect.runPromise(
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
                executionCount += 1;
                return Effect.succeed({ saved: input });
              },
            }),
          ],
        }),
      ),
    );

    const requested = await Effect.runPromiseExit(
      runtime.executeTool("memory.save", { key: "city", value: "Kathmandu" }),
    );
    const [approval] = approvals.list();

    expect(requested._tag).toBe("Failure");
    expect(executionCount).toBe(0);
    expect(approval).toBeDefined();
    expect(approvalResume.listParked()).toHaveLength(1);

    const resumed = await Effect.runPromise(
      approvalResume.resumeApproved(approval?.id ?? ""),
    );

    expect(resumed.output).toEqual({
      saved: { key: "city", value: "Kathmandu" },
    });
    expect(executionCount).toBe(1);
    expect(approvalResume.listParked()).toHaveLength(0);
  });

  test("validates tool input and output schemas at the runtime boundary", async () => {
    const runtime = new AgentRuntime({
      audit: new ConsoleAuditSink(),
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["memory.save"]),
      }),
    });
    await Effect.runPromise(
      runtime.registerPlugin(
        definePlugin({
          id: "andy.schema",
          name: "Schema Test",
          version: "0.1.0",
          capabilities: ["memory.save"],
          tools: [
            defineTool({
              name: "memory.save",
              description: "Save memory",
              capabilities: ["memory.save"],
              risk: "medium",
              inputSchema: {
                type: "object",
                required: ["key"],
                properties: {
                  key: { type: "string" },
                },
              },
              outputSchema: {
                type: "object",
                required: ["saved"],
              },
              execute(input) {
                return Effect.succeed({ saved: input });
              },
            }),
          ],
        }),
      ),
    );

    const invalid = await Effect.runPromiseExit(
      runtime.executeTool("andy.schema.memory.save", { value: "missing key" }),
    );
    const valid = await Effect.runPromise(
      runtime.executeTool("andy.schema.memory.save", { key: "city" }),
    );

    expect(invalid._tag).toBe("Failure");
    expect(valid.output).toEqual({ saved: { key: "city" } });
  });

  test("uses full JSON Schema validation features through AJV", async () => {
    const runtime = new AgentRuntime({
      audit: new ConsoleAuditSink(),
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["memory.save"]),
      }),
    });
    await Effect.runPromise(
      runtime.registerPlugin(
        definePlugin({
          id: "andy.schema.enum",
          name: "Schema Enum Test",
          version: "0.1.0",
          capabilities: ["memory.save"],
          tools: [
            defineTool({
              name: "memory.save",
              description: "Save memory",
              capabilities: ["memory.save"],
              risk: "medium",
              inputSchema: {
                type: "object",
                properties: {
                  scope: { enum: ["user", "project"] },
                },
                required: ["scope"],
                additionalProperties: false,
              },
              execute(input) {
                return Effect.succeed({ saved: input });
              },
            }),
          ],
        }),
      ),
    );

    const invalid = await Effect.runPromiseExit(
      runtime.executeTool("andy.schema.enum.memory.save", {
        scope: "system",
        extra: true,
      }),
    );

    expect(invalid._tag).toBe("Failure");
  });

  test("does not start cancelled tool executions", async () => {
    const cancellation = new CancellationRegistry();
    const token = await Effect.runPromise(cancellation.create());
    await Effect.runPromise(cancellation.cancel(token.id, "user stopped task"));
    let executed = false;
    const runtime = new AgentRuntime({
      audit: new ConsoleAuditSink(),
      cancellation,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["memory.save"]),
      }),
    });
    await Effect.runPromise(
      runtime.registerPlugin(
        definePlugin({
          id: "andy.cancel",
          name: "Cancel Test",
          version: "0.1.0",
          capabilities: ["memory.save"],
          tools: [
            defineTool({
              name: "memory.save",
              description: "Save memory",
              capabilities: ["memory.save"],
              risk: "medium",
              execute(input) {
                executed = true;
                return Effect.succeed({ saved: input });
              },
            }),
          ],
        }),
      ),
    );

    const result = await Effect.runPromiseExit(
      runtime.executeTool(
        "andy.cancel.memory.save",
        { key: "city" },
        { cancellationTokenId: token.id },
      ),
    );

    expect(result._tag).toBe("Failure");
    expect(String(result)).toContain("ToolCancelledError");
    expect(executed).toBe(false);
  });

  test("interrupts active tool execution when cancellation is requested", async () => {
    const cancellation = new CancellationRegistry();
    const token = await Effect.runPromise(cancellation.create());
    let interrupted = false;
    const runtime = new AgentRuntime({
      audit: new ConsoleAuditSink(),
      cancellation,
      policy: new CapabilityPolicy({
        allowedCapabilities: new Set(["memory.save"]),
      }),
    });
    await Effect.runPromise(
      runtime.registerPlugin(
        definePlugin({
          id: "andy.active-cancel",
          name: "Active Cancel Test",
          version: "0.1.0",
          capabilities: ["memory.save"],
          tools: [
            defineTool({
              name: "memory.save",
              description: "Save memory slowly",
              capabilities: ["memory.save"],
              risk: "medium",
              execute() {
                return Effect.async((_resume) =>
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                );
              },
            }),
          ],
        }),
      ),
    );

    setTimeout(() => {
      void Effect.runPromise(cancellation.cancel(token.id, "stop active tool"));
    }, 10);

    const result = await Effect.runPromiseExit(
      runtime.executeTool(
        "andy.active-cancel.memory.save",
        { key: "city" },
        { cancellationTokenId: token.id },
      ),
    );

    expect(result._tag).toBe("Failure");
    expect(String(result)).toContain("ToolCancelledError");
    expect(interrupted).toBe(true);
  });
});
