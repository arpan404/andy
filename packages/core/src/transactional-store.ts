import { Effect } from "effect";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface VersionedJsonEnvelope<T> {
  schemaVersion: number;
  value: T;
}

export class AtomicJsonFileStore<T> {
  readonly #path: string;
  readonly #schemaVersion: number;
  readonly #parse: (value: unknown) => T;

  constructor(options: {
    path: string;
    schemaVersion: number;
    parse(value: unknown): T;
  }) {
    this.#path = options.path;
    this.#schemaVersion = options.schemaVersion;
    this.#parse = options.parse;
  }

  load(): Effect.Effect<T | undefined, unknown> {
    const self = this;
    return Effect.fn("AtomicJsonFileStore.load")(function* () {
      const loaded = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await readFile(self.#path, "utf8");
          } catch (cause) {
            if (isFileNotFound(cause)) {
              return undefined;
            }
            throw cause;
          }
        },
        catch: (cause) => cause,
      });
      if (loaded === undefined) {
        return undefined;
      }

      const parsed = JSON.parse(loaded) as unknown;
      if (isVersionedJsonEnvelope(parsed)) {
        return self.#parse(parsed.value);
      }
      return self.#parse(parsed);
    })();
  }

  save(value: T): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.fn("AtomicJsonFileStore.save")(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(self.#path), { recursive: true });
          const tempPath = `${self.#path}.${process.pid}.${crypto.randomUUID()}.tmp`;
          const envelope: VersionedJsonEnvelope<T> = {
            schemaVersion: self.#schemaVersion,
            value,
          };
          await writeFile(tempPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
          await rename(tempPath, self.#path);
        },
        catch: (cause) => cause,
      });
    })();
  }
}

function isVersionedJsonEnvelope(
  value: unknown,
): value is VersionedJsonEnvelope<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    "value" in value
  );
}

function isFileNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}
