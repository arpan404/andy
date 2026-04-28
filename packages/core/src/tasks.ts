import type { AuditSink } from "@andy/audit";
import type { JsonValue } from "@andy/types";
import { Effect } from "effect";

export type DurableTaskRunStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type DurableTaskStepStatus =
  | "pending"
  | "ready"
  | "leased"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "compensated"
  | "skipped";

export interface DurableTaskRetryPolicy {
  maxAttempts: number;
  backoffMs: number;
}

export interface DurableTaskTimeoutPolicy {
  timeoutMs: number;
}

export interface DurableTaskStepDefinition {
  id: string;
  name: string;
  toolName: string;
  input: JsonValue;
  dependsOn?: readonly string[];
  retry?: DurableTaskRetryPolicy;
  timeout?: DurableTaskTimeoutPolicy;
  idempotencyKey?: string;
  compensation?: {
    toolName: string;
    input: JsonValue;
  };
  approvalRequired?: boolean;
  metadata?: JsonValue;
}

export interface DurableTaskGraph {
  id: string;
  name: string;
  version: string;
  trigger?: DurableTaskTrigger;
  steps: readonly DurableTaskStepDefinition[];
  createdAt: Date;
  updatedAt: Date;
}

export type DurableTaskTrigger =
  | { type: "manual" }
  | { type: "event"; eventType: string }
  | { type: "cron"; expression: string }
  | { type: "webhook"; route: string };

export interface DurableTaskStepState {
  id: string;
  definitionId: string;
  status: DurableTaskStepStatus;
  attempts: number;
  updatedAt: Date;
  runAfter?: Date;
  lease?: {
    holderId: string;
    expiresAt: Date;
  };
  approvalId?: string;
  error?: string;
  output?: JsonValue;
}

export interface DurableTaskRun {
  id: string;
  graphId: string;
  status: DurableTaskRunStatus;
  input: JsonValue;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
  pausedReason?: string;
  steps: readonly DurableTaskStepState[];
}

export interface DurableTaskSnapshot {
  graphs: readonly DurableTaskGraph[];
  runs: readonly DurableTaskRun[];
}

type DurableTaskStepPatch = Omit<Partial<DurableTaskStepState>, "lease"> & {
  lease?: DurableTaskStepState["lease"] | undefined;
};

export class DurableTaskEngine {
  readonly #audit: AuditSink | undefined;
  readonly #graphs = new Map<string, DurableTaskGraph>();
  readonly #runs = new Map<string, DurableTaskRun>();

  constructor(options: { audit?: AuditSink } = {}) {
    this.#audit = options.audit;
  }

