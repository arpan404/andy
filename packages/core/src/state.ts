import type { PluginRuntimeRecord } from "./runtime.js";
import type { AgentSession } from "./types.js";
import type { ApprovalRequest } from "./approvals.js";
import type { BackgroundJob } from "./background.js";
import { Effect } from "effect";

export interface CoreStateSnapshot {
  plugins: readonly PluginRuntimeRecord[];
  sessions: readonly AgentSession[];
  approvals: readonly ApprovalRequest[];
  backgroundJobs: readonly BackgroundJob[];
}

export interface CoreStateStore {
  save(snapshot: CoreStateSnapshot): Effect.Effect<void>;
  load(): Effect.Effect<CoreStateSnapshot | undefined>;
}

export class InMemoryCoreStateStore implements CoreStateStore {
  #snapshot: CoreStateSnapshot | undefined;

  save(snapshot: CoreStateSnapshot): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#snapshot = snapshot;
    });
  }

  load(): Effect.Effect<CoreStateSnapshot | undefined> {
    return Effect.succeed(this.#snapshot);
  }
}
