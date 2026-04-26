import type { Effect } from "effect";
import type { AuditSink } from "@andy/audit";
import type {
  AgentRunInput,
  AiTextStreamResult,
  StreamingAgentRunResult,
  StreamingLlmRunner,
} from "./types.js";
import type { AgentRuntime } from "./runtime.js";
import { StreamingAgentKernel } from "./streaming-agent-kernel.js";
import type { AgentKernelError } from "./types.js";

export class StreamingAgentService {
  readonly #kernel: StreamingAgentKernel;

  constructor(options: {
    runtime: AgentRuntime;
    llm: StreamingLlmRunner;
    audit: AuditSink;
  }) {
    this.#kernel = new StreamingAgentKernel(options);
  }

  stream(input: AgentRunInput): Effect.Effect<AiTextStreamResult, AgentKernelError> {
    return this.#kernel.stream(input);
  }

  run(input: AgentRunInput): Effect.Effect<StreamingAgentRunResult, AgentKernelError> {
    return this.#kernel.run(input);
  }
}
