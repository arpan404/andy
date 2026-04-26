import type { AgentMessage, AgentSession } from "./types.js";

export function stringifyCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function appendMessage(
  session: AgentSession,
  message: AgentMessage,
): AgentSession {
  return {
    ...session,
    messages: [...session.messages, message],
    updatedAt: new Date(),
  };
}
