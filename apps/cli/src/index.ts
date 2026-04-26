#!/usr/bin/env node
import { ConsoleAuditSink } from "@andy/audit";
import { AgentRuntime } from "@andy/core";
import { definePlugin, defineTool } from "@andy/plugin-sdk";
import { CapabilityPolicy } from "@andy/policy";
import { Effect } from "effect";

const corePlugin = definePlugin({
  id: "andy.core",
  name: "Andy Core Tools",
  version: "0.1.0",
  capabilities: ["agent.respond"],
  tools: [
    defineTool({
      name: "agent.respond",
      description: "Return a direct response through the plugin execution path.",
      capabilities: ["agent.respond"],
      risk: "low",
      execute(input: { message: string }, context) {
        return Effect.gen(function* () {
          yield* context.scratchFs.writeFile("last-message.txt", input.message.trim());
          return {
            message:
              input.message.trim().length > 0
                ? `Andy plugin runtime received: ${input.message}`
                : "Andy plugin runtime is ready.",
          };
        });
      },
    }),
  ],
});

const audit = new ConsoleAuditSink();
const policy = new CapabilityPolicy({
  allowedCapabilities: new Set(["agent.respond"]),
});

const runtime = new AgentRuntime({ audit, policy });
Effect.runSync(runtime.registerPlugin(corePlugin));

const message = process.argv.slice(2).join(" ");
const result = await Effect.runPromise(
  runtime.executeTool<{ message: string }>("agent.respond", {
    message,
  }),
);

console.log(result.output.message);
