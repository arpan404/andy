import type {
  PluginLifecycleStatus,
  PluginManifest,
  RiskLevel,
} from "@andy/plugin-sdk";
import { Effect, Schema } from "effect";
import { Database } from "bun:sqlite";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { mkdirSync } from "node:fs";
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
  trust?: PluginTrustRecord;
}

export interface PluginInstallPlan {
  source: PluginInstallSource;
  manifest: PluginManifest;
  capabilityChanges: string[];
  permissionChanges: string[];
  requiresApproval: boolean;
  risk: RiskLevel;
  trust: PluginTrustRecord;
}

export interface PluginTrustRecord {
  signatureStatus: "unsigned" | "verified";
  publisherId?: string;
  publicKeyFingerprint?: string;
  verifiedAt?: Date;
}

export interface PluginSignatureFile {
  algorithm: "ed25519";
  signature: string;
  publicKey?: string;
  publisherId?: string;
  signedAt?: string;
}

export interface TrustedPluginPublisher {
  id: string;
  publicKey: string;
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
  options: { trust?: PluginTrustRecord } = {},
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
    trust: options.trust ?? { signatureStatus: "unsigned" },
  };
}

export function signPluginManifest(input: {
  manifest: PluginManifest;
  privateKey: string;
}): PluginSignatureFile {
  const signature = nodeSign(
    null,
    Buffer.from(canonicalPluginManifest(input.manifest), "utf8"),
    createPrivateKey(input.privateKey),
  );
  return {
    algorithm: "ed25519",
    signature: signature.toString("base64"),
  };
}

export function verifyPluginManifestSignature(input: {
  manifest: PluginManifest;
  signature: PluginSignatureFile | undefined;
  trustedPublishers: readonly TrustedPluginPublisher[];
}): PluginTrustRecord {
  if (!input.signature) {
    return { signatureStatus: "unsigned" };
  }
  const publisher = input.trustedPublishers.find(
    (candidate) =>
      candidate.id === input.signature?.publisherId ||
      candidate.publicKey === input.signature?.publicKey,
  );
  const publicKey = publisher?.publicKey ?? input.signature.publicKey;
  if (!publicKey) {
    return { signatureStatus: "unsigned" };
  }
  const verified = nodeVerify(
    null,
    Buffer.from(canonicalPluginManifest(input.manifest), "utf8"),
    createPublicKey(publicKey),
    Buffer.from(input.signature.signature, "base64"),
  );
  if (!verified) {
    return { signatureStatus: "unsigned" };
  }
  return {
    signatureStatus: "verified",
    ...(publisher?.id || input.signature.publisherId
      ? { publisherId: publisher?.id ?? input.signature.publisherId }
      : {}),
    publicKeyFingerprint: fingerprintPublicKey(publicKey),
    verifiedAt: new Date(),
  };
}

