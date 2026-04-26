import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createInstallPlan,
  InMemoryPluginRegistry,
  JsonFilePluginRegistry,
} from "./index.js";

describe("createInstallPlan", () => {
  test("flags new capabilities and permissions for approval", () => {
    const plan = createInstallPlan(
      {
        type: "github",
        repository: "owner/plugin",
        ref: "abc123",
      },
      {
        id: "owner.plugin",
        name: "Owner Plugin",
        version: "0.1.0",
        entry: "./dist/index.js",
        capabilities: ["messaging.send"],
        risk: "high",
        permissions: {
          network: {
            allowedHosts: ["api.example.com"],
          },
          filesystem: {
            sensitiveReadRoots: [
              {
                path: "~/Library/Application Support/ExampleApp",
                reason: "Read ExampleApp data after approval.",
                dataClasses: ["app_data"],
              },
            ],
          },
        },
      },
    );

    expect(plan.requiresApproval).toBe(true);
    expect(plan.capabilityChanges).toEqual(["messaging.send"]);
    expect(plan.permissionChanges).toEqual([
      "filesystem.read_sensitive:~/Library/Application Support/ExampleApp",
      "network:api.example.com",
    ]);
  });
});

describe("InMemoryPluginRegistry", () => {
  test("installs disabled-by-default records and supports lifecycle transitions", async () => {
    const registry = new InMemoryPluginRegistry();
    const plan = createInstallPlan(
      {
        type: "local",
        path: "./plugins/example",
      },
      {
        id: "andy.example",
        name: "Example",
        version: "0.1.0",
        entry: "./dist/index.js",
        capabilities: ["memory.save"],
        risk: "medium",
      },
    );

    const installed = await Effect.runPromise(registry.install(plan));
    expect(installed.status).toBe("installed");

    const enabled = await Effect.runPromise(registry.enable("andy.example"));
    expect(enabled.status).toBe("enabled");

    const disabled = await Effect.runPromise(registry.disable("andy.example"));
    expect(disabled.status).toBe("disabled");
  });

  test("blocks upgrades with new capabilities until approved", async () => {
    const registry = new InMemoryPluginRegistry();
    const source = { type: "local" as const, path: "./plugins/example" };
    const installed = await Effect.runPromise(
      registry.install(
        createInstallPlan(source, {
          id: "andy.example",
          name: "Example",
          version: "0.1.0",
          entry: "./dist/index.js",
          capabilities: ["memory.save"],
          risk: "medium",
        }),
      ),
    );
    const upgradePlan = createInstallPlan(
      source,
      {
        id: "andy.example",
        name: "Example",
        version: "0.2.0",
        entry: "./dist/index.js",
        capabilities: ["memory.save", "messaging.send"],
        risk: "high",
      },
      installed,
    );

    const result = await Effect.runPromiseExit(
      registry.upgrade(upgradePlan, "not-approved"),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("PluginUpgradeRequiresApprovalError");
    }
  });
});

describe("JsonFilePluginRegistry", () => {
  test("persists installed plugin lifecycle records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "andy-plugin-registry-"));
    const path = join(dir, "plugins.json");
    const source = { type: "local" as const, path: "./plugins/example" };
    const manifest = {
      id: "andy.example",
      name: "Example",
      version: "0.1.0",
      entry: "./dist/index.js",
      capabilities: ["memory.save"],
      risk: "medium" as const,
    };

    const registry = new JsonFilePluginRegistry(path);
    await Effect.runPromise(registry.install(createInstallPlan(source, manifest)));
    await Effect.runPromise(registry.enable("andy.example"));

    const reloaded = new JsonFilePluginRegistry(path);
    const [record] = await Effect.runPromise(reloaded.list());

    expect(record?.manifest.id).toBe("andy.example");
    expect(record?.status).toBe("enabled");
    expect(record?.installedAt).toBeInstanceOf(Date);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(
      expect.objectContaining({ schemaVersion: 1 }),
    );
  });
});
