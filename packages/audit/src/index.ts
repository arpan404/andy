import { Effect } from "effect";

export type AuditEvent =
  | {
      type: "plugin.registered";
      pluginId: string;
      toolCount: number;
    }
  | {
      type: "tool.requested";
      runId: string;
      toolName: string;
    }
  | {
      type: "policy.decision";
      runId: string;
      toolName: string;
      decision: "allow" | "deny" | "ask";
      reason?: string;
    }
  | {
      type: "tool.completed";
      runId: string;
      toolName: string;
    };

export interface AuditSink {
  record(event: AuditEvent): Effect.Effect<void>;
}

export class ConsoleAuditSink implements AuditSink {
  record(event: AuditEvent): Effect.Effect<void> {
    return Effect.sync(() => {
      if (process.env.ANDY_AUDIT !== "1") {
        return;
      }

      console.error(JSON.stringify({ ts: new Date().toISOString(), ...event }));
    });
  }
}
