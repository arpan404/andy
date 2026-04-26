import { describe, expect, test } from "bun:test";
import { createInstallPlan } from "./index.js";

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
        },
      },
    );

    expect(plan.requiresApproval).toBe(true);
    expect(plan.capabilityChanges).toEqual(["messaging.send"]);
    expect(plan.permissionChanges).toEqual(["network:api.example.com"]);
  });
});
