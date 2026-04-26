import { ConsoleAuditSink } from "@andy/audit";
import { definePlugin, defineTool } from "@andy/plugin-sdk";
import { CapabilityPolicy } from "@andy/policy";
import { Effect } from "effect";
import { AgentRuntime } from "./runtime.js";

export function createRuntime(allowedCapabilities: string[]): AgentRuntime {
  return new AgentRuntime({
    audit: new ConsoleAuditSink(),
    policy: new CapabilityPolicy({
      allowedCapabilities: new Set(allowedCapabilities),
    }),
  });
}

export function registerMemorySavePlugin(
  runtime: AgentRuntime,
  pluginId = "andy.memory.markdown",
): void {
  Effect.runSync(
    runtime.registerPlugin(
      definePlugin({
        id: pluginId,
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
              return Effect.succeed({ saved: true, input });
            },
          }),
        ],
      }),
    ),
  );
}