export function parsePluginSignatureFile(input: unknown): PluginSignatureFile {
  if (typeof input !== "object" || input === null) {
    throw new Error("Plugin signature must be an object.");
  }
  const record = input as Partial<PluginSignatureFile>;
  if (record.algorithm !== "ed25519") {
    throw new Error("Plugin signature algorithm must be ed25519.");
  }
  if (typeof record.signature !== "string") {
    throw new Error("Plugin signature is required.");
  }
  return {
    algorithm: "ed25519",
    signature: record.signature,
    ...(typeof record.publicKey === "string" ? { publicKey: record.publicKey } : {}),
    ...(typeof record.publisherId === "string"
      ? { publisherId: record.publisherId }
      : {}),
    ...(typeof record.signedAt === "string" ? { signedAt: record.signedAt } : {}),
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
          trust: normalizeTrustRecord(plan.trust),
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
        trust: normalizeTrustRecord(plan.trust),
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

export class SqlitePluginRegistry {
  readonly #path: string;
  readonly #delegate = new InMemoryPluginRegistry();
  #loaded = false;

  constructor(path: string) {
    this.#path = path;
  }

  install(plan: PluginInstallPlan): Effect.Effect<InstalledPluginRecord, unknown> {
    const self = this;
    return Effect.fn("SqlitePluginRegistry.install")(function* () {
      yield* self.#loadOnce();
      const record = yield* self.#delegate.install(plan);
      yield* self.#save();
      return record;
    })();
  }

  enable(pluginId: string): Effect.Effect<InstalledPluginRecord, unknown> {
    const self = this;
    return Effect.fn("SqlitePluginRegistry.enable")(function* () {
      yield* self.#loadOnce();
      const record = yield* self.#delegate.enable(pluginId);
      yield* self.#save();
      return record;
    })();
  }

  disable(pluginId: string): Effect.Effect<InstalledPluginRecord, unknown> {
    const self = this;
    return Effect.fn("SqlitePluginRegistry.disable")(function* () {
      yield* self.#loadOnce();
      const record = yield* self.#delegate.disable(pluginId);
      yield* self.#save();
      return record;
    })();
  }

  remove(pluginId: string): Effect.Effect<InstalledPluginRecord, unknown> {
    const self = this;
    return Effect.fn("SqlitePluginRegistry.remove")(function* () {
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
    return Effect.fn("SqlitePluginRegistry.upgrade")(function* () {
      yield* self.#loadOnce();
      const record = yield* self.#delegate.upgrade(plan, approval);
      yield* self.#save();
      return record;
    })();
  }

  get(pluginId: string): Effect.Effect<InstalledPluginRecord, unknown> {
    const self = this;
    return Effect.fn("SqlitePluginRegistry.get")(function* () {
      yield* self.#loadOnce();
      return yield* self.#delegate.get(pluginId);
    })();
  }

  list(): Effect.Effect<readonly InstalledPluginRecord[], unknown> {
    const self = this;
    return Effect.fn("SqlitePluginRegistry.list")(function* () {
      yield* self.#loadOnce();
      return yield* self.#delegate.list();
    })();
  }

  hydrate(records: readonly InstalledPluginRecord[]): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.fn("SqlitePluginRegistry.hydrate")(function* () {
      self.#loaded = true;
      yield* self.#delegate.hydrate(records);
      yield* self.#save();
    })();
  }

  #loadOnce(): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.fn("SqlitePluginRegistry.loadOnce")(function* () {
      if (self.#loaded) {
        return;
      }
      const records = yield* Effect.try({
        try: () => {
          const database = self.#open();
          try {
            return database
              .query("select record_json from plugin_registry order by plugin_id")
              .all()
              .flatMap((row) => parsePluginRegistryRow(row));
          } finally {
            database.close();
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
    return Effect.fn("SqlitePluginRegistry.save")(function* () {
      const plugins = yield* self.#delegate.list();
      yield* Effect.try({
        try: () => {
          const database = self.#open();
          try {
            const transaction = database.transaction(
              (records: readonly InstalledPluginRecord[]) => {
                database.query("delete from plugin_registry").run();
                const insert = database.query(
                  "insert into plugin_registry (plugin_id, status, record_json, updated_at) values ($plugin_id, $status, $record_json, $updated_at)",
                );
                for (const record of records) {
                  insert.run({
                    $plugin_id: record.manifest.id,
                    $status: record.status,
                    $record_json: JSON.stringify(record),
                    $updated_at: record.updatedAt.toISOString(),
                  });
                }
              },
            );
            transaction(plugins);
          } finally {
            database.close();
          }
        },
        catch: (cause) => cause,
      });
    })();
  }

  #open(): Database {
    mkdirSync(dirname(this.#path), { recursive: true });
    const database = new Database(this.#path);
    database.exec(`
      create table if not exists plugin_registry (
        plugin_id text primary key,
        status text not null,
        record_json text not null,
        updated_at text not null
      );
    `);
    return database;
  }
}

function parsePluginRegistryRow(row: unknown): InstalledPluginRecord[] {
  if (typeof row !== "object" || row === null) {
    return [];
  }
  const recordJson = (row as { record_json?: unknown }).record_json;
  if (typeof recordJson !== "string") {
    return [];
  }
  return [normalizeRecordDates(JSON.parse(recordJson) as InstalledPluginRecord)];
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
    ...(record.trust ? { trust: normalizeTrustRecord(record.trust) } : {}),
  };
}

function normalizeTrustRecord(record: PluginTrustRecord): PluginTrustRecord {
  return {
    signatureStatus: record.signatureStatus,
    ...(record.publisherId ? { publisherId: record.publisherId } : {}),
    ...(record.publicKeyFingerprint
      ? { publicKeyFingerprint: record.publicKeyFingerprint }
      : {}),
    ...(record.verifiedAt ? { verifiedAt: new Date(record.verifiedAt) } : {}),
  };
}

function canonicalPluginManifest(manifest: PluginManifest): string {
  return stableStringify(manifest);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function fingerprintPublicKey(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex");
}

function isFileNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}