  registerGraph(
    graph: Omit<DurableTaskGraph, "id" | "createdAt" | "updatedAt"> & {
      id?: string;
    },
  ): Effect.Effect<DurableTaskGraph, Error> {
    const self = this;
    return Effect.fn("DurableTaskEngine.registerGraph")(function* () {
      validateGraph(graph.steps);
      const now = new Date();
      const taskGraph: DurableTaskGraph = {
        id: graph.id ?? crypto.randomUUID(),
        name: graph.name,
        version: graph.version,
        ...(graph.trigger ? { trigger: graph.trigger } : {}),
        steps: graph.steps,
        createdAt: now,
        updatedAt: now,
      };
      self.#graphs.set(taskGraph.id, taskGraph);
      yield* self.#record({
        type: "task.graph.created",
        taskGraphId: taskGraph.id,
        stepCount: taskGraph.steps.length,
      });
      return taskGraph;
    })();
  }

  createRun(input: {
    graphId: string;
    input?: JsonValue;
    idempotencyKey?: string;
  }): Effect.Effect<DurableTaskRun, Error> {
    const self = this;
    return Effect.fn("DurableTaskEngine.createRun")(function* () {
      const graph = self.#graphs.get(input.graphId);
      if (!graph) {
        return yield* Effect.fail(
          new Error(`Task graph '${input.graphId}' not found.`),
        );
      }
      if (input.idempotencyKey) {
        const existing = [...self.#runs.values()].find(
          (run) =>
            run.graphId === graph.id && run.idempotencyKey === input.idempotencyKey,
        );
        if (existing) {
          return existing;
        }
      }
      const now = new Date();
      const run: DurableTaskRun = {
        id: crypto.randomUUID(),
        graphId: graph.id,
        status: "pending",
        input: input.input ?? {},
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        createdAt: now,
        updatedAt: now,
        steps: graph.steps.map((step) => ({
          id: crypto.randomUUID(),
          definitionId: step.id,
          status: hasDependencies(step) ? "pending" : "ready",
          attempts: 0,
          updatedAt: now,
        })),
      };
      self.#runs.set(run.id, run);
      yield* self.#record({
        type: "task.run.created",
        taskRunId: run.id,
        taskGraphId: run.graphId,
        status: run.status,
      });
      return run;
    })();
  }

  readySteps(
    runId: string,
    now = new Date(),
  ): Effect.Effect<readonly DurableTaskStepState[]> {
    return Effect.sync(() => {
      const run = this.#runs.get(runId);
      if (!run || run.status === "paused" || run.status === "completed") {
        return [];
      }
      const graph = this.#graphs.get(run.graphId);
      if (!graph) {
        return [];
      }
      const completed = new Set(
        run.steps
          .filter((step) => step.status === "completed")
          .map((step) => step.definitionId),
      );
      return run.steps.filter((step) => {
        if (
          step.status !== "ready" ||
          (step.runAfter && step.runAfter.getTime() > now.getTime())
        ) {
          return false;
        }
        const definition = graph.steps.find((item) => item.id === step.definitionId);
        return (definition?.dependsOn ?? []).every((dependency) =>
          completed.has(dependency),
        );
      });
    });
  }

  acquireLease(input: {
    runId: string;
    stepId: string;
    holderId: string;
    leaseMs: number;
    now?: Date;
  }): Effect.Effect<DurableTaskStepState | undefined> {
    const self = this;
    return Effect.fn("DurableTaskEngine.acquireLease")(function* () {
      const now = input.now ?? new Date();
      const run = self.#runs.get(input.runId);
      if (!run) {
        return undefined;
      }
      const step = run.steps.find((item) => item.id === input.stepId);
      if (
        !step ||
        step.status !== "ready" ||
        (step.lease && step.lease.expiresAt.getTime() > now.getTime())
      ) {
        return undefined;
      }
      const updated = updateRunStep(run, step.id, {
        status: "leased",
        attempts: step.attempts + 1,
        updatedAt: now,
        lease: {
          holderId: input.holderId,
          expiresAt: new Date(now.getTime() + input.leaseMs),
        },
      });
      self.#runs.set(updated.id, { ...updated, status: "running", updatedAt: now });
      yield* self.#record({
        type: "task.step.leased",
        taskRunId: run.id,
        taskStepId: step.id,
        status: "leased",
      });
      return updated.steps.find((item) => item.id === step.id);
    })();
  }

  requireApproval(input: {
    runId: string;
    stepId: string;
    approvalId: string;
  }): Effect.Effect<DurableTaskStepState | undefined> {
    return this.#setStep(input.runId, input.stepId, {
      status: "waiting_approval",
      approvalId: input.approvalId,
      lease: undefined,
      updatedAt: new Date(),
    }).pipe(
      Effect.tap((step) =>
        step
          ? this.#record({
              type: "task.step.approval_required",
              taskRunId: input.runId,
              taskStepId: input.stepId,
              status: step.status,
            })
          : Effect.void,
      ),
    );
  }

  completeStep(input: {
    runId: string;
    stepId: string;
    output?: JsonValue;
  }): Effect.Effect<DurableTaskRun | undefined> {
    const self = this;
    return Effect.fn("DurableTaskEngine.completeStep")(function* () {
      const run = self.#runs.get(input.runId);
      if (!run) {
        return undefined;
      }
      const now = new Date();
      let updated = updateRunStep(run, input.stepId, {
        status: "completed",
        lease: undefined,
        updatedAt: now,
        ...(input.output !== undefined ? { output: input.output } : {}),
      });
      updated = self.#unlockDependentSteps(updated, now);
      if (updated.steps.every(isTerminalSuccessStep)) {
        updated = { ...updated, status: "completed", updatedAt: now };
        yield* self.#record({
          type: "task.run.completed",
          taskRunId: updated.id,
          taskGraphId: updated.graphId,
          status: updated.status,
        });
      }
      self.#runs.set(updated.id, updated);
      yield* self.#record({
        type: "task.step.completed",
        taskRunId: input.runId,
        taskStepId: input.stepId,
        status: "completed",
      });
      return updated;
    })();
  }

  skipStep(input: {
    runId: string;
    stepId: string;
    reason: string;
  }): Effect.Effect<DurableTaskRun | undefined> {
    const self = this;
    return Effect.fn("DurableTaskEngine.skipStep")(function* () {
      const run = self.#runs.get(input.runId);
      if (!run) {
        return undefined;
      }
      const now = new Date();
      let updated = updateRunStep(run, input.stepId, {
        status: "skipped",
        lease: undefined,
        error: input.reason,
        updatedAt: now,
      });
      updated = self.#unlockDependentSteps(updated, now);
      if (updated.steps.every(isTerminalSuccessStep)) {
        updated = { ...updated, status: "completed", updatedAt: now };
        yield* self.#record({
          type: "task.run.completed",
          taskRunId: updated.id,
          taskGraphId: updated.graphId,
          status: updated.status,
        });
      }
      self.#runs.set(updated.id, updated);
      return updated;
    })();
  }

  failStep(input: {
    runId: string;
    stepId: string;
    error: string;
  }): Effect.Effect<DurableTaskRun | undefined> {
    const self = this;
    return Effect.fn("DurableTaskEngine.failStep")(function* () {
      const run = self.#runs.get(input.runId);
      if (!run) {
        return undefined;
      }
      const graph = self.#graphs.get(run.graphId);
      const step = run.steps.find((item) => item.id === input.stepId);
      const definition = graph?.steps.find((item) => item.id === step?.definitionId);
      if (!step) {
        return undefined;
      }
      const now = new Date();
      const retry = definition?.retry;
      if (retry && step.attempts < retry.maxAttempts) {
        const updated = updateRunStep(run, step.id, {
          status: "ready",
          lease: undefined,
          error: input.error,
          runAfter: new Date(now.getTime() + retry.backoffMs),
          updatedAt: now,
        });
        self.#runs.set(updated.id, updated);
        yield* self.#record({
          type: "task.step.retry_scheduled",
          taskRunId: run.id,
          taskStepId: step.id,
          status: "ready",
        });
        return updated;
      }
      const updated = updateRunStep(run, step.id, {
        status: "failed",
        lease: undefined,
        error: input.error,
        updatedAt: now,
      });
      const failed = { ...updated, status: "failed" as const, updatedAt: now };
      self.#runs.set(failed.id, failed);
      yield* self.#record({
        type: "task.step.failed",
        taskRunId: run.id,
        taskStepId: step.id,
        status: "failed",
      });
      yield* self.#record({
        type: "task.run.failed",
        taskRunId: failed.id,
        taskGraphId: failed.graphId,
        status: failed.status,
      });
      return failed;
    })();
  }

  pause(runId: string, reason: string): Effect.Effect<DurableTaskRun | undefined> {
    return this.#setRun(runId, { status: "paused", pausedReason: reason }).pipe(
      Effect.tap((run) =>
        run
          ? this.#record({
              type: "task.run.paused",
              taskRunId: run.id,
              taskGraphId: run.graphId,
              status: run.status,
            })
          : Effect.void,
      ),
    );
  }

  resume(runId: string): Effect.Effect<DurableTaskRun | undefined> {
    return this.#setRun(runId, { status: "running", pausedReason: undefined }).pipe(
      Effect.tap((run) =>
        run
          ? this.#record({
              type: "task.run.resumed",
              taskRunId: run.id,
              taskGraphId: run.graphId,
              status: run.status,
            })
          : Effect.void,
      ),
    );
  }

  listRuns(): readonly DurableTaskRun[] {
    return [...this.#runs.values()];
  }

  listGraphs(): readonly DurableTaskGraph[] {
    return [...this.#graphs.values()];
  }

  getGraph(graphId: string): DurableTaskGraph | undefined {
    return this.#graphs.get(graphId);
  }

  snapshot(): DurableTaskSnapshot {
    return {
      graphs: [...this.#graphs.values()],
      runs: [...this.#runs.values()],
    };
  }

  hydrate(snapshot: DurableTaskSnapshot): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#graphs.clear();
      this.#runs.clear();
      for (const graph of snapshot.graphs) {
        this.#graphs.set(graph.id, normalizeGraphDates(graph));
      }
      for (const run of snapshot.runs) {
        this.#runs.set(run.id, normalizeRunDates(run));
      }
    });
  }

  #unlockDependentSteps(run: DurableTaskRun, now: Date): DurableTaskRun {
    const graph = this.#graphs.get(run.graphId);
    if (!graph) {
      return run;
    }
    const completed = new Set(
      run.steps
        .filter((step) => step.status === "completed")
        .map((step) => step.definitionId),
    );
    return {
      ...run,
      steps: run.steps.map((step) => {
        if (step.status !== "pending") {
          return step;
        }
        const definition = graph.steps.find((item) => item.id === step.definitionId);
        if (
          !definition ||
          !(definition.dependsOn ?? []).every((dependency) => completed.has(dependency))
        ) {
          return step;
        }
        return { ...step, status: "ready", updatedAt: now };
      }),
    };
  }

  #setRun(
    runId: string,
    patch: Partial<Pick<DurableTaskRun, "status">> & {
      pausedReason?: string | undefined;
    },
  ): Effect.Effect<DurableTaskRun | undefined> {
    return Effect.sync(() => {
      const run = this.#runs.get(runId);
      if (!run) {
        return undefined;
      }
      const updated: DurableTaskRun = {
        ...run,
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.pausedReason !== undefined
          ? { pausedReason: patch.pausedReason }
          : {}),
        updatedAt: new Date(),
      };
      if (
        patch.pausedReason === undefined &&
        run.pausedReason &&
        patch.status === "running"
      ) {
        delete updated.pausedReason;
      }
      this.#runs.set(runId, updated);
      return updated;
    });
  }

  #setStep(
    runId: string,
    stepId: string,
    patch: DurableTaskStepPatch,
  ): Effect.Effect<DurableTaskStepState | undefined> {
    return Effect.sync(() => {
      const run = this.#runs.get(runId);
      if (!run) {
        return undefined;
      }
      const updated = updateRunStep(run, stepId, patch);
      this.#runs.set(runId, updated);
      return updated.steps.find((step) => step.id === stepId);
    });
  }

  #record(event: Parameters<AuditSink["record"]>[0]): Effect.Effect<void> {
    return this.#audit ? this.#audit.record(event) : Effect.void;
  }
}

