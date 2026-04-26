import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
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
              return Effect.succeed({});
            },
          }),
        ],
      }),
    ).toThrow("requests undeclared capability 'filesystem.write'");
  });

  test("rejects sensitive filesystem tools without declared sensitive roots", () => {
    expect(() =>
      definePlugin({
        id: "test.sensitive-plugin",
        name: "Sensitive Plugin",
        version: "0.1.0",
        capabilities: ["filesystem.read_sensitive"],
        tools: [
          defineTool({
            name: "filesystem.readSensitive",
            description: "Read sensitive files",
            capabilities: ["filesystem.read_sensitive"],
            risk: "critical",
            execute() {
              return Effect.succeed({});
            },
          }),
        ],
      }),
    ).toThrow("without declaring permissions.filesystem.sensitiveReadRoots");
  });

  test("accepts sensitive filesystem tools with explicit sensitive roots", () => {
    expect(() =>
      definePlugin({
        id: "test.sensitive-plugin",
        name: "Sensitive Plugin",
        version: "0.1.0",
        capabilities: ["filesystem.read_sensitive"],
        permissions: {
          filesystem: {
            sensitiveReadRoots: [
              {
                path: "~/Library/Application Support/ExampleApp",
                reason: "Read ExampleApp state after explicit user approval.",
                dataClasses: ["app_data"],
              },
            ],
          },
        },
        tools: [
          defineTool({
            name: "filesystem.readSensitive",
            description: "Read sensitive files",
            capabilities: ["filesystem.read_sensitive"],
            risk: "critical",
            execute() {
              return Effect.succeed({});
            },
          }),
        ],
      }),
    ).not.toThrow();
  });
});
