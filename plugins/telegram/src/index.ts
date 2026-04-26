import {
  optionalNumber,
  optionalString,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonObject, JsonValue } from "@andy/types";
import { Effect } from "effect";

const telegramEnv = process.env as { TELEGRAM_BOT_TOKEN?: string };
const token = telegramEnv.TELEGRAM_BOT_TOKEN;

startWorkerPlugin((request) =>
  Effect.fn("telegram.handleRequest")(function* () {
    switch (request.toolName) {
      case "telegram.listen":
        return yield* listen(request.input);
      case "telegram.sendMessage":
        return yield* sendMessage(request.input);
      case "telegram.setWebhook":
        return yield* setWebhook(request.input);
      case "telegram.normalizeUpdate":
        return normalizeUpdate(request.input);
      default:
        return yield* Effect.fail(
          new Error(`Unknown telegram tool '${request.toolName}'.`),
        );
    }
  })(),
);

function listen(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("telegram.listen")(function* () {
    const parsed = requireObject(input, "telegram.listen");
    const offset = optionalNumber(parsed, "offset");
    const timeout = optionalNumber(parsed, "timeout") ?? 0;
    const limit = optionalNumber(parsed, "limit") ?? 25;
    const response = yield* telegramApi("getUpdates", {
      ...(offset ? { offset } : {}),
      timeout,
      limit,
      allowed_updates: ["message", "edited_message", "callback_query"],
    });
    const responseRecord: { result?: unknown } =
      typeof response === "object" && response !== null && !Array.isArray(response)
        ? (response as { result?: unknown })
        : {};
    const updates = Array.isArray(responseRecord.result) ? responseRecord.result : [];
    return {
      updates,
      messages: updates.flatMap((update) => {
        const normalized = normalizeTelegramUpdate(update);
        return normalized ? [normalized] : [];
      }),
      nextOffset:
        updates.length > 0
          ? Math.max(...updates.map((item) => updateIdOf(item))) + 1
          : (offset ?? null),
    };
  })();
}

function sendMessage(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("telegram.sendMessage")(function* () {
    const parsed = requireObject(input, "telegram.sendMessage");
    const body: {
      chat_id: string;
      text: string;
      parse_mode?: string;
      reply_to_message_id?: string;
    } = {
      chat_id: requireString(parsed, "chatId"),
      text: requireString(parsed, "text"),
    };
    const parseMode = optionalString(parsed, "parseMode");
    const replyToMessageId = optionalString(parsed, "replyToMessageId");
    if (parseMode) {
      body.parse_mode = parseMode;
    }
    if (replyToMessageId) {
      body.reply_to_message_id = replyToMessageId;
    }
    return yield* telegramApi("sendMessage", body);
  })();
}

function setWebhook(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("telegram.setWebhook")(function* () {
    const parsed = requireObject(input, "telegram.setWebhook");
    const body: { url: string; secret_token?: string } = {
      url: requireString(parsed, "url"),
    };
    const secretToken = optionalString(parsed, "secretToken");
    if (secretToken) {
      body.secret_token = secretToken;
    }
    return yield* telegramApi("setWebhook", body);
  })();
}

function normalizeUpdate(input: JsonValue): JsonValue {
  const normalized = normalizeTelegramUpdate(input);
  if (!normalized) {
    throw new Error("Unsupported Telegram update shape.");
  }
  return normalized;
}

function telegramApi(
  method: string,
  body: JsonObject,
): Effect.Effect<JsonValue, unknown> {
  return Effect.tryPromise({
    try: async () => {
      if (!token) {
        throw new Error("TELEGRAM_BOT_TOKEN is required.");
      }
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await response.json()) as JsonValue;
      if (!response.ok) {
        throw new Error(`Telegram API ${method} failed: ${JSON.stringify(json)}`);
      }
      return json;
    },
    catch: (cause) => cause,
  });
}

function normalizeTelegramUpdate(update: unknown): JsonObject | undefined {
  if (typeof update !== "object" || update === null) {
    return undefined;
  }
  const record = update as {
    update_id?: unknown;
    message?: unknown;
    edited_message?: unknown;
  };
  const message = (record.message ?? record.edited_message) as
    | {
        message_id?: unknown;
        chat?: unknown;
        from?: unknown;
        text?: unknown;
      }
    | undefined;
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const chat = message.chat as { id?: unknown } | undefined;
  const from = message.from as { id?: unknown } | undefined;
  const text = typeof message.text === "string" ? message.text : "";
  if (!chat || !text) {
    return undefined;
  }
  return {
    provider: "telegram",
    updateId: typeof record.update_id === "number" ? record.update_id : null,
    messageId: typeof message.message_id === "number" ? message.message_id : null,
    channelId: "telegram",
    conversationId: String(chat.id),
    senderId: from?.id !== undefined ? String(from.id) : String(chat.id),
    text,
    metadata: update as JsonValue,
  };
}

function updateIdOf(item: unknown): number {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return 0;
  }
  const update = item as { update_id?: unknown };
  return typeof update.update_id === "number" ? update.update_id : 0;
}
