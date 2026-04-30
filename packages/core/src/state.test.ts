import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import { SqliteCoreStateStore, type CoreStateSnapshot } from "./state.js";

describe("SqliteCoreStateStore", () => {
  test("persists core state domains and queryable rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "andy-sqlite-state-"));
    const path = join(dir, "andy.sqlite");
    const store = new SqliteCoreStateStore(path);
    const snapshot: CoreStateSnapshot = {
      plugins: [],
      sessions: [
        {
          id: "session-1",
          agentId: "agent",
          role: "assistant",
          messages: [
            {
              role: "user",
              content: "hello",
            },
          ],
          depth: 0,
          createdAt: new Date("2026-04-28T00:00:00.000Z"),
          updatedAt: new Date("2026-04-28T00:00:01.000Z"),
        },
      ],
      approvals: [
        {
          id: "approval-1",
          runId: "run-1",
          toolName: "andy.shell.shell.execute",
          input: {},
          status: "pending",
          reason: "test",
          createdAt: new Date("2026-04-28T00:00:00.000Z"),
        },
      ],
      backgroundJobs: [],
      events: [
        {
          sequence: 1,
          event: {
            type: "tool.completed",
            runId: "run-1",
            toolName: "andy.shell.shell.execute",
          },
          publishedAt: new Date("2026-04-28T00:00:00.000Z"),
        },
      ],
      auditTraces: [],
    };

    await Effect.runPromise(store.save(snapshot));
    const loaded = await Effect.runPromise(store.load());
    expect(loaded?.sessions).toHaveLength(1);
    expect(loaded?.approvals).toHaveLength(1);
    expect(loaded?.events).toHaveLength(1);

    const db = new Database(path, { readonly: true });
    try {
      const sessionCount = db.query("SELECT count(*) AS count FROM sessions").get() as {
        count: number;
      };
      const messageCount = db
        .query("SELECT count(*) AS count FROM session_messages")
        .get() as { count: number };
      const approvalCount = db
        .query("SELECT count(*) AS count FROM approvals")
        .get() as { count: number };
      expect(sessionCount.count).toBe(1);
      expect(messageCount.count).toBe(1);
      expect(approvalCount.count).toBe(1);
    } finally {
      db.close();
    }
  });
});
