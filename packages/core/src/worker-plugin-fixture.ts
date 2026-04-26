import type {
  WorkerPluginHostApiResponse,
  WorkerPluginHostRequest,
  WorkerPluginMessage,
} from "./plugin-worker-protocol.js";

declare const self: {
  postMessage(message: WorkerPluginMessage): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

const pendingHostApiCalls = new Map<string, WorkerPluginHostRequest>();

self.onmessage = (event: { data: unknown }) => {
  const message = event.data as WorkerPluginHostRequest | WorkerPluginHostApiResponse;
  if (
    message.type === "andy.host_api.result" ||
    message.type === "andy.host_api.error"
  ) {
    const originalRequest = pendingHostApiCalls.get(message.requestId);
    if (!originalRequest) {
      return;
    }
    pendingHostApiCalls.delete(message.requestId);
    self.postMessage({
      type: "andy.tool.result",
      requestId: originalRequest.requestId,
      output:
        message.type === "andy.host_api.result"
          ? { hostApi: message.output }
          : { hostApiError: message.message },
    });
    return;
  }

  const request = message;
  if (request.type !== "andy.tool.execute") {
    return;
  }

  if (request.toolName === "test.echo") {
    self.postMessage({
      type: "andy.tool.result",
      requestId: request.requestId,
      output: {
        pluginId: request.pluginId,
        input: request.input,
      },
    });
    return;
  }

  if (request.toolName === "test.host_api") {
    const hostApiRequestId = crypto.randomUUID();
    pendingHostApiCalls.set(hostApiRequestId, request);
    self.postMessage({
      type: "andy.host_api.call",
      requestId: hostApiRequestId,
      pluginId: request.pluginId,
      capability: "memory.save",
      toolName: "memory.save",
      input: request.input,
    });
    return;
  }

  self.postMessage({
    type: "andy.tool.error",
    requestId: request.requestId,
    message: `Unknown worker tool '${request.toolName}'.`,
  });
};
