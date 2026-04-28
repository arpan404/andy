import {
  optionalString,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonObject, JsonValue } from "@andy/types";
import { Effect } from "effect";
import { createHmac, timingSafeEqual } from "node:crypto";

const whatsappEnv = process.env as {
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
};
const token = whatsappEnv.WHATSAPP_ACCESS_TOKEN;
const phoneNumberId = whatsappEnv.WHATSAPP_PHONE_NUMBER_ID;

startWorkerPlugin((request) =>
  Effect.fn("whatsapp.handleRequest")(function* () {
    switch (request.toolName) {
      case "whatsapp.sendMessage":
        return yield* sendMessage(request.input);
      case "whatsapp.normalizeWebhook":
        return normalizeWebhook(request.input);
      case "whatsapp.verifyWebhook":
        return verifyWebhook(request.input);
      default:
        return yield* Effect.fail(
          new Error(`Unknown whatsapp tool '${request.toolName}'.`),
        );
    }
  })(),
);

function sendMessage(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("whatsapp.sendMessage")(function* () {
    const parsed = requireObject(input, "whatsapp.sendMessage");
    const to = requireString(parsed, "to");
    const text = requireString(parsed, "text");
    return yield* graphApi({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: text },
    });
  })();
}

function verifyWebhook(input: JsonValue): JsonValue {
  const parsed = requireObject(input, "whatsapp.verifyWebhook");
  const rawBody = optionalString(parsed, "rawBody");
  const signature = optionalString(parsed, "signature");
  if (rawBody && signature) {
    return {
      verified: verifySignature(rawBody, signature),
      challenge: optionalString(parsed, "challenge") ?? null,
      mode: "signature",
    };
  }
  const mode = optionalString(parsed, "mode");
  const tokenInput = optionalString(parsed, "verifyToken");
  const challenge = optionalString(parsed, "challenge");
  const expected = whatsappEnv.WHATSAPP_VERIFY_TOKEN;
  return {
    verified: Boolean(mode === "subscribe" && expected && tokenInput === expected),
    challenge: challenge ?? null,
  };
}

function verifySignature(rawBody: string, signature: string): boolean {
  const secret = whatsappEnv.WHATSAPP_APP_SECRET;
  if (!secret) {
    return false;
  }
  const expected = `sha256=${createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  return (
    expectedBuffer.length === signatureBuffer.length &&
    timingSafeEqual(expectedBuffer, signatureBuffer)
  );
}

function normalizeWebhook(input: JsonValue): JsonValue {
  const parsed = requireObject(input, "whatsapp.normalizeWebhook");
  const webhook = parsed as { payload?: JsonValue };
  const messages = extractMessages(webhook.payload);
  return { provider: "whatsapp", messages };
}

function graphApi(body: JsonObject): Effect.Effect<JsonValue, unknown> {
  return Effect.tryPromise({
    try: async () => {
      if (!token || !phoneNumberId) {
        throw new Error(
          "WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required.",
        );
      }
      const response = await fetch(
        `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      const json = (await response.json()) as JsonValue;
      if (!response.ok) {
        throw new Error(`WhatsApp Graph API failed: ${JSON.stringify(json)}`);
      }
      return json;
    },
    catch: (cause) => cause,
  });
}

function extractMessages(payload: JsonValue | undefined): JsonObject[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return [];
  }
  const payloadRecord: { entry?: unknown } =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as { entry?: unknown })
      : {};
  const entries = Array.isArray(payloadRecord.entry) ? payloadRecord.entry : [];
  const normalized: JsonObject[] = [];
  for (const entry of entries) {
    const changes =
      typeof entry === "object" && entry !== null && "changes" in entry
        ? (entry as { changes?: unknown }).changes
        : undefined;
    if (!Array.isArray(changes)) {
      continue;
    }
    for (const change of changes) {
      const value =
        typeof change === "object" && change !== null && "value" in change
          ? (change as { value?: unknown }).value
          : undefined;
      if (typeof value !== "object" || value === null) {
        continue;
      }
      const messages = Array.isArray((value as { messages?: unknown }).messages)
        ? (value as { messages: unknown[] }).messages
        : [];
      for (const message of messages) {
        const record = message as {
          from?: unknown;
          id?: unknown;
          text?: { body?: unknown };
        };
        const text = record.text;
        if (typeof record.from !== "string" || typeof text?.body !== "string") {
          continue;
        }
        normalized.push({
          provider: "whatsapp",
          channelId: "whatsapp",
          conversationId: record.from,
          senderId: record.from,
          text: text.body,
          messageId: typeof record.id === "string" ? record.id : null,
          provenance: messagingProvenance({
            provider: "whatsapp",
            conversationId: record.from,
            messageId: typeof record.id === "string" ? record.id : record.from,
          }),
          metadata: message as JsonValue,
        });
      }
    }
  }
  return normalized;
}

function messagingProvenance(input: {
  provider: string;
  conversationId: string;
  messageId: string;
}): JsonValue {
  return [
    {
      sourceId: `${input.provider}:${input.conversationId}:${input.messageId}`,
      sourceType: "messaging",
      trust: "untrusted",
      domain: input.provider,
    },
  ];
}
