import { generateText, streamText, type LanguageModel } from "ai";
import { Effect } from "effect";
import { buildAiSdkTools } from "./ai-tools.js";
import { LlmRunnerError } from "./errors.js";
import type {
  AiTextGenerationResult,
  AiTextStreamResult,
  LlmRequest,
  StreamingLlmRunner,
} from "./types.js";
import { stringifyCause } from "./utils.js";

export interface AiSdkLlmRunnerOptions {
  model: LanguageModel;
}

export class AiSdkLlmRunner implements StreamingLlmRunner {
  readonly #model: LanguageModel;

  constructor(options: AiSdkLlmRunnerOptions) {
    this.#model = options.model;
  }

  complete(request: LlmRequest): Effect.Effect<AiTextGenerationResult, LlmRunnerError> {
    return Effect.fn("AiSdkLlmRunner.complete")(() =>
      Effect.tryPromise({
        try: () =>
          generateText({
            model: this.#model,
            messages: [...request.session.messages],
            tools: buildAiSdkTools(request.tools),
          }),
        catch: (cause) =>
          new LlmRunnerError({
            message: "AI SDK text generation failed.",
            cause: stringifyCause(cause),
          }),
      }),
    )();
  }

  stream(request: LlmRequest): Effect.Effect<AiTextStreamResult, LlmRunnerError> {
    return Effect.fn("AiSdkLlmRunner.stream")(() =>
      Effect.try({
        try: () =>
          streamText({
            model: this.#model,
            messages: [...request.session.messages],
            tools: buildAiSdkTools(request.tools),
          }),
        catch: (cause) =>
          new LlmRunnerError({
            message: "AI SDK text streaming failed.",
            cause: stringifyCause(cause),
          }),
      }),
    )();
  }
}
