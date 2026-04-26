import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSkillInstallPlan,
  InMemorySkillRegistry,
  JsonFileSkillRegistry,
} from "./index.js";

const manifest = {
  id: "andy.skills.remember",
  name: "Remember",
  version: "0.1.0",
  description: "Save memory.",
  risk: "high" as const,
  requiredPlugins: ["andy.memory.markdown"],
  requiredCapabilities: ["memory.save"],
  workflows: [
    {
      name: "save",
      description: "Save.",
      steps: [
        {
          id: "save",
          toolName: "andy.memory.markdown.memory.save",
          input: { key: "{{input.key}}" },
        },
      ],
    },
  ],
};

describe("skill registries", () => {
  test("installs and enables skills", async () => {
    const registry = new InMemorySkillRegistry();
    await Effect.runPromise(
      registry.install(
        createSkillInstallPlan({ type: "local", path: "skills/a" }, manifest),
      ),
    );
    const enabled = await Effect.runPromise(registry.enable(manifest.id));

    expect(enabled.status).toBe("enabled");
  });

  test("persists skill records to an atomic JSON envelope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "andy-skills-"));
    const registry = new JsonFileSkillRegistry(join(dir, "skills.json"));
    await Effect.runPromise(
      registry.install(
        createSkillInstallPlan({ type: "local", path: "skills/a" }, manifest),
      ),
    );

    const loaded = await Effect.runPromise(
      new JsonFileSkillRegistry(join(dir, "skills.json")).list(),
    );

    expect(loaded[0]?.manifest.id).toBe(manifest.id);
  });
});
