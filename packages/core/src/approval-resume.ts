import type { JsonValue } from "@andy/types";
import { Effect } from "effect";
import type { ApprovalManager, ApprovalRequest } from "./approvals.js";
import {
  ApprovalDeniedError,
  ApprovalNotFoundError,
  type AgentRuntimeError,
  type ApprovalAlreadyResolvedError,
} from "./errors.js";
import type { ToolExecutionResult } from "./types.js";

export interface ParkedApprovalAction {
  approval: ApprovalRequest;
  execute(): Effect.Effect<ToolExecutionResult, AgentRuntimeError>;
}

export class ApprovalResumeEngine {
  readonly #approvals: ApprovalManager;
  readonly #parked = new Map<string, ParkedApprovalAction>();

  constructor(options: { approvals: ApprovalManager }) {
    this.#approvals = options.approvals;
  }

  park(
    approval: ApprovalRequest,
    execute: () => Effect.Effect<ToolExecutionResult, AgentRuntimeError>,
  ): Effect.Effect<ApprovalRequest> {
    return Effect.sync(() => {
      this.#parked.set(approval.id, { approval, execute });
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
}

export function createApprovalToolResult(output: JsonValue): ToolExecutionResult {
  return {
    runId: crypto.randomUUID(),
    output,
  };
}
