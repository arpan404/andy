import type {
  AssistantModelMessage,
  DynamicToolCall,
  LanguageModelUsage,
  ToolModelMessage,
} from "ai";
import { Effect } from "effect";
import { LlmRunnerError } from "./errors.js";
import type {
  AiTextGenerationResult,
  AiTextStreamResult,
  LlmRequest,
  StreamingLlmRunner,
} from "./types.js";

export class FakeLlmRunner implements StreamingLlmRunner {
  readonly #results: AiTextGenerationResult[];

  constructor(results: readonly AiTextGenerationResult[]) {
    this.#results = [...results];
  }

  complete(
    _request: LlmRequest,
  ): Effect.Effect<AiTextGenerationResult, LlmRunnerError> {
    return Effect.fn("FakeLlmRunner.complete")(() =>
      Effect.sync(() => this.#results.shift() ?? createFakeAiTextResult({})),
    )();
  }

  stream(_request: LlmRequest): Effect.Effect<AiTextStreamResult, LlmRunnerError> {
    return Effect.fail(
      new LlmRunnerError({
        message: "FakeLlmRunner does not implement streaming.",
      }),
    );
  }
}

export interface FakeAiTextResultInput {
  text?: string;
  toolCalls?: readonly DynamicToolCall[];
  responseMessages?: readonly FakeResponseMessage[];
}

type FakeResponseMessage = AssistantModelMessage | ToolModelMessage;

export function createFakeAiTextResult(
  input: FakeAiTextResultInput,
): AiTextGenerationResult {
  const text = input.text ?? "";
  const toolCalls = [...(input.toolCalls ?? [])];
  const responseMessages = [
    ...(input.responseMessages ?? createFakeResponseMessages(text, toolCalls)),
  ];
  const usage = createEmptyUsage();

  return {
    content: [],
    text,
    reasoning: [],
    reasoningText: undefined,
    files: [],
    sources: [],
    toolCalls,
    staticToolCalls: [],
    dynamicToolCalls: toolCalls,
    toolResults: [],
    staticToolResults: [],
    dynamicToolResults: [],
    finishReason: toolCalls.length > 0 ? "tool-calls" : "stop",
    rawFinishReason: undefined,
    usage,
    totalUsage: usage,
    warnings: undefined,
    request: {},
    response: {
      id: "fake-response",
      timestamp: new Date(0),
      modelId: "fake",
      messages: responseMessages,
    },
    providerMetadata: undefined,
    steps: [],
    experimental_output: text,
    output: text,
  };
}

export function createFakeAiToolCall(
  toolName: string,
  input: unknown,
  toolCallId = crypto.randomUUID(),
): DynamicToolCall {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    input,
    dynamic: true,
  };
}

function createFakeResponseMessages(
  text: string,
  toolCalls: readonly DynamicToolCall[],
): readonly FakeResponseMessage[] {
  if (toolCalls.length === 0) {
    return [{ role: "assistant", content: text }];
  }

  return [
    {
      role: "assistant",
      content: toolCalls.map((toolCall) => ({
        type: "tool-call",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        input: toolCall.input,
      })),
    },
  ];
}

function createEmptyUsage(): LanguageModelUsage {
  return {
    inputTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: undefined,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
    totalTokens: undefined,
  };
}
