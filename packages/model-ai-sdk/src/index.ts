import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { ModelProvider } from "@andy/core";
import { ModelProviderError } from "@andy/core";
import { Effect } from "effect";

const openAiApiKeyEnv = "OPENAI_API_KEY";
const anthropicApiKeyEnv = "ANTHROPIC_API_KEY";
const googleApiKeyEnv = "GOOGLE_GENERATIVE_AI_API_KEY";

export interface AiSdkOpenAiModelProviderOptions {
  id?: string;
  pluginId?: string;
  modelId?: string;
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
}

export interface AiSdkAnthropicModelProviderOptions {
  id?: string;
  pluginId?: string;
  modelId?: string;
  apiKey?: string;
  baseURL?: string;
}

export interface AiSdkGoogleModelProviderOptions {
  id?: string;
  pluginId?: string;
  modelId?: string;
  apiKey?: string;
}

export function createAiSdkOpenAiModelProvider(
  options: AiSdkOpenAiModelProviderOptions = {},
): ModelProvider {
  const id = options.id ?? "ai-sdk.openai.default";
  const pluginId = options.pluginId ?? "andy.model.ai-sdk.openai";
  const modelId = options.modelId ?? "gpt-4.1-mini";

  return {
    id,
    pluginId,
    modelId,
    createModel() {
      return Effect.fn("AiSdkOpenAiModelProvider.createModel")(function* () {
        const apiKey = options.apiKey ?? process.env[openAiApiKeyEnv];
        if (!apiKey) {
          return yield* Effect.fail(
            new ModelProviderError({
              providerId: id,
              message:
                "AI SDK OpenAI provider requires OPENAI_API_KEY or an explicit apiKey.",
            }),
          );
        }

        const openai = createOpenAI({
          apiKey,
          ...(options.baseURL ? { baseURL: options.baseURL } : {}),
          ...(options.organization ? { organization: options.organization } : {}),
          ...(options.project ? { project: options.project } : {}),
        });
        return openai(modelId);
      })();
    },
  };
}

export function createAiSdkAnthropicModelProvider(
  options: AiSdkAnthropicModelProviderOptions = {},
): ModelProvider {
  const id = options.id ?? "ai-sdk.anthropic.default";
  const pluginId = options.pluginId ?? "andy.model.ai-sdk.anthropic";
  const modelId = options.modelId ?? "claude-3-5-sonnet-latest";

  return {
    id,
    pluginId,
    modelId,
    createModel() {
      return Effect.fn("AiSdkAnthropicModelProvider.createModel")(function* () {
        const apiKey = options.apiKey ?? process.env[anthropicApiKeyEnv];
        if (!apiKey) {
          return yield* Effect.fail(
            new ModelProviderError({
              providerId: id,
              message:
                "AI SDK Anthropic provider requires ANTHROPIC_API_KEY or an explicit apiKey.",
            }),
          );
        }
        return createAnthropic({
          apiKey,
          ...(options.baseURL ? { baseURL: options.baseURL } : {}),
        })(modelId);
      })();
    },
  };
}

export function createAiSdkGoogleModelProvider(
  options: AiSdkGoogleModelProviderOptions = {},
): ModelProvider {
  const id = options.id ?? "ai-sdk.google.default";
  const pluginId = options.pluginId ?? "andy.model.ai-sdk.google";
  const modelId = options.modelId ?? "gemini-2.0-flash";

  return {
    id,
    pluginId,
    modelId,
    createModel() {
      return Effect.fn("AiSdkGoogleModelProvider.createModel")(function* () {
        const apiKey = options.apiKey ?? process.env[googleApiKeyEnv];
        if (!apiKey) {
          return yield* Effect.fail(
            new ModelProviderError({
              providerId: id,
              message:
                "AI SDK Google provider requires GOOGLE_GENERATIVE_AI_API_KEY or an explicit apiKey.",
            }),
          );
        }
        return createGoogleGenerativeAI({ apiKey })(modelId);
      })();
    },
  };
}
