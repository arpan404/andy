import type { AuditSink } from "@andy/audit";
import { Effect } from "effect";
import type { AgentRuntime } from "./runtime.js";
import type {
  AgentKernelError,
  AgentMessage,
  AgentRunInput,
  AgentSession,
  AiTextStreamResult,
  StreamingAgentEvent,
  StreamingAgentRunResult,
  StreamingLlmRunner,
  ToolExecutionResult,
} from "./types.js";
import { AgentToolInputInvalidError } from "./errors.js";
import { isJsonValue } from "@andy/types";

export class StreamingAgentKernel {
  readonly #runtime: AgentRuntime;
  readonly #llm: StreamingLlmRunner;
  readonly #audit: AuditSink;

  constructor(options: {
    runtime: AgentRuntime;
    llm: StreamingLlmRunner;
    audit: AuditSink;
  }) {
    this.#runtime = options.runtime;
    this.#llm = options.llm;
    this.#audit = options.audit;
  }

  stream(input: AgentRunInput): Effect.Effect<AiTextStreamResult, AgentKernelError> {
    const self = this;
    return Effect.fn("StreamingAgentKernel.stream")(function* () {
      const session = createSession(input);
      yield* self.#audit.record({
        type: "agent.stream.started",
        sessionId: session.id,
        agentId: session.agentId,
      });
      const stream = yield* self.#llm.stream({
        session,
        tools: self.#runtime.listTools(),
        ...(session.traceId ? { traceId: session.traceId } : {}),
      });
      yield* self.#audit.record({
        type: "agent.stream.completed",
        sessionId: session.id,
        agentId: session.agentId,
      });
      return stream;
    })();
  }

  run(input: AgentRunInput): Effect.Effect<StreamingAgentRunResult, AgentKernelError> {
    const self = this;
    return Effect.fn("StreamingAgentKernel.run")(function* () {
      const session = createSession(input);
      const events: StreamingAgentEvent[] = [
        {
          type: "stream.started",
          sessionId: session.id,
          agentId: session.agentId,
          ...(session.traceId ? { traceId: session.traceId } : {}),
        },
      ];
      const toolResults: ToolExecutionResult[] = [];
      let response = "";

      yield* self.#audit.record({
        type: "agent.stream.started",
        sessionId: session.id,
        agentId: session.agentId,
        traceId: session.traceId,
      });

      const stream = yield* self.#llm.stream({
        session,
        tools: self.#runtime.listTools(),
        ...(session.traceId ? { traceId: session.traceId } : {}),
      });

      yield* Effect.tryPromise({
        try: async () => {
          for await (const part of stream.fullStream) {
            const event = toStreamingEvent(session, part);
            if (event) {
              events.push(event);
              if (event.type === "stream.text") {
                response += event.delta;
              }
            }
          }
        },
        catch: (cause) => cause as AgentKernelError,
      });

      const toolCalls = yield* Effect.tryPromise({
        try: () => Promise.resolve(stream.toolCalls),
        catch: (cause) => cause as AgentKernelError,
      });

      for (const call of toolCalls) {
        if (!isJsonValue(call.input)) {
          return yield* Effect.fail(
            new AgentToolInputInvalidError({
              sessionId: session.id,
              toolName: call.toolName,
              message: `AI SDK stream tool call '${call.toolName}' produced non-JSON input.`,
            }),
          );
        }

        const runtimeToolName = self.#runtime.resolveModelToolName(call.toolName);
        const result = yield* self.#runtime.executeTool(runtimeToolName, call.input, {
          sessionId: session.id,
          agentId: session.agentId,
          ...(session.traceId ? { traceId: session.traceId } : {}),
          ...(session.cancellationTokenId
            ? { cancellationTokenId: session.cancellationTokenId }
            : {}),
        });
        toolResults.push(result);
        events.push({
          type: "stream.tool_result",
          sessionId: session.id,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result,
          ...(session.traceId ? { traceId: session.traceId } : {}),
        });
      }

      events.push({
        type: "stream.completed",
        sessionId: session.id,
        response,
        ...(session.traceId ? { traceId: session.traceId } : {}),
      });

      yield* self.#audit.record({
        type: "agent.stream.completed",
        sessionId: session.id,
        agentId: session.agentId,
        traceId: session.traceId,
      });

      return {
        session,
        events,
        response,
        toolResults,
      };
    })();
  }
}

function createSession(input: AgentRunInput): AgentSession {
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

function toStreamingEvent(
  session: AgentSession,
  part: unknown,
): StreamingAgentEvent | undefined {
  if (typeof part !== "object" || part === null || !("type" in part)) {
    return undefined;
  }

  const typed = part as {
    type: string;
    text?: string;
    textDelta?: string;
    delta?: string;
    toolCallId?: string;
    toolName?: string;
  };

  if (
    typed.type === "text-delta" ||
    typed.type === "text" ||
    typed.type === "reasoning-delta"
  ) {
    const delta = typed.text ?? typed.textDelta ?? typed.delta;
    if (typeof delta !== "string" || delta.length === 0) {
      return undefined;
    }

    return {
      type: "stream.text",
      sessionId: session.id,
      delta,
      ...(session.traceId ? { traceId: session.traceId } : {}),
    };
  }

  if (typed.type === "tool-call" && typed.toolCallId && typed.toolName) {
    return {
      type: "stream.tool_call",
      sessionId: session.id,
      toolCallId: typed.toolCallId,
      toolName: typed.toolName,
      ...(session.traceId ? { traceId: session.traceId } : {}),
    };
  }

  return undefined;
}
