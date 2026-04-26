import type { AuditSink } from "@andy/audit";
import type { PolicyEngine } from "@andy/policy";
import { Effect } from "effect";
import { ApprovalManager } from "./approvals.js";
import { ApprovalResumeEngine } from "./approval-resume.js";
import { BackgroundJobScheduler } from "./background.js";
import { CommunicationBridge } from "./communication.js";
import { InMemoryEventBus } from "./events.js";
import { DefaultHostedPluginHostApi } from "./host-api-handler.js";
import { PluginLifecycleManager } from "./plugin-lifecycle.js";
import { SubprocessManifestPluginHost } from "./plugin-host.js";
import { AgentRuntime } from "./runtime.js";
import { InMemorySecretBroker } from "./secrets.js";
import type { CoreStateStore } from "./state.js";
import type { CoreStateStoreError } from "./errors.js";

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
  lifecycle: PluginLifecycleManager;
  saveState(): Effect.Effect<void, CoreStateStoreError>;
}

export function createAndyDaemon(options: {
  audit: AuditSink;
  policy: PolicyEngine;
  stateStore?: CoreStateStore;
}): Effect.Effect<AndyDaemonServices, CoreStateStoreError> {
  return Effect.fn("createAndyDaemon")(function* () {
    const stateStore = options.stateStore;
    const communication = new CommunicationBridge({ audit: options.audit });
    const approvals = new ApprovalManager({
      audit: options.audit,
      communication,
    });
    const approvalResume = new ApprovalResumeEngine({ approvals });
    const background = new BackgroundJobScheduler({ audit: options.audit });
    const runtime = new AgentRuntime({
      audit: options.audit,
      policy: options.policy,
      approvalManager: approvals,
      approvalResume,
    });
    const hostedPluginHostApi = new DefaultHostedPluginHostApi({ runtime });
    const lifecycle = new PluginLifecycleManager({
      audit: options.audit,
      runtime,
      host: new SubprocessManifestPluginHost({
        audit: options.audit,
        hostApiHandler: (request) => hostedPluginHostApi.call(request),
      }),
    });

    if (stateStore) {
      const snapshot = yield* stateStore.load();
      if (snapshot) {
        yield* approvals.hydrate(snapshot.approvals);
        yield* background.hydrate(snapshot.backgroundJobs);
      }
    }

    const services: AndyDaemonServices = {
      eventBus: new InMemoryEventBus(),
      audit: options.audit,
      policy: options.policy,
      runtime,
      communication,
      approvals,
      approvalResume,
      background,
      secrets: new InMemorySecretBroker({ audit: options.audit }),
      hostedPluginHostApi,
      lifecycle,
      saveState: () => {
        if (!stateStore) {
          return Effect.void;
        }

        return Effect.fn("AndyDaemon.saveState")(function* () {
          const backgroundJobs = yield* background.list();
          yield* stateStore.save({
            plugins: runtime.listPlugins(),
            sessions: [],
            approvals: approvals.list(),
            backgroundJobs,
          });
        })();
      },
    };
    return services;
  })();
}
