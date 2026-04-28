import {
  optionalNumber,
  optionalString,
  optionalStringArray,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonObject, JsonValue } from "@andy/types";
import { Effect } from "effect";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

interface McpServerInput {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
}

startWorkerPlugin((request) =>
  Effect.fn("mcpClient.handleRequest")(function* () {
    switch (request.toolName) {
      case "mcp.list_tools":
        return yield* listTools(request.input);
      case "mcp.call_tool":
        return yield* callTool(request.input);
      default:
        return yield* Effect.fail(
          new Error(`Unknown MCP client tool '${request.toolName}'.`),
        );
    }
  })(),
);

function listTools(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return withMcpClient(input, (client) =>
    Effect.gen(function* () {
      const result = yield* client.request("tools/list", {});
      return isJsonObject(result) ? result : { result };
    }),
  );
}

function callTool(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return withMcpClient(input, (client, parsed) =>
    Effect.gen(function* () {
      const toolName = requireString(parsed, "toolName");
      const { input: toolInput = {} } = parsed;
      const result = yield* client.request("tools/call", {
        name: toolName,
        arguments: toolInput,
      });
      return isJsonObject(result) ? result : { result };
    }),
  );
}

function withMcpClient(
  input: JsonValue,
  use: (
    client: StdioMcpClient,
    parsed: Record<string, JsonValue | undefined>,
  ) => Effect.Effect<JsonValue, unknown>,
): Effect.Effect<JsonValue, unknown> {
  return Effect.gen(function* () {
    const parsed = requireObject(input, "mcp");
    const server = parseServerInput(parsed);
    const client = new StdioMcpClient(server);
    yield* client.start();
    try {
      yield* client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "andy.mcp.client",
          version: "0.1.0",
        },
      });
      yield* client.notify("notifications/initialized", {});
      return yield* use(client, parsed);
    } finally {
      client.stop();
    }
  });
}

function parseServerInput(
  parsed: Record<string, JsonValue | undefined>,
): McpServerInput {
  const command = requireString(parsed, "command");
  const args = optionalStringArray(parsed, "args") ?? [];
  const cwd = optionalString(parsed, "cwd");
  const timeoutMs = optionalNumber(parsed, "timeoutMs") ?? 30_000;
  return {
    command,
    args,
    ...(cwd ? { cwd } : {}),
    timeoutMs,
  };
}

class StdioMcpClient {
  readonly #server: McpServerInput;
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    {
      resolve(value: JsonValue): void;
      reject(cause: unknown): void;
      timeout: Timer;
    }
  >();

  constructor(server: McpServerInput) {
    this.#server = server;
  }

  start(): Effect.Effect<void, unknown> {
    return Effect.try({
      try: () => {
        const child = spawn(this.#server.command, this.#server.args, {
          cwd: this.#server.cwd,
          env: process.env,
          shell: false,
        });
        this.#child = child;
        const stdout = createInterface({ input: child.stdout });
        stdout.on("line", (line) => {
          this.#handleLine(line);
        });
        child.once("exit", (code) => {
          this.#rejectAll(
            new Error(`MCP server exited with code ${String(code ?? 1)}.`),
          );
        });
        child.once("error", (error) => {
          this.#rejectAll(error);
        });
      },
      catch: (cause) => cause,
    });
  }

  request(method: string, params: JsonObject): Effect.Effect<JsonValue, unknown> {
    return Effect.tryPromise({
      try: () =>
        new Promise<JsonValue>((resolve, reject) => {
          const child = this.#child;
          if (!child) {
            reject(new Error("MCP server is not running."));
            return;
          }
          const id = this.#nextId++;
          const timeout = setTimeout(() => {
            this.#pending.delete(id);
            reject(new Error(`MCP request '${method}' timed out.`));
          }, this.#server.timeoutMs);
          this.#pending.set(id, { resolve, reject, timeout });
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
          );
        }),
      catch: (cause) => cause,
    });
  }

  notify(method: string, params: JsonObject): Effect.Effect<void, unknown> {
    return Effect.try({
      try: () => {
        if (!this.#child) {
          throw new Error("MCP server is not running.");
        }
        this.#child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
        );
      },
      catch: (cause) => cause,
    });
  }

  stop(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
    }
    this.#pending.clear();
    this.#child?.kill();
    this.#child = undefined;
  }

  #handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isJsonObject(parsed)) {
      return;
    }
    const { id } = parsed;
    if (typeof id !== "number") {
      return;
    }
    const pending = this.#pending.get(id);
    if (!pending) {
      return;
    }
    this.#pending.delete(id);
    clearTimeout(pending.timeout);
    const { error } = parsed;
    if (error !== undefined) {
      pending.reject(new Error(JSON.stringify(error)));
      return;
    }
    const { result } = parsed;
    pending.resolve(isJsonValue(result) ? result : {});
  }

  #rejectAll(cause: unknown): void {
    for (const [id, pending] of this.#pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(cause);
      this.#pending.delete(id);
    }
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every(isJsonValue)) ||
    (isJsonObject(value) &&
      Object.values(value as Record<string, unknown>).every(isJsonValue))
  );
}
