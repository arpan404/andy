import type { AuditSink } from "@andy/audit";
import {
  parsePluginManifest,
  type PluginManifest,
  type PluginSource,
} from "@andy/plugin-sdk";
import { Effect } from "effect";
import { PluginInstallError } from "./errors.js";
import { stringifyCause } from "./utils.js";

export interface PluginManifestFetcher {
  fetch(source: PluginSource): Effect.Effect<PluginManifest, PluginInstallError>;
}

export interface PluginInstallPlan {
  source: PluginSource;
  manifest: PluginManifest;
  pinnedSource: PluginSource;
  requiresApproval: boolean;
  approvalReasons: readonly string[];
  permissionSummary: readonly string[];
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
      const validated = yield* validateFetchedManifest(manifest, source);
      const pinnedSource = pinPluginSource(source);
      const permissionSummary = summarizeManifestPermissions(validated);
      yield* self.#audit.record({
        type: "plugin.install.requested",
        pluginId: validated.id,
        source: pinnedSource.reference,
      });
      return {
        source,
        pinnedSource,
        manifest: validated,
        requiresApproval: true,
        approvalReasons: [
          "Plugins are untrusted until the user reviews capabilities and permissions.",
        ],
        permissionSummary,
      };
    })();
  }

  complete(plan: PluginInstallPlan): Effect.Effect<void> {
    return this.#audit.record({
      type: "plugin.install.completed",
      pluginId: plan.manifest.id,
      source: plan.pinnedSource.reference,
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

          return parsePluginManifest(await response.json());
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

function validateFetchedManifest(
  manifest: PluginManifest,
  source: PluginSource,
): Effect.Effect<PluginManifest, PluginInstallError> {
  return Effect.try({
    try: () => {
      const validated = parsePluginManifest(manifest);
      if (validated.schemaVersion && validated.schemaVersion !== "1") {
        throw new Error(
          `Unsupported manifest schemaVersion '${validated.schemaVersion}'.`,
        );
      }
      if (validated.source && validated.source.reference !== source.reference) {
        throw new Error(
          `Manifest source '${validated.source.reference}' does not match requested source '${source.reference}'.`,
        );
      }
      return {
        ...validated,
        source: validated.source ?? source,
      };
    },
    catch: (cause) =>
      new PluginInstallError({
        source: source.reference,
        message: `Plugin manifest '${source.reference}' failed validation.`,
        cause: stringifyCause(cause),
      }),
  });
}

function pinPluginSource(source: PluginSource): PluginSource {
  if (source.type !== "github") {
    return source;
  }

  try {
    const url = new URL(source.reference);
    const ref = url.searchParams.get("ref");
    if (ref && isImmutableGitRef(ref)) {
      return source;
    }
  } catch {
    if (source.reference.includes("#") || source.reference.includes("@")) {
      return source;
    }
  }

  return {
    ...source,
    reference: `${source.reference}${source.reference.includes("?") ? "&" : "?"}pin-required=true`,
  };
}

function isImmutableGitRef(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref) || /^v?\d+\.\d+\.\d+/.test(ref);
}

function summarizeManifestPermissions(manifest: PluginManifest): readonly string[] {
  const permissions: string[] = [
    ...manifest.capabilities.map((capability) => `capability:${capability}`),
  ];
  for (const host of manifest.permissions?.network?.allowedHosts ?? []) {
    permissions.push(`network:${host}`);
  }
  for (const scope of manifest.permissions?.secrets?.scopes ?? []) {
    permissions.push(`secret:${scope}`);
  }
  for (const root of manifest.permissions?.filesystem?.readRoots ?? []) {
    permissions.push(`filesystem.read:${root}`);
  }
  for (const root of manifest.permissions?.filesystem?.writeRoots ?? []) {
    permissions.push(`filesystem.write:${root}`);
  }
  for (const root of manifest.permissions?.filesystem?.sensitiveReadRoots ?? []) {
    permissions.push(`filesystem.sensitive:${root.path}`);
  }
  return permissions.sort();
}
