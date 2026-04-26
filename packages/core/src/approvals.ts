import type { AuditSink } from "@andy/audit";
import type { JsonValue } from "@andy/types";
import { Effect } from "effect";
import { ApprovalAlreadyResolvedError, ApprovalNotFoundError } from "./errors.js";
import type { CommunicationBridge } from "./communication.js";

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
  communication?: {
    channelId: string;
    conversationId: string;
  };
}

export class ApprovalManager {
  readonly #audit: AuditSink;
  readonly #communication: CommunicationBridge | undefined;
  readonly #requests = new Map<string, ApprovalRequest>();

  constructor(options: { audit: AuditSink; communication?: CommunicationBridge }) {
    this.#audit = options.audit;
    this.#communication = options.communication;
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
      if (self.#communication && input.communication) {
        yield* self.#communication
          .requestApproval({
            approvalId: request.id,
            channelId: input.communication.channelId,
            conversationId: input.communication.conversationId,
            text: `Approval required for ${request.toolName}: ${request.reason}`,
            metadata: {
              runId: request.runId,
              toolName: request.toolName,
            },
          })
          .pipe(Effect.catchAll(() => Effect.void));
      }
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

  expirePending(now = new Date()): Effect.Effect<readonly ApprovalRequest[]> {
    const self = this;
    return Effect.fn("ApprovalManager.expirePending")(function* () {
      const expired: ApprovalRequest[] = [];
      for (const request of self.#requests.values()) {
        if (request.status !== "pending") {
          continue;
        }

        const resolved: ApprovalRequest = {
          ...request,
          status: "expired",
          resolvedAt: now,
        };
        self.#requests.set(request.id, resolved);
        expired.push(resolved);
        yield* self.#audit.record({
          type: "approval.expired",
          approvalId: request.id,
          runId: request.runId,
          toolName: request.toolName,
        });
      }

      return expired;
    })();
  }

  expire(
    approvalId: string,
    now = new Date(),
  ): Effect.Effect<ApprovalRequest | undefined> {
    const self = this;
    return Effect.fn("ApprovalManager.expire")(function* () {
      const request = self.#requests.get(approvalId);
      if (!request || request.status !== "pending") {
        return undefined;
      }

      const expired: ApprovalRequest = {
        ...request,
        status: "expired",
        resolvedAt: now,
      };
      self.#requests.set(approvalId, expired);
      yield* self.#audit.record({
        type: "approval.expired",
        approvalId: request.id,
        runId: request.runId,
        toolName: request.toolName,
      });
      return expired;
    })();
  }

  hydrate(requests: readonly ApprovalRequest[]): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#requests.clear();
      for (const request of requests) {
        this.#requests.set(request.id, normalizeApprovalDates(request));
      }
    });
  }
}

function normalizeApprovalDates(request: ApprovalRequest): ApprovalRequest {
  return {
    ...request,
    createdAt: new Date(request.createdAt),
    ...(request.resolvedAt ? { resolvedAt: new Date(request.resolvedAt) } : {}),
  };
}
