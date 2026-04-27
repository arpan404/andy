import {
  optionalString,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonValue } from "@andy/types";
import { Effect } from "effect";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

type NotificationRecord = {
  id: string;
  kind: "notification" | "approval_request";
  title: string;
  text: string;
  channel: string;
  urgency: string;
  approvalId?: string;
  createdAt: string;
};

const environment = process.env as {
  ANDY_PLUGIN_STORAGE_ROOT?: string;
};

const storageRoot = environment.ANDY_PLUGIN_STORAGE_ROOT ?? process.cwd();
const notificationsPath = join(storageRoot, "notifications.json");

startWorkerPlugin((request) =>
  Effect.fn("notifications.handleRequest")(function* () {
    switch (request.toolName) {
      case "notification.send":
        return yield* sendNotification(request.input);
      case "notification.approval_request":
        return yield* createApprovalNotification(request.input);
      default:
        return yield* Effect.fail(
          new Error(`Unknown notifications tool '${request.toolName}'.`),
        );
    }
  })(),
);

function sendNotification(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("notifications.send")(function* () {
    const parsed = requireObject(input, "notification.send");
    const text = requireString(parsed, "text");
    const title = optionalString(parsed, "title") ?? "Andy";
    const record = yield* appendNotification({
      kind: "notification",
      title,
      text,
      channel: optionalString(parsed, "channel") ?? "local",
      urgency: optionalString(parsed, "urgency") ?? "normal",
    });
    const delivery = yield* dispatchLocalNotification(record);
    return { ...record, sent: true, delivery };
  })();
}

function createApprovalNotification(
  input: JsonValue,
): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("notifications.approvalRequest")(function* () {
    const parsed = requireObject(input, "notification.approval_request");
    const approvalId = requireString(parsed, "approvalId");
    const toolName = optionalString(parsed, "toolName") ?? "tool";
    const text =
      optionalString(parsed, "text") ??
      `Approval required for ${toolName}. Use /approve ${approvalId} or /deny ${approvalId}.`;
    const record = yield* appendNotification({
      kind: "approval_request",
      title: optionalString(parsed, "title") ?? "Approval required",
      text,
      channel: optionalString(parsed, "channel") ?? "local",
      urgency: "high",
      approvalId,
    });
    const delivery = yield* dispatchLocalNotification(record);
    return {
      ...record,
      sent: true,
      delivery,
      approveCommand: `/approve ${approvalId}`,
    };
  })();
}

function dispatchLocalNotification(
  notification: NotificationRecord,
): Effect.Effect<string, never> {
  if (notification.channel !== "local" || platform() !== "darwin") {
    return Effect.succeed("plugin-storage");
  }
  return osascript([
    `display notification ${JSON.stringify(notification.text)} with title ${JSON.stringify(notification.title)}`,
  ]).pipe(
    Effect.as("macos-notification"),
    Effect.catchAll(() => Effect.succeed("plugin-storage")),
  );
}

function appendNotification(
  input: Omit<NotificationRecord, "id" | "createdAt">,
): Effect.Effect<NotificationRecord, unknown> {
  return Effect.fn("notifications.append")(function* () {
    const existing = yield* loadNotifications();
    const record: NotificationRecord = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    existing.push(record);
    yield* saveNotifications(existing);
    return record;
  })();
}

function loadNotifications(): Effect.Effect<NotificationRecord[], unknown> {
  return Effect.tryPromise(async () => {
    try {
      const raw = await readFile(notificationsPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isNotificationRecord) : [];
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  });
}

function saveNotifications(
  notifications: readonly NotificationRecord[],
): Effect.Effect<void, unknown> {
  return Effect.tryPromise(async () => {
    await mkdir(storageRoot, { recursive: true });
    await writeFile(
      notificationsPath,
      `${JSON.stringify(notifications, null, 2)}\n`,
      "utf8",
    );
  });
}

function osascript(lines: string[]): Effect.Effect<string, unknown> {
  return Effect.tryPromise({
    try: () =>
      new Promise<string>((resolveOutput, reject) => {
        const child = spawn(
          "osascript",
          lines.flatMap((line) => ["-e", line]),
          { shell: false },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          code === 0 ? resolveOutput(stdout) : reject(new Error(stderr));
        });
      }),
    catch: (cause) => cause,
  });
}

function isNotificationRecord(value: unknown): value is NotificationRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<NotificationRecord>;
  return typeof record.id === "string" && typeof record.text === "string";
}
