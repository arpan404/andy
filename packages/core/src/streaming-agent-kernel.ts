import type { AuditSink } from "@andy/audit";
import { Effect } from "effect";
import type { AgentRuntime } from "./runtime.js";
import type {
  AgentKernelError,
  AgentMessage,
  AgentRunInput,
  AgentSession,
  AiTextStreamResult,
  StreamingLlmRunner,
} from "./types.js";

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
      });
      yield* self.#audit.record({
        type: "agent.stream.completed",
        sessionId: session.id,
        agentId: session.agentId,
      });
      return stream;
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
    id: crypto.randomUUID(),
    agentId: input.agentId ?? crypto.randomUUID(),
    role: input.role ?? "primary",
    depth: input.depth ?? 0,
    messages,
    createdAt: now,
    updatedAt: now,
  };
}
