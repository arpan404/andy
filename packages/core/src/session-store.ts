import { Effect } from "effect";
import type { AgentSession } from "./types.js";

export class AgentSessionStore {
  readonly #sessions = new Map<string, AgentSession>();

  upsert(session: AgentSession): Effect.Effect<AgentSession> {
    return Effect.sync(() => {
      const normalized = normalizeSessionDates(session);
      this.#sessions.set(normalized.id, normalized);
      return normalized;
    });
  }

  get(sessionId: string): AgentSession | undefined {
    return this.#sessions.get(sessionId);
  }

  list(): readonly AgentSession[] {
    return [...this.#sessions.values()].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }

  hydrate(sessions: readonly AgentSession[]): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#sessions.clear();
      for (const session of sessions) {
        const normalized = normalizeSessionDates(session);
        this.#sessions.set(normalized.id, normalized);
      }
    });
  }
}

export function normalizeSessionDates(session: AgentSession): AgentSession {
  return {
    ...session,
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
  };
}
