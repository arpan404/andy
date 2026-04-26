import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPolicyEngineFromConfig,
  JsonFilePolicyStore,
  type PolicyConfig,
} from "./index.js";

const tool = {
  name: "shell.execute",
  description: "Execute shell command.",
  capabilities: ["shell.execute"],
  risk: "high" as const,
  execute() {
    throw new Error("not used");
  },
};

describe("policy config", () => {
  test("asks for high-risk tools and honors expiring channel grants", async () => {
    const config: PolicyConfig = {
      allowedCapabilities: ["shell.execute"],
      approvalRequiredRisks: ["high"],
      grants: [
        {
          id: "grant-1",
          pluginId: "andy.shell",
          capability: "shell.execute",
          channelId: "telegram",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    };
    const policy = createPolicyEngineFromConfig(config);

    expect(
      policy.decide(tool, {}, { pluginId: "andy.shell", channelId: "telegram" }),
    ).toEqual({ type: "allow" });
    expect(policy.decide(tool, {}, { pluginId: "andy.shell" })).toEqual({
      type: "ask",
      reason: "Risk level 'high' requires approval.",
    });
  });

  test("persists policy config through the JSON store envelope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "andy-policy-"));
    const store = new JsonFilePolicyStore(join(dir, "policy.json"));
    const fallback: PolicyConfig = {
      allowedCapabilities: ["memory.save"],
      approvalRequiredCapabilities: ["memory.save"],
      approvalRequiredRisks: ["medium"],
    };

    const loaded = await Effect.runPromise(store.load(fallback));
    const reloaded = await Effect.runPromise(store.load({ allowedCapabilities: [] }));

    expect(loaded.allowedCapabilities).toEqual(["memory.save"]);
    expect(reloaded.approvalRequiredCapabilities).toEqual(["memory.save"]);
    expect(reloaded.approvalRequiredRisks).toEqual(["medium"]);
  });
});
