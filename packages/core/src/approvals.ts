import type { AuditSink } from "@andy/audit";
import type { JsonValue } from "@andy/types";
import { Effect } from "effect";
import { ApprovalAlreadyResolvedError, ApprovalNotFoundError } from "./errors.js";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRequest {
  id: string;
  runId: string;
  toolName: string;
  input: JsonValue;
  reason: string;
  status: ApprovalStatus;
  createdAt: Date;
  resolvedAt?: Date;
}

export interface ApprovalCreateInput {
  runId: string;
  toolName: string;
  input: JsonValue;
  reason: string;
}

export class ApprovalManager {
  readonly #audit: AuditSink;
  readonly #requests = new Map<string, ApprovalRequest>();

  constructor(options: { audit: AuditSink }) {
    this.#audit = options.audit;
  }

  create(input: ApprovalCreateInput): Effect.Effect<ApprovalRequest> {
    const self = this;
    return Effect.fn("ApprovalManager.create")(function* () {
      const request: ApprovalRequest = {
        id: crypto.randomUUID(),
        runId: input.runId,
        toolName: input.toolName,
        input: input.input,
        reason: input.reason,
        status: "pending",
        createdAt: new Date(),
      };
      self.#requests.set(request.id, request);
      yield* self.#audit.record({
        type: "approval.requested",
        approvalId: request.id,
        runId: request.runId,
        toolName: request.toolName,
        reason: request.reason,
      });
      return request;
    })();
  }

  resolve(
    approvalId: string,
    decision: Exclude<ApprovalStatus, "pending">,
  ): Effect.Effect<
    ApprovalRequest,
    ApprovalNotFoundError | ApprovalAlreadyResolvedError
  > {
    const self = this;
    return Effect.fn("ApprovalManager.resolve")(function* () {
      const request = self.#requests.get(approvalId);
      if (!request) {
        return yield* Effect.fail(
          new ApprovalNotFoundError({
            approvalId,
            message: `Approval request '${approvalId}' was not found.`,
          }),
        );
      }

      if (request.status !== "pending") {
        return yield* Effect.fail(
          new ApprovalAlreadyResolvedError({
            approvalId,
            status: request.status,
            message: `Approval request '${approvalId}' is already ${request.status}.`,
          }),
        );
      }

      const resolved: ApprovalRequest = {
        ...request,
        status: decision,
        resolvedAt: new Date(),
      };
      self.#requests.set(approvalId, resolved);
      yield* self.#audit.record({
        type: "approval.resolved",
        approvalId,
        decision,
      });
      return resolved;
    })();
  }

  get(approvalId: string): ApprovalRequest | undefined {
    return this.#requests.get(approvalId);
  }

  list(): readonly ApprovalRequest[] {
    return [...this.#requests.values()].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }
}
