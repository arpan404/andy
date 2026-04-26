import { isJsonValue, type JsonValue } from "@andy/types";
import { Effect } from "effect";
import { createInterface } from "node:readline";

export type WorkerPluginHostRequest = {
  type: "andy.tool.execute";
  requestId: string;
  pluginId: string;
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

export type WorkerToolHandler = (
  request: WorkerPluginHostRequest,
) => Effect.Effect<JsonValue, unknown>;

export function startWorkerPlugin(handler: WorkerToolHandler): void {
  const stdin = createInterface({ input: process.stdin });
  stdin.on("line", (line) => {
    const request = parseRequest(line);
    if (!request) {
      return;
    }

    Effect.runPromise(
      handler(request).pipe(
        Effect.match({
          onFailure: (error) =>
            respond({
              type: "andy.tool.error",
              requestId: request.requestId,
              message: error instanceof Error ? error.message : String(error),
              cause: stringifyCause(error),
            }),
          onSuccess: (output) =>
            respond({
              type: "andy.tool.result",
              requestId: request.requestId,
              output,
            }),
        }),
      ),
    );
  });
}

export function parseRequest(line: string): WorkerPluginHostRequest | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isWorkerPluginHostRequest(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function requireObject(input: JsonValue, toolName: string) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${toolName} input must be an object.`);
  }
  return input as Record<string, JsonValue | undefined>;
}

export function requireString(
  input: Record<string, JsonValue | undefined>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string '${key}'.`);
  }
  return value;
}

export function optionalString(
  input: Record<string, JsonValue | undefined>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalBoolean(
  input: Record<string, JsonValue | undefined>,
  key: string,
): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

export function optionalNumber(
  input: Record<string, JsonValue | undefined>,
  key: string,
): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function optionalStringArray(
  input: Record<string, JsonValue | undefined>,
  key: string,
): string[] | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Expected string array '${key}'.`);
  }
  return [...value];
}

export function respond(response: WorkerPluginHostResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

export function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.stack ?? cause.message;
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

function isWorkerPluginHostRequest(value: unknown): value is WorkerPluginHostRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<WorkerPluginHostRequest>;
  return (
    record.type === "andy.tool.execute" &&
    typeof record.requestId === "string" &&
    typeof record.pluginId === "string" &&
    typeof record.toolName === "string" &&
    isJsonValue(record.input)
  );
}
