import type { SkillLifecycleStatus, SkillManifest } from "@andy/skill-sdk";
import { Effect, Schema } from "effect";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type SkillInstallSource =
  | { type: "local"; path: string }
  | { type: "plugin"; pluginId: string; path: string }
  | { type: "github"; repository: string; ref: string; checkoutPath?: string }
  | { type: "marketplace"; packageId: string; version: string };

export interface InstalledSkillRecord {
  manifest: SkillManifest;
  source: SkillInstallSource;
  status: SkillLifecycleStatus;
  installedAt: Date;
  updatedAt: Date;
}

export interface SkillInstallPlan {
  source: SkillInstallSource;
  manifest: SkillManifest;
  capabilityChanges: string[];
  pluginChanges: string[];
  requiresApproval: boolean;
}

export class SkillRecordNotFoundError extends Schema.TaggedError<SkillRecordNotFoundError>()(
  "SkillRecordNotFoundError",
  {
    skillId: Schema.String,
    message: Schema.String,
  },
) {}

export class SkillUpgradeRequiresApprovalError extends Schema.TaggedError<SkillUpgradeRequiresApprovalError>()(
  "SkillUpgradeRequiresApprovalError",
  {
    skillId: Schema.String,
    capabilityChanges: Schema.Array(Schema.String),
    pluginChanges: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

export function createSkillInstallPlan(
  source: SkillInstallSource,
  manifest: SkillManifest,
  existing?: InstalledSkillRecord,
): SkillInstallPlan {
  return {
    source,
    manifest,
    capabilityChanges: diffList(
      existing?.manifest.requiredCapabilities ?? [],
      manifest.requiredCapabilities,
    ),
    pluginChanges: diffList(
      existing?.manifest.requiredPlugins ?? [],
      manifest.requiredPlugins,
    ),
    requiresApproval: true,
  };
}

export class InMemorySkillRegistry {
  readonly #records = new Map<string, InstalledSkillRecord>();

  install(plan: SkillInstallPlan): Effect.Effect<InstalledSkillRecord> {
    return Effect.sync(() => {
      const now = new Date();
      const record: InstalledSkillRecord = {
        manifest: plan.manifest,
        source: plan.source,
        status: "installed",
        installedAt: now,
        updatedAt: now,
      };
      this.#records.set(plan.manifest.id, record);
      return record;
    });
  }

  enable(
    skillId: string,
  ): Effect.Effect<InstalledSkillRecord, SkillRecordNotFoundError> {
    return this.#transition(skillId, "enabled");
  }

  disable(
    skillId: string,
  ): Effect.Effect<InstalledSkillRecord, SkillRecordNotFoundError> {
    return this.#transition(skillId, "disabled");
  }

  remove(
    skillId: string,
  ): Effect.Effect<InstalledSkillRecord, SkillRecordNotFoundError> {
    return this.#transition(skillId, "removed");
  }

  upgrade(
    plan: SkillInstallPlan,
    approval: "approved" | "not-approved",
  ): Effect.Effect<
    InstalledSkillRecord,
    SkillRecordNotFoundError | SkillUpgradeRequiresApprovalError
  > {
    return Effect.gen(this, function* () {
      const existing = yield* this.get(plan.manifest.id);
      if (
        approval !== "approved" &&
        (plan.capabilityChanges.length > 0 || plan.pluginChanges.length > 0)
      ) {
        return yield* Effect.fail(
          new SkillUpgradeRequiresApprovalError({
            skillId: plan.manifest.id,
            capabilityChanges: plan.capabilityChanges,
            pluginChanges: plan.pluginChanges,
            message: `Skill '${plan.manifest.id}' upgrade requires approval for new capabilities or plugins.`,
          }),
        );
      }
      const updated: InstalledSkillRecord = {
        manifest: plan.manifest,
        source: plan.source,
        status: existing.status === "removed" ? "installed" : existing.status,
        installedAt: existing.installedAt,
        updatedAt: new Date(),
      };
      this.#records.set(plan.manifest.id, updated);
      return updated;
    });
  }

  get(skillId: string): Effect.Effect<InstalledSkillRecord, SkillRecordNotFoundError> {
    return Effect.sync(() => this.#records.get(skillId)).pipe(
      Effect.flatMap((record) =>
        record
          ? Effect.succeed(record)
          : Effect.fail(
              new SkillRecordNotFoundError({
                skillId,
                message: `Skill '${skillId}' is not installed.`,
              }),
            ),
      ),
    );
  }

  list(): Effect.Effect<readonly InstalledSkillRecord[]> {
    return Effect.sync(() =>
      [...this.#records.values()].sort((a, b) =>
        a.manifest.id.localeCompare(b.manifest.id),
      ),
    );
  }

  hydrate(records: readonly InstalledSkillRecord[]): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#records.clear();
      for (const record of records) {
        this.#records.set(record.manifest.id, normalizeRecordDates(record));
      }
    });
  }

  #transition(
    skillId: string,
    status: SkillLifecycleStatus,
  ): Effect.Effect<InstalledSkillRecord, SkillRecordNotFoundError> {
    return this.get(skillId).pipe(
      Effect.map((record) => {
        const updated: InstalledSkillRecord = {
          ...record,
          status,
          updatedAt: new Date(),
        };
        this.#records.set(skillId, updated);
        return updated;
      }),
    );
  }
}

