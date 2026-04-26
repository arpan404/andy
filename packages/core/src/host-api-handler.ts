import type { JsonValue } from "@andy/types";
import { Effect } from "effect";
import type { AgentRuntime } from "./runtime.js";
import type { HostedPluginHostApiHandler } from "./plugin-host.js";
import type { WorkerPluginHostApiRequest } from "./plugin-worker-protocol.js";
import type { AgentRuntimeError } from "./errors.js";

export interface HostedPluginHostApiOptions {
  runtime: AgentRuntime;
}

export class DefaultHostedPluginHostApi {
  readonly #runtime: AgentRuntime;

  constructor(options: HostedPluginHostApiOptions) {
    this.#runtime = options.runtime;
  }

  handler(): HostedPluginHostApiHandler {
    return (request) => this.call(request);
  }

  call(
    request: WorkerPluginHostApiRequest,
  ): Effect.Effect<JsonValue, AgentRuntimeError> {
    const self = this;
    return Effect.fn("DefaultHostedPluginHostApi.call")(function* () {
      const result = yield* self.#runtime.executeTool(request.toolName, request.input);
      return result.output;
    })();
  }
}
