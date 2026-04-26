import { createOpenAI } from "@ai-sdk/openai";
import type { ModelProvider } from "@andy/core";
import { ModelProviderError } from "@andy/core";
import { Effect } from "effect";

const openAiApiKeyEnv = "OPENAI_API_KEY";

export interface AiSdkOpenAiModelProviderOptions {
  id?: string;
  pluginId?: string;
  modelId?: string;
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
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
