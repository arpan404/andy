import type {
  Output,
  GenerateTextResult,
  ModelMessage,
  StreamTextResult,
  ToolSet,
} from "ai";
import type { JsonValue } from "@andy/types";
import type { JsonSchemaObject } from "@andy/plugin-sdk";
import type { Effect } from "effect";
import type {
  AgentRuntimeError,
  AgentToolInputInvalidError,
  AgentToolLimitExceededError,
  LlmRunnerError,
  SwarmDepthExceededError,
  SwarmLimitExceededError,
  SwarmRoleDeniedError,
} from "./errors.js";

export interface ToolExecutionResult {
  runId: string;
  output: JsonValue;
}

export interface RuntimeToolRecord {
  name: string;
  qualifiedName: string;
  aiToolName: string;
  pluginId: string;
  localName: string;
  description: string;
  capabilities: readonly string[];
  risk: string;
  inputSchema?: JsonSchemaObject;
  outputSchema?: JsonSchemaObject;
  isLocalNameAmbiguous: boolean;
  localAlias?: string;
}

export type AgentRole = "primary" | "planner" | "worker" | "reviewer" | "researcher";

export type AgentMessage = ModelMessage;

export interface AgentSession {
  id: string;
  agentId: string;
  role: AgentRole;
  depth: number;
  messages: readonly AgentMessage[];
  traceId?: string;
  cancellationTokenId?: string;
  userId?: string;
  channelId?: string;
  conversationId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type AiTextOutput = ReturnType<typeof Output.text>;

export type AiTextGenerationResult<TOOLS extends ToolSet = ToolSet> =
  GenerateTextResult<TOOLS, AiTextOutput>;

export type AiTextStreamResult<TOOLS extends ToolSet = ToolSet> = StreamTextResult<
  TOOLS,
  AiTextOutput
>;

export interface LlmRequest {
  session: AgentSession;
  tools: readonly RuntimeToolRecord[];
  traceId?: string;
  abortSignal?: AbortSignal;
}

export interface LlmRunner {
  complete(request: LlmRequest): Effect.Effect<AiTextGenerationResult, LlmRunnerError>;
}

export interface StreamingLlmRunner extends LlmRunner {
  stream(request: LlmRequest): Effect.Effect<AiTextStreamResult, LlmRunnerError>;
}

export interface AgentRunInput {
  sessionId?: string;
  agentId?: string;
  role?: AgentRole;
  depth?: number;
  systemPrompt?: string;
  skillInstructions?: string;
  userMessage: string;
  userId?: string;
  channelId?: string;
  conversationId?: string;
  maxToolCalls?: number;
  maxParallelToolCalls?: number;
  traceId?: string;
  cancellationTokenId?: string;
  timeout?: import("effect/Duration").DurationInput;
}

export interface AgentRunResult {
  session: AgentSession;
  response: string;
  toolResults: readonly ToolExecutionResult[];
}

export type StreamingAgentEvent =
  | {
      type: "stream.started";
      sessionId: string;
      agentId: string;
      traceId?: string;
    }
  | {
      type: "stream.text";
      sessionId: string;
      delta: string;
      traceId?: string;
    }
  | {
      type: "stream.tool_call";
      sessionId: string;
      toolCallId: string;
      toolName: string;
      traceId?: string;
    }
  | {
      type: "stream.tool_result";
      sessionId: string;
      toolCallId: string;
      toolName: string;
      result: ToolExecutionResult;
      traceId?: string;
    }
  | {
      type: "stream.completed";
      sessionId: string;
      response: string;
      traceId?: string;
    };

export interface StreamingAgentRunResult {
  session: AgentSession;
  events: readonly StreamingAgentEvent[];
  response: string;
  toolResults: readonly ToolExecutionResult[];
}

export interface SwarmLimits {
  maxAgents: number;
  maxDepth: number;
  allowedRoles: ReadonlySet<AgentRole>;
}

export interface SwarmTask {
  role: AgentRole;
  userMessage: string;
  systemPrompt?: string;
}

export interface SwarmRunInput {
  parentSessionId: string;
  tasks: readonly SwarmTask[];
  limits: SwarmLimits;
}

export interface SwarmRunResult {
  swarmId: string;
  results: readonly AgentRunResult[];
}

export type AgentKernelError =
  | AgentRuntimeError
  | LlmRunnerError
  | AgentToolInputInvalidError
  | AgentToolLimitExceededError;

export type SwarmKernelError =
  | AgentKernelError
  | SwarmLimitExceededError
  | SwarmDepthExceededError
  | SwarmRoleDeniedError;