function validateGraph(steps: readonly DurableTaskStepDefinition[]): void {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) {
      throw new Error(`Duplicate task step id '${step.id}'.`);
    }
    ids.add(step.id);
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        throw new Error(
          `Task step '${step.id}' depends on unknown step '${dependency}'.`,
        );
      }
    }
  }
}

function hasDependencies(step: DurableTaskStepDefinition): boolean {
  return (step.dependsOn?.length ?? 0) > 0;
}

function isTerminalSuccessStep(step: DurableTaskStepState): boolean {
  return step.status === "completed" || step.status === "skipped";
}

function updateRunStep(
  run: DurableTaskRun,
  stepId: string,
  patch: DurableTaskStepPatch,
): DurableTaskRun {
  return {
    ...run,
    updatedAt: new Date(),
    steps: run.steps.map((step) =>
      step.id === stepId ? ({ ...step, ...patch } as DurableTaskStepState) : step,
    ),
  };
}

function normalizeGraphDates(graph: DurableTaskGraph): DurableTaskGraph {
  return {
    ...graph,
    createdAt: new Date(graph.createdAt),
    updatedAt: new Date(graph.updatedAt),
  };
}

function normalizeRunDates(run: DurableTaskRun): DurableTaskRun {
  return {
    ...run,
    createdAt: new Date(run.createdAt),
    updatedAt: new Date(run.updatedAt),
    steps: run.steps.map((step) => ({
      ...step,
      updatedAt: new Date(step.updatedAt),
      ...(step.runAfter ? { runAfter: new Date(step.runAfter) } : {}),
      ...(step.lease
        ? {
            lease: {
              ...step.lease,
              expiresAt: new Date(step.lease.expiresAt),
            },
          }
        : {}),
    })),
  };
}
