import type { JsonValue } from "@andy/types";
import { Effect } from "effect";
import type { ApprovalManager, ApprovalRequest } from "./approvals.js";
import {
  ApprovalDeniedError,
  ApprovalNotFoundError,
  ToolNotRegisteredError,
  type AgentRuntimeError,
  type ApprovalAlreadyResolvedError,
} from "./errors.js";
import type { ToolExecutionResult } from "./types.js";

export interface ParkedApprovalAction {
  approval: ApprovalRequest;
  descriptor?: ApprovalActionDescriptor;
  execute(): Effect.Effect<ToolExecutionResult, AgentRuntimeError>;
}

export interface ApprovalActionDescriptor {
  kind: "tool.execute";
  toolName: string;
  input: JsonValue;
  context?: {
    sessionId?: string;
    agentId?: string;
    userId?: string;
    channelId?: string;
    conversationId?: string;
    taskId?: string;
    traceId?: string;
    cancellationTokenId?: string;
  };
}

export type ApprovalActionExecutor = (
  descriptor: ApprovalActionDescriptor,
) => Effect.Effect<ToolExecutionResult, AgentRuntimeError>;

export class ApprovalResumeEngine {
  readonly #approvals: ApprovalManager;
  readonly #executor: ApprovalActionExecutor | undefined;
  readonly #parked = new Map<string, ParkedApprovalAction>();

  constructor(options: {
    approvals: ApprovalManager;
    executor?: ApprovalActionExecutor;
  }) {
    this.#approvals = options.approvals;
    this.#executor = options.executor;
  }

  park(
    approval: ApprovalRequest,
    execute: () => Effect.Effect<ToolExecutionResult, AgentRuntimeError>,
    descriptor?: ApprovalActionDescriptor,
  ): Effect.Effect<ApprovalRequest> {
    return Effect.sync(() => {
      this.#parked.set(approval.id, {
        approval,
        execute,
        ...(descriptor ? { descriptor } : {}),
      });
      return approval;
    });
  }

  parkDescriptor(
    approval: ApprovalRequest,
    descriptor: ApprovalActionDescriptor,
  ): Effect.Effect<ApprovalRequest> {
    return Effect.sync(() => {
      this.#parked.set(approval.id, {
        approval,
        descriptor,
        execute: () =>
          this.#executor
            ? this.#executor(descriptor)
            : Effect.fail(
                new ToolNotRegisteredError({
                  toolName: descriptor.toolName,
                  message: `No approval action executor is configured for approval '${approval.id}'.`,
                }),
              ),
      });
      return approval;
    });
  }

  resumeApproved(
    approvalId: string,
  ): Effect.Effect<
    ToolExecutionResult,
    | ApprovalNotFoundError
    | ApprovalAlreadyResolvedError
    | ApprovalDeniedError
    | AgentRuntimeError
  > {
    const self = this;
    return Effect.fn("ApprovalResumeEngine.resumeApproved")(function* () {
      const parked = self.#parked.get(approvalId);
      if (!parked) {
        return yield* Effect.fail(
          new ApprovalNotFoundError({
            approvalId,
            message: `No parked action exists for approval '${approvalId}'.`,
          }),
        );
      }

      const approval = yield* self.#approvals.resolve(approvalId, "approved");
      if (approval.status !== "approved") {
        return yield* Effect.fail(
          new ApprovalDeniedError({
            approvalId,
            status: approval.status,
            message: `Approval '${approvalId}' was not approved.`,
          }),
        );
      }

      const result = yield* parked.execute();
      self.#parked.delete(approvalId);
      return result;
    })();
  }

  deny(
    approvalId: string,
  ): Effect.Effect<
    ApprovalRequest,
    ApprovalNotFoundError | ApprovalAlreadyResolvedError
  > {
    const self = this;
    return Effect.fn("ApprovalResumeEngine.deny")(function* () {
      const approval = yield* self.#approvals.resolve(approvalId, "denied");
      self.#parked.delete(approvalId);
      return approval;
    })();
  }

  expire(approvalId: string): Effect.Effect<ApprovalRequest | undefined> {
    const self = this;
    return Effect.fn("ApprovalResumeEngine.expire")(function* () {
      const parked = self.#parked.get(approvalId);
      self.#parked.delete(approvalId);
      if (!parked) {
        return undefined;
      }

      return yield* self.#approvals.expire(approvalId);
    })();
  }

  clearExpired(): Effect.Effect<readonly ApprovalRequest[]> {
    const self = this;
    return Effect.fn("ApprovalResumeEngine.clearExpired")(function* () {
      const expired = yield* self.#approvals.expirePending();
      for (const approval of expired) {
        self.#parked.delete(approval.id);
      }
      return expired;
    })();
  }

  listParked(): readonly ApprovalRequest[] {
    return [...this.#parked.values()].map((item) => item.approval);
  }

  listParkedDescriptors(): readonly {
    approval: ApprovalRequest;
    descriptor: ApprovalActionDescriptor;
  }[] {
    return [...this.#parked.values()].flatMap((item) =>
      item.descriptor ? [{ approval: item.approval, descriptor: item.descriptor }] : [],
    );
  }
}

export function createApprovalToolResult(output: JsonValue): ToolExecutionResult {
  return {
    runId: crypto.randomUUID(),
    output,
  };
}
