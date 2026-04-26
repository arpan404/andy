import { ConsoleAuditSink } from "@andy/audit";
import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import { AgentKernel } from "./agent-kernel.js";
import { createFakeAiTextResult, FakeLlmRunner } from "./llm-test-helpers.js";
import { SwarmCoordinator } from "./swarm.js";
import { createRuntime } from "./test-helpers.js";

describe("SwarmCoordinator", () => {
  test("runs bounded child agent sessions", async () => {
    const runtime = createRuntime([]);
    const audit = new ConsoleAuditSink();
    const agent = new AgentKernel({
      runtime,
      audit,
      llm: new FakeLlmRunner([
        createFakeAiTextResult({ text: "parent done" }),
        createFakeAiTextResult({ text: "worker done" }),
        createFakeAiTextResult({ text: "reviewer done" }),
      ]),
    });
    const parent = await Effect.runPromise(agent.run({ userMessage: "parent task" }));
    const swarm = new SwarmCoordinator({ agentKernel: agent, audit });

    const result = await Effect.runPromise(
      swarm.run({
        parentSessionId: parent.session.id,
        limits: {
          maxAgents: 2,
          maxDepth: 1,
          allowedRoles: new Set(["worker", "reviewer"]),
        },
        tasks: [
          { role: "worker", userMessage: "implement" },
          { role: "reviewer", userMessage: "review" },
        ],
      }),
    );

    expect(result.results.map((item) => item.response)).toEqual([
      "worker done",
      "reviewer done",
    ]);
  });

  test("rejects swarms above max agent count", async () => {
    const audit = new ConsoleAuditSink();
    const agent = new AgentKernel({
      runtime: createRuntime([]),
      audit,
      llm: new FakeLlmRunner([createFakeAiTextResult({ text: "unused" })]),
    });
    const swarm = new SwarmCoordinator({ agentKernel: agent, audit });

    const result = await Effect.runPromiseExit(
      swarm.run({
        parentSessionId: "missing-parent",
        limits: {
          maxAgents: 1,
          maxDepth: 1,
          allowedRoles: new Set(["worker"]),
        },
        tasks: [
          { role: "worker", userMessage: "one" },
          { role: "worker", userMessage: "two" },
        ],
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("SwarmLimitExceededError");
    }
  });
});
