import type { AuditSink } from "@andy/audit";
import { Effect } from "effect";
import {
  SwarmDepthExceededError,
  SwarmLimitExceededError,
  SwarmRoleDeniedError,
} from "./errors.js";
import type { AgentKernel } from "./agent-kernel.js";
import type {
  AgentRunInput,
  AgentRunResult,
  SwarmKernelError,
  SwarmRunInput,
  SwarmRunResult,
} from "./types.js";

export class SwarmCoordinator {
  readonly #agentKernel: AgentKernel;
  readonly #audit: AuditSink;

  constructor(options: { agentKernel: AgentKernel; audit: AuditSink }) {
    this.#agentKernel = options.agentKernel;
    this.#audit = options.audit;
  }

  run(input: SwarmRunInput): Effect.Effect<SwarmRunResult, SwarmKernelError> {
    const self = this;
    return Effect.fn("SwarmCoordinator.run")(function* () {
      if (input.tasks.length > input.limits.maxAgents) {
        return yield* Effect.fail(
          new SwarmLimitExceededError({
            maxAgents: input.limits.maxAgents,
            requestedAgents: input.tasks.length,
            message: `Swarm requested ${input.tasks.length} agents but only ${input.limits.maxAgents} are allowed.`,
          }),
        );
      }

      const parent = self.#agentKernel.getSession(input.parentSessionId);
      const parentDepth = parent?.depth ?? 0;
      const childDepth = parentDepth + 1;
      if (childDepth > input.limits.maxDepth) {
        return yield* Effect.fail(
          new SwarmDepthExceededError({
            maxDepth: input.limits.maxDepth,
            requestedDepth: childDepth,
            message: `Swarm child depth ${childDepth} exceeds max depth ${input.limits.maxDepth}.`,
          }),
        );
      }

      const swarmId = crypto.randomUUID();
      const results: AgentRunResult[] = [];
      for (const task of input.tasks) {
        if (!input.limits.allowedRoles.has(task.role)) {
          return yield* Effect.fail(
            new SwarmRoleDeniedError({
              role: task.role,
              message: `Swarm role '${task.role}' is not allowed.`,
            }),
          );
        }

        const runInput: AgentRunInput = {
          role: task.role,
          depth: childDepth,
          userMessage: task.userMessage,
        };
        if (task.systemPrompt !== undefined) {
          runInput.systemPrompt = task.systemPrompt;
        }

        const result = yield* self.#agentKernel.run(runInput);
        yield* self.#audit.record({
          type: "swarm.child.started",
          swarmId,
          parentSessionId: input.parentSessionId,
          childSessionId: result.session.id,
          role: task.role,
        });
        results.push(result);
      }

      return { swarmId, results };
    })();
  }
}
