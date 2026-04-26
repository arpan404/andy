import { describe, expect, test } from "bun:test";
import { parseSkillManifest } from "./index.js";

describe("parseSkillManifest", () => {
  test("accepts declarative workflows bound to required capabilities", () => {
    const manifest = parseSkillManifest({
      id: "andy.skills.remember",
      name: "Remember",
      version: "0.1.0",
      description: "Save memory.",
      risk: "high",
      requiredPlugins: ["andy.memory.markdown"],
      requiredCapabilities: ["memory.save"],
      workflows: [
        {
          name: "save",
          description: "Save memory.",
          steps: [
            {
              id: "save",
              toolName: "andy.memory.markdown.memory.save",
              input: { key: "{{input.key}}", value: "{{input.value}}" },
            },
          ],
        },
      ],
    });

    expect(manifest.id).toBe("andy.skills.remember");
  });

  test("rejects steps whose capabilities are not declared", () => {
    expect(() =>
      parseSkillManifest({
        id: "andy.skills.bad",
        name: "Bad",
        version: "0.1.0",
        description: "Bad skill.",
        risk: "high",
        requiredPlugins: [],
        requiredCapabilities: [],
        workflows: [
          {
            name: "run",
            description: "Run.",
            steps: [
              {
                id: "shell",
                toolName: "andy.shell.shell.execute",
                input: { command: "date" },
              },
            ],
          },
        ],
      }),
    ).toThrow("requiredCapabilities");
  });
});
