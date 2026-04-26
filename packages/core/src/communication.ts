import type { AuditSink } from "@andy/audit";
import type { JsonObject, JsonValue } from "@andy/types";
import { Effect } from "effect";
import {
  CommunicationChannelNotFoundError,
  type CommunicationSendError,
} from "./errors.js";

export type CommunicationMessageKind = "user" | "agent" | "system" | "approval";

export interface CommunicationMessage {
  id: string;
  channelId: string;
  conversationId: string;
  senderId: string;
  kind: CommunicationMessageKind;
  text: string;
  metadata: JsonObject;
  createdAt: Date;
}

export interface CommunicationSendInput {
  channelId: string;
  conversationId: string;
  kind: CommunicationMessageKind;
  text: string;
  metadata?: JsonObject;
}

export interface CommunicationChannel {
  id: string;
  pluginId: string;
  send(input: CommunicationSendInput): Effect.Effect<JsonValue, CommunicationSendError>;
}

export class CommunicationBridge {
  readonly #audit: AuditSink;
  readonly #channels = new Map<string, CommunicationChannel>();
  readonly #messages: CommunicationMessage[] = [];

  constructor(options: { audit: AuditSink }) {
    this.#audit = options.audit;
  }

  registerChannel(channel: CommunicationChannel): Effect.Effect<void> {
    const self = this;
    return Effect.fn("CommunicationBridge.registerChannel")(function* () {
      self.#channels.set(channel.id, channel);
      yield* self.#audit.record({
        type: "communication.channel.registered",
        channelId: channel.id,
        pluginId: channel.pluginId,
      });
    })();
  }

  publishInbound(
    input: Omit<CommunicationMessage, "id" | "createdAt">,
  ): Effect.Effect<CommunicationMessage> {
    const self = this;
    return Effect.fn("CommunicationBridge.publishInbound")(function* () {
      const message: CommunicationMessage = {
        ...input,
        id: crypto.randomUUID(),
        createdAt: new Date(),
      };
      self.#messages.push(message);
      yield* self.#audit.record({
        type: "communication.message.inbound",
        messageId: message.id,
        channelId: message.channelId,
        conversationId: message.conversationId,
      });
      return message;
    })();
  }

  send(
    input: CommunicationSendInput,
  ): Effect.Effect<
    CommunicationMessage,
    CommunicationChannelNotFoundError | CommunicationSendError
  > {
    const self = this;
    return Effect.fn("CommunicationBridge.send")(function* () {
      const channel = self.#channels.get(input.channelId);
      if (!channel) {
        return yield* Effect.fail(
          new CommunicationChannelNotFoundError({
            channelId: input.channelId,
            message: `Communication channel '${input.channelId}' is not registered.`,
          }),
        );
      }

      yield* channel.send(input);
      const message: CommunicationMessage = {
        id: crypto.randomUUID(),
        channelId: input.channelId,
        conversationId: input.conversationId,
        senderId: "andy",
        kind: input.kind,
        text: input.text,
        metadata: input.metadata ?? {},
        createdAt: new Date(),
      };
      self.#messages.push(message);
      yield* self.#audit.record({
        type: "communication.message.outbound",
        messageId: message.id,
        channelId: message.channelId,
        conversationId: message.conversationId,
      });
      return message;
    })();
  }

  requestApproval(input: {
    approvalId: string;
    channelId: string;
    conversationId: string;
    text: string;
    metadata?: JsonObject;
  }): Effect.Effect<
    CommunicationMessage,
    CommunicationChannelNotFoundError | CommunicationSendError
  > {
    const self = this;
    return Effect.fn("CommunicationBridge.requestApproval")(function* () {
      const message = yield* self.send({
        channelId: input.channelId,
        conversationId: input.conversationId,
        kind: "approval",
        text: input.text,
        metadata: {
          ...(input.metadata ?? {}),
          approvalId: input.approvalId,
        },
      });
      yield* self.#audit.record({
        type: "communication.approval.requested",
        approvalId: input.approvalId,
        channelId: input.channelId,
      });
      return message;
    })();
  }

  listMessages(): readonly CommunicationMessage[] {
    return [...this.#messages].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }
}
