import type { AuditSink } from "@andy/audit";
import { isJsonValue } from "@andy/types";
import type { JSONValue } from "ai";
import { Effect } from "effect";
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
  readonly #sessions = new Map<string, AgentSession>();

  constructor(options: { runtime: AgentRuntime; llm: LlmRunner; audit: AuditSink }) {
    this.#runtime = options.runtime;
    this.#llm = options.llm;
    this.#audit = options.audit;
  }

  run(input: AgentRunInput): Effect.Effect<AgentRunResult, AgentKernelError> {
    const self = this;
    return Effect.fn("AgentKernel.run")(function* () {
      let session = self.#createSession(input);
      self.#sessions.set(session.id, session);
      yield* self.#audit.record({
        type: "agent.session.started",
        sessionId: session.id,
        agentId: session.agentId,
      });

      const toolResults: ToolExecutionResult[] = [];
      const maxToolCalls = input.maxToolCalls ?? 8;
      const maxParallelToolCalls = input.maxParallelToolCalls ?? 4;
      let response = "";

      for (let toolCallCount = 0; toolCallCount <= maxToolCalls; toolCallCount += 1) {
        const output = yield* self.#llm.complete({
          session,
          tools: self.#runtime.listTools(),
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
      });

      return {
        session,
        response,
        toolResults,
      };
    })();
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
              toolName: runtimeToolName,
            });
            const result = yield* self.#runtime.executeTool(
              runtimeToolName,
              call.input,
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

  #createSession(input: AgentRunInput): AgentSession {
    const now = new Date();
    const messages: AgentMessage[] = [];
    if (input.systemPrompt) {
      messages.push({ role: "system", content: input.systemPrompt });
    }
    messages.push({ role: "user", content: input.userMessage });

    return {
      id: crypto.randomUUID(),
      agentId: input.agentId ?? crypto.randomUUID(),
      role: input.role ?? "primary",
      depth: input.depth ?? 0,
      messages,
      createdAt: now,
      updatedAt: now,
    };
  }
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
