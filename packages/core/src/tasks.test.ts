import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import { DurableTaskEngine } from "./tasks.js";

describe("DurableTaskEngine", () => {
  test("creates runs, leases ready steps, unlocks dependencies, and hydrates", async () => {
    const engine = new DurableTaskEngine();
    const graph = await Effect.runPromise(
      engine.registerGraph({
        name: "test graph",
        version: "0.1.0",
        steps: [
          {
            id: "read",
            name: "Read",
            toolName: "andy.filesystem.filesystem.read",
            input: { path: "README.md" },
            retry: { maxAttempts: 2, backoffMs: 10 },
          },
          {
            id: "write",
            name: "Write",
            toolName: "andy.filesystem.filesystem.write",
            input: { path: "out.txt", content: "ok" },
            dependsOn: ["read"],
            approvalRequired: true,
          },
        ],
      }),
    );
    const run = await Effect.runPromise(
      engine.createRun({
        graphId: graph.id,
        idempotencyKey: "same-task",
      }),
    );
    const sameRun = await Effect.runPromise(
      engine.createRun({
        graphId: graph.id,
        idempotencyKey: "same-task",
      }),
    );
    expect(sameRun.id).toBe(run.id);

    const ready = await Effect.runPromise(engine.readySteps(run.id));
    expect(ready.map((step) => step.definitionId)).toEqual(["read"]);

    const leased = await Effect.runPromise(
      engine.acquireLease({
        runId: run.id,
        stepId: ready[0]?.id ?? "",
        holderId: "worker-1",
        leaseMs: 1000,
      }),
    );
    expect(leased?.status).toBe("leased");

    const afterFirst = await Effect.runPromise(
      engine.completeStep({
        runId: run.id,
        stepId: ready[0]?.id ?? "",
        output: { ok: true },
      }),
    );
    expect(afterFirst?.status).toBe("running");

    const next = await Effect.runPromise(engine.readySteps(run.id));
    expect(next.map((step) => step.definitionId)).toEqual(["write"]);

    const snapshot = engine.snapshot();
    const hydrated = new DurableTaskEngine();
    await Effect.runPromise(hydrated.hydrate(snapshot));
    expect(hydrated.listRuns()).toHaveLength(1);
  });

  test("schedules retry before failing a step permanently", async () => {
    const engine = new DurableTaskEngine();
    const graph = await Effect.runPromise(
      engine.registerGraph({
        name: "retry graph",
        version: "0.1.0",
        steps: [
          {
            id: "step",
            name: "Step",
            toolName: "andy.shell.shell.execute",
            input: { command: "false" },
            retry: { maxAttempts: 2, backoffMs: 50 },
          },
        ],
      }),
    );
    const run = await Effect.runPromise(engine.createRun({ graphId: graph.id }));
    const [step] = await Effect.runPromise(engine.readySteps(run.id));
    const leased = await Effect.runPromise(
      engine.acquireLease({
        runId: run.id,
        stepId: step?.id ?? "",
        holderId: "worker-1",
        leaseMs: 1000,
      }),
    );
    const retried = await Effect.runPromise(
      engine.failStep({
        runId: run.id,
        stepId: leased?.id ?? "",
        error: "boom",
      }),
    );
    expect(retried?.steps[0]?.status).toBe("ready");
    expect(retried?.steps[0]?.runAfter).toBeInstanceOf(Date);
  });
});
