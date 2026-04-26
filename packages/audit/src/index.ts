import { Effect } from "effect";

export interface AuditEventMetadata {
  traceId?: string | undefined;
  sessionId?: string | undefined;
  agentId?: string | undefined;
  taskId?: string | undefined;
  progress?: unknown;
}

export type AuditEvent = AuditEventMetadata &
  (
    | {
        type: "plugin.registered";
        pluginId: string;
        toolCount: number;
      }
    | {
        type: "plugin.enabled" | "plugin.disabled" | "plugin.removed";
        pluginId: string;
      }
    | {
        type: "plugin.install.requested" | "plugin.install.completed";
        pluginId: string;
        source: string;
      }
    | {
        type: "plugin.host.started" | "plugin.host.stopped";
        pluginId: string;
        executionMode: string;
      }
    | {
        type: "plugin.lifecycle.started" | "plugin.lifecycle.stopped";
        pluginId: string;
        executionMode: string;
      }
    | {
        type: "plugin.host.tool_requested" | "plugin.host.tool_completed";
        pluginId: string;
        toolName: string;
        requestId: string;
      }
    | {
        type: "plugin.host_api.requested";
        pluginId: string;
        runId: string;
        capability: string;
        toolName: string;
      }
    | {
        type: "agent.session.started" | "agent.session.completed";
        sessionId: string;
        agentId: string;
      }
    | {
        type: "agent.session.cancelled";
        sessionId: string;
        agentId: string;
        reason: string;
      }
    | {
        type: "agent.stream.started" | "agent.stream.completed";
        sessionId: string;
        agentId: string;
      }
    | {
        type: "agent.tool.requested";
        sessionId: string;
        agentId: string;
        toolName: string;
      }
    | {
        type: "swarm.child.started";
        swarmId: string;
        parentSessionId: string;
        childSessionId: string;
        role: string;
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
        type: "approval.requested";
        approvalId: string;
        runId: string;
        toolName: string;
        reason: string;
      }
    | {
        type: "approval.resolved";
        approvalId: string;
        decision: "approved" | "denied" | "expired";
      }
    | {
        type: "approval.expired";
        approvalId: string;
        runId: string;
        toolName: string;
      }
    | {
        type: "communication.channel.registered";
        channelId: string;
        pluginId: string;
      }
    | {
        type: "communication.message.inbound" | "communication.message.outbound";
        messageId: string;
        channelId: string;
        conversationId: string;
      }
    | {
        type: "communication.approval.requested";
        approvalId: string;
        channelId: string;
      }
    | {
        type: "background.job.created" | "background.job.updated";
        jobId: string;
        status: string;
      }
    | {
        type: "background.job.progress";
        jobId: string;
        progress: unknown;
      }
    | {
        type: "secret.requested" | "secret.rotated";
        pluginId: string;
        scope: string;
      }
    | {
        type: "tool.completed";
        runId: string;
        toolName: string;
      }
  );

export interface AuditSink {
  record(event: AuditEvent): Effect.Effect<void>;
}

export class ConsoleAuditSink implements AuditSink {
  record(event: AuditEvent): Effect.Effect<void> {
    return Effect.sync(() => {
      const auditEnvKey = "ANDY_AUDIT";
      if (process.env[auditEnvKey] !== "1") {
        return;
      }

      console.error(JSON.stringify({ ts: new Date().toISOString(), ...event }));
    });
  }
}
