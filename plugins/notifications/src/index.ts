import {
  optionalString,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonValue } from "@andy/types";
import { Effect } from "effect";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    return { ...record, sent: true, delivery: "plugin-storage" };
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
    return { ...record, sent: true, approveCommand: `/approve ${approvalId}` };
  })();
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

function isNotificationRecord(value: unknown): value is NotificationRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<NotificationRecord>;
  return typeof record.id === "string" && typeof record.text === "string";
}
