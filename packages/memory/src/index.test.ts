import { describe, expect, test } from "bun:test";
import realFs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import {
  InMemoryStore,
  MarkdownMemoryStore,
  SqliteStructuredMemoryStore,
} from "./index.js";

describe("InMemoryStore", () => {
  test("saves and fetches persistent memories", async () => {
    const store = new InMemoryStore();
    const saved = await Effect.runPromise(
      store.save({
        scope: "user",
        namespace: "preferences",
        key: "timezone",
        value: "America/Chicago",
        tags: ["profile"],
        trust: "trusted",
        source: "test",
      }),
    );

    await expect(Effect.runPromise(store.get(saved.id))).resolves.toMatchObject({
      key: "timezone",
      value: "America/Chicago",
    });
  });

  test("queries memory by tag and text", async () => {
    const store = new InMemoryStore();
    await Effect.runPromise(
      store.save({
        scope: "project",
        namespace: "andy",
        key: "architecture",
        value: "plugin-first runtime",
        tags: ["design"],
        source: "test",
      }),
    );

    const results = await Effect.runPromise(
      store.query({
        tags: ["design"],
        text: "plugin",
      }),
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.key).toBe("architecture");
  });

  test("forgets memories", async () => {
    const store = new InMemoryStore();
    const saved = await Effect.runPromise(
      store.save({
        scope: "session",
        namespace: "scratch",
        key: "temporary",
        value: true,
        source: "test",
      }),
    );

    await expect(Effect.runPromise(store.forget(saved.id))).resolves.toBe(true);
    await expect(Effect.runPromise(store.get(saved.id))).resolves.toBeUndefined();
  });
});

describe("MarkdownMemoryStore", () => {
  test("persists memory to a markdown file", async () => {
    const filePath = path.join(
      await realFs.mkdtemp(path.join("/tmp", "andy-memory-")),
      "memory.md",
    );
    const store = new MarkdownMemoryStore({ filePath });

    await Effect.runPromise(
      store.save({
        scope: "agent",
        namespace: "self",
        key: "style",
        value: "prefer concise answers",
        tags: ["behavior"],
        source: "test",
      }),
    );

    const contents = await realFs.readFile(filePath, "utf8");
    expect(contents).toContain("# Andy Memory");
    expect(contents).toContain("```andy-memory");
    expect(contents).toContain("prefer concise answers");

    const reloaded = new MarkdownMemoryStore({ filePath });
    const results = await Effect.runPromise(
      reloaded.query({
        scope: "agent",
        namespace: "self",
        key: "style",
      }),
    );

    expect(results[0]).toMatchObject({
      key: "style",
      value: "prefer concise answers",
    });
  });

  test("lets the agent query markdown-managed memory", async () => {
    const filePath = path.join(
      await realFs.mkdtemp(path.join("/tmp", "andy-memory-")),
      "memory.md",
    );
    const store = new MarkdownMemoryStore({ filePath });

    await Effect.runPromise(
      store.save({
        scope: "project",
        namespace: "andy",
        key: "default-memory-provider",
        value: "markdown",
        tags: ["memory"],
        source: "test",
      }),
    );

    const results = await Effect.runPromise(store.query({ text: "markdown" }));
    expect(results[0]?.key).toBe("default-memory-provider");
  });
});

describe("SqliteStructuredMemoryStore", () => {
  test("persists reviewable structured memory records", async () => {
    const dir = await realFs.mkdtemp(path.join("/tmp", "andy-structured-memory-"));
    const store = new SqliteStructuredMemoryStore({
      path: path.join(dir, "andy.sqlite"),
    });

    const saved = await Effect.runPromise(
      store.save({
        type: "preference",
        subject: "user.theme",
        content: "User prefers compact operational UI.",
        source: { channel: "test", sessionId: "session-1", toolId: "memory.save" },
        confidence: 0.8,
        sensitivity: "high",
      }),
    );
    expect(saved.visibility).toBe("user-review-required");

    const approved = await Effect.runPromise(store.approve(saved.id));
    expect(approved?.visibility).toBe("assistant");

    const reloaded = new SqliteStructuredMemoryStore({
      path: path.join(dir, "andy.sqlite"),
    });
    const records = await Effect.runPromise(
      reloaded.query({ visibility: "assistant", text: "compact" }),
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.subject).toBe("user.theme");
    expect(records[0]?.source.sessionId).toBe("session-1");
  });
});
