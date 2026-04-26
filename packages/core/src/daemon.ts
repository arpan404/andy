import type { AuditSink } from "@andy/audit";
import type { PolicyEngine } from "@andy/policy";
import { Effect } from "effect";
import { ApprovalManager } from "./approvals.js";
import { ApprovalResumeEngine } from "./approval-resume.js";
import { BackgroundJobExecutor } from "./background-executor.js";
import { BackgroundJobScheduler } from "./background.js";
import { CommunicationBridge } from "./communication.js";
import { InMemoryEventBus } from "./events.js";
import { DefaultHostedPluginHostApi } from "./host-api-handler.js";
import { ModelProviderRegistry } from "./model-provider.js";
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
  backgroundExecutor: BackgroundJobExecutor;
  secrets: InMemorySecretBroker;
  hostedPluginHostApi: DefaultHostedPluginHostApi;
  lifecycle: PluginLifecycleManager;
  modelProviders: ModelProviderRegistry;
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
    let runtime!: AgentRuntime;
    const approvalResume = new ApprovalResumeEngine({
      approvals,
      executor: (descriptor) =>
        runtime.executeTool(descriptor.toolName, descriptor.input, descriptor.context),
    });
    const background = new BackgroundJobScheduler({ audit: options.audit });
    runtime = new AgentRuntime({
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
        for (const action of snapshot.approvalActions ?? []) {
          yield* approvalResume.parkDescriptor(action.approval, action.descriptor);
        }
      }
    }

    const saveState = (): Effect.Effect<void, CoreStateStoreError> => {
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
          approvalActions: approvalResume.listParkedDescriptors(),
        });
      })();
    };

    const backgroundExecutor = new BackgroundJobExecutor({
      audit: options.audit,
      scheduler: background,
      runtime,
      saveState,
    });

    const services: AndyDaemonServices = {
      eventBus: new InMemoryEventBus(),
      audit: options.audit,
      policy: options.policy,
      runtime,
      communication,
      approvals,
      approvalResume,
      background,
      backgroundExecutor,
      secrets: new InMemorySecretBroker({ audit: options.audit }),
      hostedPluginHostApi,
      lifecycle,
      modelProviders: new ModelProviderRegistry(),
      saveState,
    };
    return services;
  })();
}
