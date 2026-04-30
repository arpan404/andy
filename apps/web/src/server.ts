import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import { platform } from "node:os";
import { dirname, extname, join, resolve } from "node:path";

const root = new URL(".", import.meta.url).pathname;
const { ANDY_WEB_PORT } = process.env;
const port = Number(ANDY_WEB_PORT ?? 8790);
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/acp") {
      if (request.method !== "POST") {
        response.writeHead(405, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      try {
        const result = await runAcpBridge(await readRequestBody(request));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch (cause) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      }
      return;
    }
    const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = join(root, path);
    try {
      const content = await readFile(file);
      response.writeHead(200, { "content-type": contentType(file) });
      response.end(content);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
    }
  })();
});
server.listen(port, "127.0.0.1");

console.log(`Andy web console listening on http://127.0.0.1:${port}`);

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw.length > 0 ? JSON.parse(raw) : {};
}

async function runAcpBridge(request: unknown): Promise<unknown> {
  const payload = isRecord(request) ? request : {};
  const { method: methodValue, params } = payload;
  const method = typeof methodValue === "string" ? methodValue : "";
  if (!method.startsWith("andy.")) {
    throw new Error("ACP bridge method is required.");
  }
  const acpPayload = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: isRecord(params) ? params : {},
  })}\n`;
  const socketResult = await tryAcpSocketRequest(getAcpSocketPath(), acpPayload, 1);
  if (socketResult.connected) {
    return socketResult.result;
  }
  const result = await spawnAndCollect(
    "bun",
    ["run", "--filter", "@andy/daemon", "dev", "--acp"],
    acpPayload,
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `andy-daemon --acp exited ${result.exitCode}`);
  }
  const response = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .find((item) => {
      if (!isRecord(item)) {
        return false;
      }
      const { jsonrpc, id } = item;
      return jsonrpc === "2.0" && id === 1;
    });
  if (!isRecord(response)) {
    throw new Error("ACP bridge did not receive a daemon response.");
  }
  const { error, result: responseResult } = response;
  if (isRecord(error)) {
    const { message } = error;
    throw new Error(typeof message === "string" ? message : JSON.stringify(error));
  }
  return responseResult ?? {};
}

function getAcpSocketPath(): string {
  const { ANDY_HOME } = process.env;
  const home = resolve(ANDY_HOME ?? process.cwd());
  if (platform() === "win32") {
    return `\\\\.\\pipe\\andy-${home.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
  }
  return join(home, ".andy", "andy.sock");
}

async function tryAcpSocketRequest(
  socketPath: string,
  payload: string,
  id: number,
): Promise<{ connected: true; result: unknown } | { connected: false }> {
  if (platform() !== "win32" && !existsSync(socketPath)) {
    return { connected: false };
  }
  return await new Promise((resolveRequest, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        if (!settled) {
          settled = true;
          resolveRequest({ connected: false });
        }
        return;
      }
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const parsed = JSON.parse(trimmed) as unknown;
        if (!isRecord(parsed)) {
          continue;
        }
        const { id: responseId, error, result } = parsed;
        if (responseId !== id) {
          continue;
        }
        if (isRecord(error)) {
          const { message } = error;
          settled = true;
          socket.end();
          reject(
            new Error(typeof message === "string" ? message : JSON.stringify(error)),
          );
          return;
        }
        settled = true;
        socket.end();
        resolveRequest({ connected: true, result: result ?? {} });
        return;
      }
    });
    socket.once("connect", () => {
      socket.write(payload);
    });
    socket.once("end", () => {
      if (!settled) {
        settled = true;
        reject(new Error("ACP socket closed before returning a response."));
      }
    });
  });
}

async function spawnAndCollect(
  command: string,
  args: readonly string[],
  stdin: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], {
      cwd: findWorkspaceRoot(root),
      env: process.env,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolveResult({ exitCode: code ?? 1, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

function findWorkspaceRoot(start: string): string {
  let current = resolve(start);
  while (current !== dirname(current)) {
    if (current.endsWith("andy")) {
      return current;
    }
    current = dirname(current);
  }
  return resolve(root, "..", "..", "..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
