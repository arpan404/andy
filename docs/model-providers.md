# Model Providers

Andy Core owns the model-provider registry and Vercel AI SDK runner boundary. Concrete providers live outside core so model/vendor behavior can evolve independently, but they must construct AI SDK `LanguageModel` instances rather than call provider-native SDKs directly.

## AI SDK Providers

The first provider package is:

```text
@andy/model-ai-sdk
```

It exposes `createAiSdkOpenAiModelProvider`, which registers a provider behind the core `ModelProviderRegistry`. It uses `@ai-sdk/openai` from Vercel's AI SDK and does not make a network call until a runner actually invokes the model.

Default provider metadata:

```json
{
  "id": "ai-sdk.openai.default",
  "pluginId": "andy.model.ai-sdk.openai",
  "modelId": "gpt-4.1-mini"
}
```

## Daemon Config

AI SDK OpenAI is configured in `.andy/daemon.json` under `modelProviders`:

```json
{
  "modelProviders": [
    {
      "id": "ai-sdk.openai.default",
      "provider": "ai-sdk.openai",
      "enabled": true,
      "modelId": "gpt-4.1-mini",
      "apiKeyEnv": "OPENAI_API_KEY"
    }
  ]
}
```

The default generated config includes this provider disabled. Enable it only when the user has configured the referenced environment variable.

## Security

- API keys stay outside config by default and are read from environment variables.
- Provider registration does not expose the raw API key through daemon status.
- Model calls still go through the core AI SDK runner, tool adapter, policy-gated runtime, and audit surface.
- Provider integrations must depend on Vercel AI SDK provider packages such as `@ai-sdk/openai`, not provider-native SDKs.