export class JsonFileSkillRegistry {
  readonly #path: string;
  readonly #delegate = new InMemorySkillRegistry();
  #loaded = false;

  constructor(path: string) {
    this.#path = path;
  }

  install(plan: SkillInstallPlan): Effect.Effect<InstalledSkillRecord, unknown> {
    return Effect.gen(this, function* () {
      yield* this.#loadOnce();
      const record = yield* this.#delegate.install(plan);
      yield* this.#save();
      return record;
    });
  }

  enable(skillId: string): Effect.Effect<InstalledSkillRecord, unknown> {
    return Effect.gen(this, function* () {
      yield* this.#loadOnce();
      const record = yield* this.#delegate.enable(skillId);
      yield* this.#save();
      return record;
    });
  }

  disable(skillId: string): Effect.Effect<InstalledSkillRecord, unknown> {
    return Effect.gen(this, function* () {
      yield* this.#loadOnce();
      const record = yield* this.#delegate.disable(skillId);
      yield* this.#save();
      return record;
    });
  }

  remove(skillId: string): Effect.Effect<InstalledSkillRecord, unknown> {
    return Effect.gen(this, function* () {
      yield* this.#loadOnce();
      const record = yield* this.#delegate.remove(skillId);
      yield* this.#save();
      return record;
    });
  }

  upgrade(
    plan: SkillInstallPlan,
    approval: "approved" | "not-approved",
  ): Effect.Effect<InstalledSkillRecord, unknown> {
    return Effect.gen(this, function* () {
      yield* this.#loadOnce();
      const record = yield* this.#delegate.upgrade(plan, approval);
      yield* this.#save();
      return record;
    });
  }

  get(skillId: string): Effect.Effect<InstalledSkillRecord, unknown> {
    return Effect.gen(this, function* () {
      yield* this.#loadOnce();
      return yield* this.#delegate.get(skillId);
    });
  }

  list(): Effect.Effect<readonly InstalledSkillRecord[], unknown> {
    return Effect.gen(this, function* () {
      yield* this.#loadOnce();
      return yield* this.#delegate.list();
    });
  }

  hydrate(records: readonly InstalledSkillRecord[]): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      this.#loaded = true;
      yield* this.#delegate.hydrate(records);
      yield* this.#save();
    });
  }

  #loadOnce(): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      if (this.#loaded) {
        return;
      }
      const records = yield* Effect.tryPromise({
        try: async () => {
          try {
            const text = await readFile(this.#path, "utf8");
            return parseSkillRegistryFile(JSON.parse(text));
          } catch (cause) {
            if (isFileNotFound(cause)) {
              return [];
            }
            throw cause;
          }
        },
        catch: (cause) => cause,
      });
      yield* this.#delegate.hydrate(records);
      this.#loaded = true;
    });
  }

  #save(): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      const skills = yield* this.#delegate.list();
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(this.#path), { recursive: true });
          const tempPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
          await writeFile(
            tempPath,
            `${JSON.stringify({ schemaVersion: 1, skills }, null, 2)}\n`,
            "utf8",
          );
          await rename(tempPath, this.#path);
        },
        catch: (cause) => cause,
      });
    });
  }
}

export class SqliteSkillRegistry {
  readonly #path: string;
  readonly #delegate = new InMemorySkillRegistry();
  #loaded = false;

  constructor(path: string) {
    this.#path = path;
  }

  install(plan: SkillInstallPlan): Effect.Effect<InstalledSkillRecord, unknown> {
    return Effect.gen(this, function* () {
      yield* this.#loadOnce();
      const record = yield* this.#delegate.install(plan);
      yield* this.#save();
      return record;
    });
  }

