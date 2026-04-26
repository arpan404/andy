import type {
  PluginLifecycleStatus,
  PluginManifest,
  RiskLevel,
} from "@andy/plugin-sdk";
import { Effect, Schema } from "effect";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type PluginInstallSource =
  | {
      type: "github";
      repository: string;
      ref: string;
      checkoutPath?: string;
    }
  | {
      type: "marketplace";
      packageId: string;
      version: string;
    }
  | {
      type: "local";
      path: string;
    };

export interface InstalledPluginRecord {
  manifest: PluginManifest;
  source: PluginInstallSource;
  status: PluginLifecycleStatus;
  installedAt: Date;
  updatedAt: Date;
}

export interface PluginInstallPlan {
  source: PluginInstallSource;
  manifest: PluginManifest;
  capabilityChanges: string[];
  permissionChanges: string[];
  requiresApproval: boolean;
  risk: RiskLevel;
}

export class PluginRecordNotFoundError extends Schema.TaggedError<PluginRecordNotFoundError>()(
  "PluginRecordNotFoundError",
  {
    pluginId: Schema.String,
    message: Schema.String,
  },
) {}

export class PluginUpgradeRequiresApprovalError extends Schema.TaggedError<PluginUpgradeRequiresApprovalError>()(
  "PluginUpgradeRequiresApprovalError",
  {
    pluginId: Schema.String,
    capabilityChanges: Schema.Array(Schema.String),
    permissionChanges: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

export type PluginRegistryError =
  | PluginRecordNotFoundError
  | PluginUpgradeRequiresApprovalError;

export function createInstallPlan(
  source: PluginInstallSource,
  manifest: PluginManifest,
  existing?: InstalledPluginRecord,
): PluginInstallPlan {
  return {
    source,
    manifest,
    capabilityChanges: diffList(
      existing?.manifest.capabilities ?? [],
      manifest.capabilities,
    ),
    permissionChanges: diffPermissions(existing?.manifest, manifest),
    requiresApproval: true,
    risk: manifest.risk,
  };
}

export class InMemoryPluginRegistry {
  readonly #records = new Map<string, InstalledPluginRecord>();

  install(plan: PluginInstallPlan): Effect.Effect<InstalledPluginRecord> {
    return Effect.fn("InMemoryPluginRegistry.install")(() =>
      Effect.sync(() => {
        const now = new Date();
        const record: InstalledPluginRecord = {
          manifest: plan.manifest,
          source: plan.source,
          status: "installed",
          installedAt: now,
          updatedAt: now,
        };
        this.#records.set(plan.manifest.id, record);
        return record;
      }),
    )();
  }

  enable(
    pluginId: string,
  ): Effect.Effect<InstalledPluginRecord, PluginRecordNotFoundError> {
    return this.#transition(pluginId, "enabled");
  }

  disable(
    pluginId: string,
  ): Effect.Effect<InstalledPluginRecord, PluginRecordNotFoundError> {
    return this.#transition(pluginId, "disabled");
  }

  remove(
    pluginId: string,
  ): Effect.Effect<InstalledPluginRecord, PluginRecordNotFoundError> {
    return this.#transition(pluginId, "removed");
  }

  upgrade(
    plan: PluginInstallPlan,
    approval: "approved" | "not-approved",
  ): Effect.Effect<
    InstalledPluginRecord,
    PluginRecordNotFoundError | PluginUpgradeRequiresApprovalError
  > {
    return Effect.fn("InMemoryPluginRegistry.upgrade")(function* (
      this: InMemoryPluginRegistry,
    ) {
      const existing = yield* this.get(plan.manifest.id);
      if (
        approval !== "approved" &&
        (plan.capabilityChanges.length > 0 || plan.permissionChanges.length > 0)
      ) {
        return yield* Effect.fail(
          new PluginUpgradeRequiresApprovalError({
            pluginId: plan.manifest.id,
            capabilityChanges: plan.capabilityChanges,
            permissionChanges: plan.permissionChanges,
            message: `Plugin '${plan.manifest.id}' upgrade requires approval for new capabilities or permissions.`,
          }),
        );
      }

      const updated: InstalledPluginRecord = {
        manifest: plan.manifest,
        source: plan.source,
        status: existing.status === "removed" ? "installed" : existing.status,
        installedAt: existing.installedAt,
        updatedAt: new Date(),
      };
      this.#records.set(plan.manifest.id, updated);
      return updated;
    }).bind(this)();
  }

  get(
    pluginId: string,
  ): Effect.Effect<InstalledPluginRecord, PluginRecordNotFoundError> {
    return Effect.fn("InMemoryPluginRegistry.get")(() =>
      Effect.sync(() => this.#records.get(pluginId)).pipe(
        Effect.flatMap((record) =>
          record
            ? Effect.succeed(record)
            : Effect.fail(
                new PluginRecordNotFoundError({
                  pluginId,
                  message: `Plugin '${pluginId}' is not installed.`,
                }),
              ),
        ),
      ),
    )();
  }

  list(): Effect.Effect<readonly InstalledPluginRecord[]> {
    return Effect.fn("InMemoryPluginRegistry.list")(() =>
      Effect.sync(() =>
        [...this.#records.values()].sort((a, b) =>
          a.manifest.id.localeCompare(b.manifest.id),
        ),
      ),
    )();
  }

  hydrate(records: readonly InstalledPluginRecord[]): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#records.clear();
      for (const record of records) {
        this.#records.set(record.manifest.id, normalizeRecordDates(record));
      }
    });
  }

  #transition(
    pluginId: string,
    status: PluginLifecycleStatus,
  ): Effect.Effect<InstalledPluginRecord, PluginRecordNotFoundError> {
    return Effect.fn("InMemoryPluginRegistry.transition")(() =>
      this.get(pluginId).pipe(
        Effect.map((record) => {
          const updated: InstalledPluginRecord = {
            ...record,
            status,
            updatedAt: new Date(),
          };
          this.#records.set(pluginId, updated);
          return updated;
        }),
      ),
    )();
  }
}

