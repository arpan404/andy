import type { AuditSink } from "@andy/audit";
import { isJsonValue } from "@andy/types";
import type { JSONValue } from "ai";
import { Effect } from "effect";
import type { DurationInput } from "effect/Duration";
import { type CancellationRegistry, withTimeout } from "./cancellation.js";
import { AgentToolInputInvalidError, AgentToolLimitExceededError } from "./errors.js";
import type { AgentRuntime } from "./runtime.js";
import type {
  AiTextGenerationResult,
  AgentKernelError,
  AgentMessage,
  AgentRunInput,
  AgentRunResult,
  AgentSession,
  LlmRunner,
  ToolExecutionResult,
} from "./types.js";
import { appendMessage } from "./utils.js";

export class AgentKernel {
  readonly #runtime: AgentRuntime;
  readonly #llm: LlmRunner;
  readonly #audit: AuditSink;
  readonly #cancellation: CancellationRegistry | undefined;
  readonly #sessions = new Map<string, AgentSession>();

  constructor(options: {
    runtime: AgentRuntime;
    llm: LlmRunner;
    audit: AuditSink;
    cancellation?: CancellationRegistry;
  }) {
    this.#runtime = options.runtime;
    this.#llm = options.llm;
    this.#audit = options.audit;
    this.#cancellation = options.cancellation;
  }

  run(input: AgentRunInput): Effect.Effect<AgentRunResult, AgentKernelError> {
    const self = this;
    const program = Effect.fn("AgentKernel.run")(function* () {
      let session = self.#createSession(input);
      self.#sessions.set(session.id, session);
      yield* self.#audit.record({
        type: "agent.session.started",
        sessionId: session.id,
        agentId: session.agentId,
        traceId: session.traceId,
      });

      const toolResults: ToolExecutionResult[] = [];
      const maxToolCalls = input.maxToolCalls ?? 8;
      const maxParallelToolCalls = input.maxParallelToolCalls ?? 4;
      let response = "";

      for (let toolCallCount = 0; toolCallCount <= maxToolCalls; toolCallCount += 1) {
        yield* self.#ensureNotCancelled(session);
        const output = yield* self.#llm.complete({
          session,
          tools: self.#runtime.listTools(),
          ...(session.traceId ? { traceId: session.traceId } : {}),
        });

        for (const message of output.response.messages) {
          session = appendMessage(session, message);
        }

        if (output.toolCalls.length === 0) {
          response = output.text;
          break;
        }

        if (toolCallCount + output.toolCalls.length > maxToolCalls) {
          return yield* Effect.fail(
            new AgentToolLimitExceededError({
              sessionId: session.id,
              limit: maxToolCalls,
              message: `Agent session '${session.id}' exceeded its tool call limit.`,
            }),
          );
        }

        const batchResults = yield* self.#executeToolCallBatch({
          output,
          session,
          concurrency: maxParallelToolCalls,
        });
        toolResults.push(...batchResults.map((item) => item.result));

        session = appendMessage(session, {
          role: "tool",
          content: batchResults.map((item) => ({
            type: "tool-result",
            toolCallId: item.toolCallId,
            toolName: item.toolName,
            output: {
              type: "json",
              value: toAiJsonValue(item.result.output),
            },
          })),
        });
      }

      self.#sessions.set(session.id, session);
      yield* self.#audit.record({
        type: "agent.session.completed",
        sessionId: session.id,
        agentId: session.agentId,
        traceId: session.traceId,
      });

      return {
        session,
        response,
        toolResults,
      };
    })();

    return applyOptionalTimeout(program, input.timeout);
  }

  #executeToolCallBatch(options: {
    output: AiTextGenerationResult;
    session: AgentSession;
    concurrency: number;
  }): Effect.Effect<
    readonly {
      toolCallId: string;
      toolName: string;
      result: ToolExecutionResult;
    }[],
    AgentKernelError
  > {
    const self = this;
    return Effect.fn("AgentKernel.executeToolCallBatch")(function* () {
      return yield* Effect.all(
        options.output.toolCalls.map((call) =>
          Effect.fn("AgentKernel.executeToolCall")(function* () {
            if (!isJsonValue(call.input)) {
              return yield* Effect.fail(
                new AgentToolInputInvalidError({
                  sessionId: options.session.id,
                  toolName: call.toolName,
                  message: `AI SDK tool call '${call.toolName}' produced non-JSON input.`,
                }),
              );
            }

            const runtimeToolName = self.#runtime.resolveModelToolName(call.toolName);
            yield* self.#audit.record({
              type: "agent.tool.requested",
              sessionId: options.session.id,
              agentId: options.session.agentId,
              traceId: options.session.traceId,
              toolName: runtimeToolName,
            });
            const result = yield* self.#runtime.executeTool(
              runtimeToolName,
              call.input,
              {
                sessionId: options.session.id,
                agentId: options.session.agentId,
                ...(options.session.traceId
                  ? { traceId: options.session.traceId }
                  : {}),
                ...(options.session.cancellationTokenId
                  ? { cancellationTokenId: options.session.cancellationTokenId }
                  : {}),
              },
            );
            return {
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              result,
            };
          })(),
        ),
        { concurrency: options.concurrency },
      );
    })();
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.#sessions.get(sessionId);
  }

  listSessions(): readonly AgentSession[] {
    return [...this.#sessions.values()].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }

  hydrateSessions(sessions: readonly AgentSession[]): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#sessions.clear();
      for (const session of sessions) {
        this.#sessions.set(session.id, normalizeSessionDates(session));
      }
    });
  }

  #createSession(input: AgentRunInput): AgentSession {
    const now = new Date();
    const messages: AgentMessage[] = [];
    if (input.systemPrompt) {
      messages.push({ role: "system", content: input.systemPrompt });
    }
    messages.push({ role: "user", content: input.userMessage });

    return {
      id: input.sessionId ?? crypto.randomUUID(),
      agentId: input.agentId ?? crypto.randomUUID(),
      role: input.role ?? "primary",
      depth: input.depth ?? 0,
      messages,
      ...(input.traceId ? { traceId: input.traceId } : {}),
      ...(input.cancellationTokenId
        ? { cancellationTokenId: input.cancellationTokenId }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  #ensureNotCancelled(session: AgentSession): Effect.Effect<void, AgentKernelError> {
    const tokenId = session.cancellationTokenId;
    if (!tokenId || !this.#cancellation) {
      return Effect.void;
    }

    const token = this.#cancellation.get(tokenId);
    if (token?.status !== "cancelled") {
      return Effect.void;
    }

    return Effect.fail(
      new AgentToolLimitExceededError({
        sessionId: session.id,
        limit: 0,
        message: `Agent session '${session.id}' was cancelled: ${token.reason ?? "cancelled"}.`,
      }),
    );
  }
}

function normalizeSessionDates(session: AgentSession): AgentSession {
  return {
    ...session,
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
  };
}

function applyOptionalTimeout<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeout: DurationInput | undefined,
): Effect.Effect<A, E, R> {
  if (!timeout) {
    return effect;
  }

  return withTimeout(effect, timeout).pipe(Effect.mapError((error) => error as E));
}

function toAiJsonValue(value: unknown): JSONValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toAiJsonValue(item));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toAiJsonValue(entry)]),
    );
  }

  return null;
}