  enable(skillId: string): Effect.Effect<InstalledSkillRecord, unknown> {
    return Effect.gen(this, function* () {
      yield* this.#loadOnce();
      const record = yield* this.#delegate.enable(skillId);
      yield* this.#save();
      return record;
    });
  }

  disable(skillId: string): Effect.Effect<InstalledSkillRecord, unknown> {
    return Effect.gen(this, function* () {
      yield* this.#loadOnce();
      const record = yield* this.#delegate.disable(skillId);
      yield* this.#save();
      return record;
    });
  }

  remove(skillId: string): Effect.Effect<InstalledSkillRecord, unknown> {
    return Effect.gen(this, function* () {
      yield* this.#loadOnce();
      const record = yield* this.#delegate.remove(skillId);
      yield* this.#save();
      return record;
    });
  }

  upgrade(
    plan: SkillInstallPlan,
    approval: "approved" | "not-approved",
  ): Effect.Effect<InstalledSkillRecord, unknown> {
    return Effect.gen(this, function* () {
      yield* this.#loadOnce();
      const record = yield* this.#delegate.upgrade(plan, approval);
      yield* this.#save();
      return record;
    });
  }

  get(skillId: string): Effect.Effect<InstalledSkillRecord, unknown> {
    return Effect.gen(this, function* () {
      yield* this.#loadOnce();
      return yield* this.#delegate.get(skillId);
    });
  }

  list(): Effect.Effect<readonly InstalledSkillRecord[], unknown> {
    return Effect.gen(this, function* () {
      yield* this.#loadOnce();
      return yield* this.#delegate.list();
    });
  }

  hydrate(records: readonly InstalledSkillRecord[]): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      this.#loaded = true;
      yield* this.#delegate.hydrate(records);
      yield* this.#save();
    });
  }

  #loadOnce(): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      if (this.#loaded) {
        return;
      }
      const records = yield* Effect.try({
        try: () => {
          const database = this.#open();
          try {
            return database
              .query("select record_json from skill_registry order by skill_id")
              .all()
              .flatMap((row) => parseSkillRegistryRow(row));
          } finally {
            database.close();
          }
        },
        catch: (cause) => cause,
      });
      yield* this.#delegate.hydrate(records);
      this.#loaded = true;
    });
  }

  #save(): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      const skills = yield* this.#delegate.list();
      yield* Effect.try({
        try: () => {
          const database = this.#open();
          try {
            const transaction = database.transaction(
              (records: readonly InstalledSkillRecord[]) => {
                database.query("delete from skill_registry").run();
                const insert = database.query(
                  "insert into skill_registry (skill_id, status, record_json, updated_at) values ($skill_id, $status, $record_json, $updated_at)",
                );
                for (const record of records) {
                  insert.run({
                    $skill_id: record.manifest.id,
                    $status: record.status,
                    $record_json: JSON.stringify(record),
                    $updated_at: record.updatedAt.toISOString(),
                  });
                }
              },
            );
            transaction(skills);
          } finally {
            database.close();
          }
        },
        catch: (cause) => cause,
      });
    });
  }

  #open(): Database {
    mkdirSync(dirname(this.#path), { recursive: true });
    const database = new Database(this.#path);
    database.exec(`
      create table if not exists skill_registry (
        skill_id text primary key,
        status text not null,
        record_json text not null,
        updated_at text not null
      );
    `);
    return database;
  }
}

function parseSkillRegistryRow(row: unknown): InstalledSkillRecord[] {
  if (typeof row !== "object" || row === null) {
    return [];
  }
  const recordJson = (row as { record_json?: unknown }).record_json;
  if (typeof recordJson !== "string") {
    return [];
  }
  return [normalizeRecordDates(JSON.parse(recordJson) as InstalledSkillRecord)];
}

function parseSkillRegistryFile(value: unknown): InstalledSkillRecord[] {
  const record =
    typeof value === "object" && value !== null
      ? (value as { skills?: unknown; value?: unknown })
      : {};
  const candidate = Array.isArray(record.skills)
    ? record.skills
    : typeof record.value === "object" && record.value !== null
      ? (record.value as { skills?: unknown }).skills
      : undefined;
  return Array.isArray(candidate) ? candidate.map(normalizeRecordDates) : [];
}

function diffList(previous: readonly string[], next: readonly string[]): string[] {
  const previousSet = new Set(previous);
  return next.filter((item) => !previousSet.has(item)).sort();
}

function normalizeRecordDates(record: InstalledSkillRecord): InstalledSkillRecord {
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
