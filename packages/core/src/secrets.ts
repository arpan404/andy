import type { AuditSink } from "@andy/audit";
import { Effect } from "effect";
import { SecretAccessDeniedError, SecretNotFoundError } from "./errors.js";

export interface SecretRequest {
  pluginId: string;
  scope: string;
  declaredScopes: ReadonlySet<string>;
}

export interface SecretReference {
  pluginId: string;
  scope: string;
  value: string;
}

export class InMemorySecretBroker {
  readonly #audit: AuditSink;
  readonly #secrets = new Map<string, string>();

  constructor(options: { audit: AuditSink }) {
    this.#audit = options.audit;
  }

  set(secret: SecretReference): Effect.Effect<void> {
    return Effect.fn("InMemorySecretBroker.set")(() =>
      Effect.sync(() => {
        this.#secrets.set(toSecretKey(secret.pluginId, secret.scope), secret.value);
      }),
    )();
  }

  get(
    request: SecretRequest,
  ): Effect.Effect<string, SecretAccessDeniedError | SecretNotFoundError> {
    const self = this;
    return Effect.fn("InMemorySecretBroker.get")(function* () {
      yield* self.#audit.record({
        type: "secret.requested",
        pluginId: request.pluginId,
        scope: request.scope,
      });

      if (!request.declaredScopes.has(request.scope)) {
        return yield* Effect.fail(
          new SecretAccessDeniedError({
            pluginId: request.pluginId,
            scope: request.scope,
            message: `Plugin '${request.pluginId}' did not declare secret scope '${request.scope}'.`,
          }),
        );
      }

      const value = self.#secrets.get(toSecretKey(request.pluginId, request.scope));
      if (!value) {
        return yield* Effect.fail(
          new SecretNotFoundError({
            pluginId: request.pluginId,
            scope: request.scope,
            message: `Secret scope '${request.scope}' is not configured for plugin '${request.pluginId}'.`,
          }),
        );
      }

      return value;
    })();
  }
}

function toSecretKey(pluginId: string, scope: string): string {
  return `${pluginId}:${scope}`;
}
