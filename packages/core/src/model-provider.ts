import type { LanguageModel } from "ai";
import { Effect, Schema } from "effect";
import { AiSdkLlmRunner } from "./llm.js";
import type { StreamingLlmRunner } from "./types.js";

export interface ModelProvider {
  id: string;
  pluginId: string;
  modelId: string;
  createModel(): Effect.Effect<LanguageModel, ModelProviderError>;
}

export class ModelProviderError extends Schema.TaggedError<ModelProviderError>()(
  "ModelProviderError",
  {
    providerId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.String),
  },
) {}

export class ModelProviderRegistry {
  readonly #providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#providers.set(provider.id, provider);
    });
  }

  createRunner(
    providerId: string,
  ): Effect.Effect<StreamingLlmRunner, ModelProviderError> {
    const self = this;
    return Effect.fn("ModelProviderRegistry.createRunner")(function* () {
      const provider = self.#providers.get(providerId);
      if (!provider) {
        return yield* Effect.fail(
          new ModelProviderError({
            providerId,
            message: `Model provider '${providerId}' is not registered.`,
          }),
        );
      }

      const model = yield* provider.createModel();
      return new AiSdkLlmRunner({ model });
    })();
  }

  list(): readonly ModelProvider[] {
    return [...this.#providers.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