export class JsonFilePluginRegistry {
  readonly #path: string;
  readonly #delegate = new InMemoryPluginRegistry();
  #loaded = false;

  constructor(path: string) {
    this.#path = path;
  }

  install(plan: PluginInstallPlan): Effect.Effect<InstalledPluginRecord, unknown> {
    const self = this;
    return Effect.fn("JsonFilePluginRegistry.install")(function* () {
      yield* self.#loadOnce();
      const record = yield* self.#delegate.install(plan);
      yield* self.#save();
      return record;
    })();
  }

  enable(pluginId: string): Effect.Effect<InstalledPluginRecord, unknown> {
    const self = this;
    return Effect.fn("JsonFilePluginRegistry.enable")(function* () {
      yield* self.#loadOnce();
      const record = yield* self.#delegate.enable(pluginId);
      yield* self.#save();
      return record;
    })();
  }

  disable(pluginId: string): Effect.Effect<InstalledPluginRecord, unknown> {
    const self = this;
    return Effect.fn("JsonFilePluginRegistry.disable")(function* () {
      yield* self.#loadOnce();
      const record = yield* self.#delegate.disable(pluginId);
      yield* self.#save();
      return record;
    })();
  }

  remove(pluginId: string): Effect.Effect<InstalledPluginRecord, unknown> {
    const self = this;
    return Effect.fn("JsonFilePluginRegistry.remove")(function* () {
      yield* self.#loadOnce();
      const record = yield* self.#delegate.remove(pluginId);
      yield* self.#save();
      return record;
    })();
  }

  upgrade(
    plan: PluginInstallPlan,
    approval: "approved" | "not-approved",
  ): Effect.Effect<InstalledPluginRecord, unknown> {
    const self = this;
    return Effect.fn("JsonFilePluginRegistry.upgrade")(function* () {
      yield* self.#loadOnce();
      const record = yield* self.#delegate.upgrade(plan, approval);
      yield* self.#save();
      return record;
    })();
  }

  get(pluginId: string): Effect.Effect<InstalledPluginRecord, unknown> {
    const self = this;
    return Effect.fn("JsonFilePluginRegistry.get")(function* () {
      yield* self.#loadOnce();
      return yield* self.#delegate.get(pluginId);
    })();
  }

