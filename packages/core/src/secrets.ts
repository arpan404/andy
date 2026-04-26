import type { AuditSink } from "@andy/audit";
import { Effect } from "effect";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

export class JsonFileSecretBroker extends InMemorySecretBroker {
  readonly #path: string;
  readonly #audit: AuditSink;

  constructor(options: { audit: AuditSink; path: string }) {
    super({ audit: options.audit });
    this.#audit = options.audit;
    this.#path = options.path;
  }

  load(): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.fn("JsonFileSecretBroker.load")(function* () {
      const text = yield* Effect.tryPromise({
        try: () => readFile(self.#path, "utf8"),
        catch: () => "{}",
      });
      const records = parseSecretRecords(text);
      for (const secret of records) {
        yield* self.set(secret);
      }
    })();
  }

  save(records: readonly SecretReference[]): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.fn("JsonFileSecretBroker.save")(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(self.#path), { recursive: true });
          await writeFile(
            self.#path,
            JSON.stringify(records.map(encodeSecretRecord), null, 2),
            "utf8",
          );
        },
        catch: (cause) => cause,
      });
      for (const secret of records) {
        yield* self.set(secret);
      }
      yield* self.#audit.record({
        type: "secret.requested",
        pluginId: "core",
        scope: "secret_store.write",
      });
    })();
  }
}

function toSecretKey(pluginId: string, scope: string): string {
  return `${pluginId}:${scope}`;
}

function encodeSecretRecord(secret: SecretReference): SecretReference {
  return {
    ...secret,
    value: Buffer.from(secret.value, "utf8").toString("base64"),
  };
}

function parseSecretRecords(text: string): SecretReference[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((item): SecretReference[] => {
    if (
      typeof item === "object" &&
      item !== null &&
      "pluginId" in item &&
      "scope" in item &&
      "value" in item &&
      typeof item.pluginId === "string" &&
      typeof item.scope === "string" &&
      typeof item.value === "string"
    ) {
      return [
        {
          pluginId: item.pluginId,
          scope: item.scope,
          value: Buffer.from(item.value, "base64").toString("utf8"),
        },
      ];
    }

    return [];
  });
}
