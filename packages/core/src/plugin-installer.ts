import type { AuditSink } from "@andy/audit";
import type { PluginManifest, PluginSource } from "@andy/plugin-sdk";
import { Effect } from "effect";
import { PluginInstallError } from "./errors.js";
import { stringifyCause } from "./utils.js";

export interface PluginManifestFetcher {
  fetch(source: PluginSource): Effect.Effect<PluginManifest, PluginInstallError>;
}

export interface PluginInstallPlan {
  source: PluginSource;
  manifest: PluginManifest;
  requiresApproval: boolean;
  approvalReasons: readonly string[];
}

export class PluginInstaller {
  readonly #audit: AuditSink;
  readonly #fetcher: PluginManifestFetcher;

  constructor(options: { audit: AuditSink; fetcher: PluginManifestFetcher }) {
    this.#audit = options.audit;
    this.#fetcher = options.fetcher;
  }

  plan(source: PluginSource): Effect.Effect<PluginInstallPlan, PluginInstallError> {
    const self = this;
    return Effect.fn("PluginInstaller.plan")(function* () {
      const manifest = yield* self.#fetcher.fetch(source);
      yield* self.#audit.record({
        type: "plugin.install.requested",
        pluginId: manifest.id,
        source: source.reference,
      });
      return {
        source,
        manifest,
        requiresApproval: true,
        approvalReasons: [
          "Plugins are untrusted until the user reviews capabilities and permissions.",
        ],
      };
    })();
  }

  complete(plan: PluginInstallPlan): Effect.Effect<void> {
    return this.#audit.record({
      type: "plugin.install.completed",
      pluginId: plan.manifest.id,
      source: plan.source.reference,
    });
  }
}

export class StaticPluginManifestFetcher implements PluginManifestFetcher {
  readonly #manifests: ReadonlyMap<string, PluginManifest>;

  constructor(manifests: ReadonlyMap<string, PluginManifest>) {
    this.#manifests = manifests;
  }

  fetch(source: PluginSource): Effect.Effect<PluginManifest, PluginInstallError> {
    return Effect.fn("StaticPluginManifestFetcher.fetch")(() =>
      Effect.sync(() => this.#manifests.get(source.reference)).pipe(
        Effect.flatMap((manifest) =>
          manifest
            ? Effect.succeed(manifest)
            : Effect.fail(
                new PluginInstallError({
                  source: source.reference,
                  message: `No plugin manifest is available for '${source.reference}'.`,
                }),
              ),
        ),
      ),
    )();
  }
}

export class GitHubPluginManifestFetcher implements PluginManifestFetcher {
  fetch(source: PluginSource): Effect.Effect<PluginManifest, PluginInstallError> {
    return Effect.fn("GitHubPluginManifestFetcher.fetch")(() =>
      Effect.tryPromise({
        try: async () => {
          if (source.type !== "github") {
            throw new Error(`Unsupported plugin source '${source.type}'.`);
          }

          const response = await fetch(source.reference);
          if (!response.ok) {
            throw new Error(`Manifest fetch failed with status ${response.status}.`);
          }

          return (await response.json()) as PluginManifest;
        },
        catch: (cause) =>
          new PluginInstallError({
            source: source.reference,
            message: `Failed to fetch plugin manifest from '${source.reference}'.`,
            cause: stringifyCause(cause),
          }),
      }),
    )();
  }
}
