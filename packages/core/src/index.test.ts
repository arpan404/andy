import { ConsoleAuditSink } from "@andy/audit";
import { definePlugin, defineTool } from "@andy/plugin-sdk";
import { CapabilityPolicy } from "@andy/policy";
import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import { AgentRuntime } from "./index.js";

describe("AgentRuntime tool names", () => {
  test("registers tools with fully qualified names", async () => {
    const runtime = createRuntime(["memory.save"]);
    const plugin = definePlugin({
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
          execute() {
            return Effect.succeed({ saved: true });
          },
        }),
      ],
    });

    Effect.runSync(runtime.registerPlugin(plugin));

    expect(runtime.listTools()).toEqual([
      {
        name: "andy.memory.markdown.memory.save",
        pluginId: "andy.memory.markdown",
        localName: "memory.save",
      },
    ]);

    const result = await Effect.runPromise(
      runtime.executeTool<{ saved: boolean }>("andy.memory.markdown.memory.save", {}),
    );

    expect(result.output.saved).toBe(true);
  });

  test("allows unambiguous local tool aliases", async () => {
    const runtime = createRuntime(["memory.save"]);
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
              execute() {
                return Effect.succeed({ saved: true });
              },
            }),
          ],
        }),
      ),
    );

    const result = await Effect.runPromise(
      runtime.executeTool<{ saved: boolean }>("memory.save", {}),
    );

    expect(result.output.saved).toBe(true);
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
});

function createRuntime(allowedCapabilities: string[]): AgentRuntime {
  return new AgentRuntime({
    audit: new ConsoleAuditSink(),
    policy: new CapabilityPolicy({
      allowedCapabilities: new Set(allowedCapabilities),
    }),
  });
}
