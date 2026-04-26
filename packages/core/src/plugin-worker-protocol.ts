import type { JsonValue } from "@andy/types";

export type WorkerPluginHostRequest = {
  type: "andy.tool.execute";
  requestId: string;
  pluginId: string;
  toolName: string;
  input: JsonValue;
};

export type WorkerPluginHostApiRequest = {
  type: "andy.host_api.call";
  requestId: string;
  pluginId: string;
  capability: string;
  toolName: string;
  input: JsonValue;
};

export type WorkerPluginHostResponse =
  | {
      type: "andy.tool.result";
      requestId: string;
      output: JsonValue;
    }
  | {
      type: "andy.tool.error";
      requestId: string;
      message: string;
      cause?: string;
    };

export type WorkerPluginHostApiResponse =
  | {
      type: "andy.host_api.result";
      requestId: string;
      output: JsonValue;
    }
  | {
      type: "andy.host_api.error";
      requestId: string;
      message: string;
      cause?: string;
    };

export type WorkerPluginMessage =
  | WorkerPluginHostRequest
  | WorkerPluginHostResponse
  | WorkerPluginHostApiRequest
  | WorkerPluginHostApiResponse;

export function isWorkerPluginHostResponse(
  message: unknown,
): message is WorkerPluginHostResponse {
  if (typeof message !== "object" || message === null || !("type" in message)) {
    return false;
  }

  return message.type === "andy.tool.result" || message.type === "andy.tool.error";
}

export function isWorkerPluginHostApiRequest(
  message: unknown,
): message is WorkerPluginHostApiRequest {
  if (typeof message !== "object" || message === null || !("type" in message)) {
    return false;
  }

  return message.type === "andy.host_api.call";
}
