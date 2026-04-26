import type { AuditEvent, AuditSink } from "@andy/audit";
import type { PolicyEngine } from "@andy/policy";
import { Effect } from "effect";
import { ApprovalManager } from "./approvals.js";
import { ApprovalResumeEngine } from "./approval-resume.js";
import { BackgroundJobExecutor } from "./background-executor.js";
import { BackgroundJobScheduler } from "./background.js";
import { CancellationRegistry } from "./cancellation.js";
import { CommunicationBridge } from "./communication.js";
import { EventBusAuditSink, InMemoryEventBus } from "./events.js";
import { DefaultHostedPluginHostApi } from "./host-api-handler.js";
import { ModelProviderRegistry } from "./model-provider.js";
import { PluginLifecycleManager } from "./plugin-lifecycle.js";
import { SubprocessManifestPluginHost } from "./plugin-host.js";
import { AgentRuntime } from "./runtime.js";
import { InMemorySecretBroker } from "./secrets.js";
import { AgentSessionStore } from "./session-store.js";
import type { CoreStateStore } from "./state.js";
import type { CoreStateStoreError } from "./errors.js";
import { TraceManager } from "./tracing.js";

export interface AndyDaemonServices {
  eventBus: InMemoryEventBus;
  traces: TraceManager;
  sessions: AgentSessionStore;
  audit: AuditSink;
  policy: PolicyEngine;
  runtime: AgentRuntime;
  communication: CommunicationBridge;
  approvals: ApprovalManager;
  approvalResume: ApprovalResumeEngine;
  background: BackgroundJobScheduler;
  backgroundExecutor: BackgroundJobExecutor;
  cancellation: CancellationRegistry;
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
    const eventBus = new InMemoryEventBus();
    const audit = new TeeAuditSink([options.audit, new EventBusAuditSink(eventBus)]);
    const traces = new TraceManager({ eventBus });
    const sessions = new AgentSessionStore();
    const communication = new CommunicationBridge({ audit });
    const approvals = new ApprovalManager({
      audit,
      communication,
    });
    let runtime!: AgentRuntime;
    const approvalResume = new ApprovalResumeEngine({
      approvals,
      executor: (descriptor) =>
        runtime.executeTool(descriptor.toolName, descriptor.input, descriptor.context),
    });
    const background = new BackgroundJobScheduler({ audit });
    const cancellation = new CancellationRegistry();
    runtime = new AgentRuntime({
      audit,
      policy: options.policy,
      approvalManager: approvals,
      approvalResume,
      cancellation,
    });
    const hostedPluginHostApi = new DefaultHostedPluginHostApi({ runtime });
    const lifecycle = new PluginLifecycleManager({
      audit,
      runtime,
      host: new SubprocessManifestPluginHost({
        audit,
        hostApiHandler: (request) => hostedPluginHostApi.call(request),
      }),
    });

    if (stateStore) {
      const snapshot = yield* stateStore.load();
      if (snapshot) {
        yield* eventBus.hydrate(snapshot.events ?? []);
        yield* traces.hydrate(snapshot.auditTraces ?? []);
        yield* sessions.hydrate(snapshot.sessions ?? []);
        yield* approvals.hydrate(snapshot.approvals ?? []);
        yield* background.hydrate(snapshot.backgroundJobs ?? []);
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
          sessions: sessions.list(),
          approvals: approvals.list(),
          backgroundJobs,
          auditTraces: traces.list(),
          events: eventBus.replay(),
          approvalActions: approvalResume.listParkedDescriptors(),
        });
      })();
    };

    const backgroundExecutor = new BackgroundJobExecutor({
      audit,
      scheduler: background,
      runtime,
      saveState,
    });

    const services: AndyDaemonServices = {
      eventBus,
      traces,
      sessions,
      audit,
      policy: options.policy,
      runtime,
      communication,
      approvals,
      approvalResume,
      background,
      backgroundExecutor,
      cancellation,
      secrets: new InMemorySecretBroker({ audit }),
      hostedPluginHostApi,
      lifecycle,
      modelProviders: new ModelProviderRegistry(),
      saveState,
    };
    return services;
  })();
}

class TeeAuditSink implements AuditSink {
  readonly #sinks: readonly AuditSink[];

  constructor(sinks: readonly AuditSink[]) {
    this.#sinks = sinks;
  }

  record(event: AuditEvent): Effect.Effect<void> {
    return Effect.all(
      this.#sinks.map((sink) => sink.record(event)),
      {
        concurrency: this.#sinks.length,
        discard: true,
      },
    );
  }
}
