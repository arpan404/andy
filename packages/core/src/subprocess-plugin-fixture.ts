import { createInterface } from "node:readline";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  WorkerPluginHostRequest,
  WorkerPluginHostResponse,
} from "./plugin-worker-protocol.js";
import { isJsonValue, type JsonValue } from "@andy/types";

const stdin = createInterface({ input: process.stdin });
const environment = process.env as {
  ANDY_PLUGIN_ID?: string;
  ANDY_PLUGIN_SANDBOX_ROOT?: string;
  ANDY_PLUGIN_STORAGE_ROOT?: string;
};

stdin.on("line", (line) => {
  const request = parseRequest(line);
  if (!request) {
    return;
  }

  if (request.toolName === "test.sandbox_echo") {
    const storageRoot = environment.ANDY_PLUGIN_STORAGE_ROOT ?? process.cwd();
    const filePath = join(storageRoot, "last-input.json");
    writeFileSync(filePath, JSON.stringify(request.input), "utf8");
    const saved = parseSaved(readFileSync(filePath, "utf8"));
    respond({
      type: "andy.tool.result",
      requestId: request.requestId,
      output: {
        pluginId: environment.ANDY_PLUGIN_ID ?? request.pluginId,
        cwd: process.cwd(),
        sandboxRoot: environment.ANDY_PLUGIN_SANDBOX_ROOT ?? "",
        storageRoot,
        saved,
      },
    });
    return;
  }

  respond({
    type: "andy.tool.error",
    requestId: request.requestId,
    message: `Unknown subprocess tool '${request.toolName}'.`,
  });
});

function parseRequest(line: string): WorkerPluginHostRequest | undefined {
  try {
    const parsed = JSON.parse(line) as WorkerPluginHostRequest;
    return parsed.type === "andy.tool.execute" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function respond(response: WorkerPluginHostResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function parseSaved(text: string): JsonValue {
  const parsed: unknown = JSON.parse(text);
  return isJsonValue(parsed) ? parsed : null;
}
