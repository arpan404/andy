import { describe, expect, test } from "bun:test";
import { definePlugin, defineTool } from "./index.js";

describe("definePlugin", () => {
  test("rejects tools that request undeclared capabilities", () => {
    expect(() =>
      definePlugin({
        id: "test.plugin",
        name: "Test Plugin",
        version: "0.1.0",
        capabilities: ["filesystem.read"],
        tools: [
          defineTool({
            name: "filesystem.write",
            description: "Write a file",
            capabilities: ["filesystem.write"],
            risk: "high",
            execute() {
              return {};
            },
          }),
        ],
      }),
    ).toThrow("requests undeclared capability 'filesystem.write'");
  });
});