  list(): Effect.Effect<readonly InstalledPluginRecord[], unknown> {
    const self = this;
    return Effect.fn("JsonFilePluginRegistry.list")(function* () {
      yield* self.#loadOnce();
      return yield* self.#delegate.list();
    })();
  }

  hydrate(records: readonly InstalledPluginRecord[]): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.fn("JsonFilePluginRegistry.hydrate")(function* () {
      self.#loaded = true;
      yield* self.#delegate.hydrate(records);
      yield* self.#save();
    })();
  }

  #loadOnce(): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.fn("JsonFilePluginRegistry.loadOnce")(function* () {
      if (self.#loaded) {
        return;
      }
      const records = yield* Effect.tryPromise({
        try: async () => {
          try {
            const text = await readFile(self.#path, "utf8");
            return parsePluginRegistryFile(JSON.parse(text));
          } catch (cause) {
            if (isFileNotFound(cause)) {
              return [];
            }
            throw cause;
          }
        },
        catch: (cause) => cause,
      });
      yield* self.#delegate.hydrate(records);
      self.#loaded = true;
    })();
  }

  #save(): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.fn("JsonFilePluginRegistry.save")(function* () {
      const plugins = yield* self.#delegate.list();
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(self.#path), { recursive: true });
          const tempPath = `${self.#path}.${process.pid}.${crypto.randomUUID()}.tmp`;
          await writeFile(
            tempPath,
            `${JSON.stringify(
              {
                schemaVersion: 1,
                plugins,
              },
              null,
              2,
            )}\n`,
            "utf8",
          );
          await rename(tempPath, self.#path);
        },
        catch: (cause) => cause,
      });
    })();
  }
}

function parsePluginRegistryFile(value: unknown): InstalledPluginRecord[] {
  const record =
    typeof value === "object" && value !== null
      ? (value as { plugins?: unknown; value?: unknown })
      : {};
  const candidate = Array.isArray(record.plugins)
    ? record.plugins
    : typeof record.value === "object" && record.value !== null
      ? (record.value as { plugins?: unknown }).plugins
      : undefined;
  return Array.isArray(candidate) ? candidate.map(normalizeRecordDates) : [];
}

function diffList(previous: string[], next: string[]): string[] {
  const previousSet = new Set(previous);
  return next.filter((item) => !previousSet.has(item)).sort();
}

function diffPermissions(
  previous: PluginManifest | undefined,
  next: PluginManifest,
): string[] {
  const changes: string[] = [];
  const previousHosts = previous?.permissions?.network?.allowedHosts ?? [];
  const nextHosts = next.permissions?.network?.allowedHosts ?? [];
  for (const host of diffList(previousHosts, nextHosts)) {
    changes.push(`network:${host}`);
  }

  const previousReadRoots = previous?.permissions?.filesystem?.readRoots ?? [];
  const nextReadRoots = next.permissions?.filesystem?.readRoots ?? [];
  for (const root of diffList(previousReadRoots, nextReadRoots)) {
    changes.push(`filesystem.read:${root}`);
  }

  const previousSensitiveReadRoots =
    previous?.permissions?.filesystem?.sensitiveReadRoots?.map((root) => root.path) ??
    [];
  const nextSensitiveReadRoots =
    next.permissions?.filesystem?.sensitiveReadRoots?.map((root) => root.path) ?? [];
  for (const root of diffList(previousSensitiveReadRoots, nextSensitiveReadRoots)) {
    changes.push(`filesystem.read_sensitive:${root}`);
  }

  const previousWriteRoots = previous?.permissions?.filesystem?.writeRoots ?? [];
  const nextWriteRoots = next.permissions?.filesystem?.writeRoots ?? [];
  for (const root of diffList(previousWriteRoots, nextWriteRoots)) {
    changes.push(`filesystem.write:${root}`);
  }

  return changes.sort();
}

function normalizeRecordDates(record: InstalledPluginRecord): InstalledPluginRecord {
  return {
    ...record,
    installedAt: new Date(record.installedAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function isFileNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}
