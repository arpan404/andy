import type { AuditSink } from "@andy/audit";
import type { PolicyEngine } from "@andy/policy";
import { Effect } from "effect";
import { ApprovalManager } from "./approvals.js";
import { ApprovalResumeEngine } from "./approval-resume.js";
import { BackgroundJobScheduler } from "./background.js";
import { CommunicationBridge } from "./communication.js";
import { InMemoryEventBus } from "./events.js";
import { DefaultHostedPluginHostApi } from "./host-api-handler.js";
import { AgentRuntime } from "./runtime.js";
import { InMemorySecretBroker } from "./secrets.js";

export interface AndyDaemonServices {
  eventBus: InMemoryEventBus;
  audit: AuditSink;
  policy: PolicyEngine;
  runtime: AgentRuntime;
  communication: CommunicationBridge;
  approvals: ApprovalManager;
  approvalResume: ApprovalResumeEngine;
  background: BackgroundJobScheduler;
  secrets: InMemorySecretBroker;
  hostedPluginHostApi: DefaultHostedPluginHostApi;
}

export function createAndyDaemon(options: {
  audit: AuditSink;
  policy: PolicyEngine;
}): Effect.Effect<AndyDaemonServices> {
  return Effect.fn("createAndyDaemon")(() =>
    Effect.sync(() => {
      const communication = new CommunicationBridge({ audit: options.audit });
      const approvals = new ApprovalManager({
        audit: options.audit,
        communication,
      });
      const runtime = new AgentRuntime({
        audit: options.audit,
        policy: options.policy,
        approvalManager: approvals,
      });
      const services: AndyDaemonServices = {
        eventBus: new InMemoryEventBus(),
        audit: options.audit,
        policy: options.policy,
        runtime,
        communication,
        approvals,
        approvalResume: new ApprovalResumeEngine({ approvals }),
        background: new BackgroundJobScheduler({ audit: options.audit }),
        secrets: new InMemorySecretBroker({ audit: options.audit }),
        hostedPluginHostApi: new DefaultHostedPluginHostApi({ runtime }),
      };
      return services;
    }),
  )();
}
