import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import {
  createAiSdkAnthropicModelProvider,
  createAiSdkGoogleModelProvider,
  createAiSdkOpenAiModelProvider,
} from "./index.js";

const openAiApiKeyEnv = "OPENAI_API_KEY";

describe("createAiSdkOpenAiModelProvider", () => {
  test("describes the default AI SDK OpenAI provider", () => {
    const provider = createAiSdkOpenAiModelProvider({ apiKey: "test-key" });

    expect(provider.id).toBe("ai-sdk.openai.default");
    expect(provider.pluginId).toBe("andy.model.ai-sdk.openai");
    expect(provider.modelId).toBe("gpt-4.1-mini");
  });

  test("fails without an API key before creating a model", async () => {
    const original = process.env[openAiApiKeyEnv];
    delete process.env[openAiApiKeyEnv];
    const provider = createAiSdkOpenAiModelProvider();

    const result = await Effect.runPromiseExit(provider.createModel());

    if (original) {
      process.env[openAiApiKeyEnv] = original;
    }
    expect(result._tag).toBe("Failure");
  });
});

describe("additional AI SDK providers", () => {
  test("describes Anthropic and Google providers without provider-native SDKs", () => {
    expect(createAiSdkAnthropicModelProvider({ apiKey: "test-key" }).pluginId).toBe(
      "andy.model.ai-sdk.anthropic",
    );
    expect(createAiSdkGoogleModelProvider({ apiKey: "test-key" }).pluginId).toBe(
      "andy.model.ai-sdk.google",
    );
  });
});
