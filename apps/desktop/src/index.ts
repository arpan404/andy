#!/usr/bin/env node
import { Effect } from "effect";
import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createConnection, type Socket } from "node:net";
import { homedir, platform } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = dirname(fileURLToPath(import.meta.url));

interface DesktopState {
  daemonPid?: number;
  webPid?: number;
  acpTransport: "socket" | "stdio";
  webUrl: string;
  home: string;
  startedAt: string;
}

interface ParsedArgs {
  command: string;
  rest: readonly string[];
  home?: string;
  webPort: number;
  open: boolean;
}

interface RuntimeLayout {
  mode: "release" | "workspace";
  root: string;
  binDir: string;
  webRoot: string;
  daemonCommand: {
    command: string;
    args: readonly string[];
    cwd: string;
  };
  desktopCommand: {
    command: string;
    args: readonly string[];
    cwd: string;
  };
}

class PersistentAcpClient {
  private socket: Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: { connected: true; result: unknown }) => void;
      reject: (error: unknown) => void;
    }
  >();
  private connecting: Promise<boolean> | undefined;

  constructor(private readonly socketPath: string) {}

  async request(
    request: Omit<Record<string, unknown>, "id">,
  ): Promise<{ connected: true; result: unknown } | { connected: false }> {
    const connected = await this.connect();
    if (!connected || !this.socket) {
      return { connected: false };
    }
    const id = this.nextId++;
    return await new Promise((resolveRequest, reject) => {
      this.pending.set(id, { resolve: resolveRequest, reject });
      this.socket?.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  }

  private async connect(): Promise<boolean> {
    if (this.socket && !this.socket.destroyed) {
      return true;
    }
    if (platform() !== "win32" && !existsSync(this.socketPath)) {
      return false;
    }
    if (this.connecting) {
      return await this.connecting;
    }
    this.connecting = new Promise((resolveConnect) => {
      const socket = createConnection(this.socketPath);
      const fail = () => {
        socket.destroy();
        this.socket = undefined;
        this.rejectPending(new Error("ACP socket disconnected."));
        resolveConnect(false);
      };
      socket.once("connect", () => {
        this.socket = socket;
        this.connecting = undefined;
        socket.on("data", (chunk: Buffer) => {
          this.handleData(chunk);
        });
        socket.once("error", fail);
        socket.once("end", fail);
        socket.once("close", () => {
          if (this.socket === socket) {
            this.socket = undefined;
          }
        });
        resolveConnect(true);
      });
      socket.once("error", () => {
        this.connecting = undefined;
        fail();
      });
    });
    return await this.connecting;
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }
      const { id, error, result } = parsed;
      if (typeof id !== "number") {
        continue;
      }
      const pending = this.pending.get(id);
      if (!pending) {
        continue;
      }
      this.pending.delete(id);
      if (isRecord(error)) {
        const { message } = error;
        pending.reject(
          new Error(typeof message === "string" ? message : JSON.stringify(error)),
        );
        continue;
      }
      pending.resolve({ connected: true, result: result ?? {} });
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

const parsed = parseArgs(process.argv.slice(2));

Effect.runPromise(
  Effect.fn("desktop.main")(function* () {
    switch (parsed.command) {
      case "start":
        return yield* startDesktop(parsed);
      case "stop":
        return yield* stopDesktop(parsed);
      case "restart":
        yield* stopDesktop(parsed).pipe(Effect.catchAll(() => Effect.void));
        return yield* startDesktop(parsed);
      case "status":
        return yield* printStatus(parsed);
      case "open":
        return yield* openConsole(parsed);
      case "serve-web":
        return yield* serveWeb(parsed);
      default:
        return yield* Effect.fail(
          new Error(
            `Unknown desktop command '${parsed.command}'. Use start, stop, restart, status, open, or serve-web.`,
          ),
        );
    }
  })(),
).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function startDesktop(args: ParsedArgs): Effect.Effect<void, unknown> {
  return Effect.fn("desktop.start")(function* () {
    const home = resolveHome(args.home);
    const layout = yield* detectRuntimeLayout();
    const statePath = desktopStatePath(home);
    const existing = yield* readDesktopState(statePath);
    if (existing && isRunning(existing.daemonPid) && isRunning(existing.webPid)) {
      yield* printJson({
        status: "running",
        home,
        acpTransport: existing.acpTransport ?? "socket",
        webUrl: existing.webUrl,
        daemonPid: existing.daemonPid,
        webPid: existing.webPid,
      });
      if (args.open) {
        yield* openUrl(existing.webUrl);
      }
      return;
    }

    yield* mkdirEffect(dirname(statePath));
    yield* mkdirEffect(join(home, ".andy", "logs"));

    const daemon = spawnDetached(
      layout.daemonCommand.command,
      layout.daemonCommand.args,
      {
        cwd: layout.daemonCommand.cwd,
        env: { ...process.env, ANDY_HOME: home },
        logPath: join(home, ".andy", "logs", "daemon.log"),
      },
    );
    const web = spawnDetached(
      layout.desktopCommand.command,
      [...layout.desktopCommand.args, "serve-web", "--web-port", String(args.webPort)],
      {
        cwd: layout.desktopCommand.cwd,
        env: { ...process.env, ANDY_HOME: home },
        logPath: join(home, ".andy", "logs", "web.log"),
      },
    );
    const state: DesktopState = {
      daemonPid: daemon.pid,
      webPid: web.pid,
      acpTransport: "socket",
      webUrl: `http://127.0.0.1:${String(args.webPort)}`,
      home,
      startedAt: new Date().toISOString(),
    };
    yield* writeText(statePath, `${JSON.stringify(state, null, 2)}\n`);
    if (args.open) {
      yield* openUrl(state.webUrl);
    }
    yield* printJson({ status: "started", ...state, layout: layout.mode });
  })();
}

function stopDesktop(args: ParsedArgs): Effect.Effect<void, unknown> {
  return Effect.fn("desktop.stop")(function* () {
    const home = resolveHome(args.home);
    const state = yield* readDesktopState(desktopStatePath(home));
    if (!state) {
      yield* printJson({ status: "stopped", home });
      return;
    }
    stopPid(state.webPid);
    stopPid(state.daemonPid);
    yield* printJson({
      status: "stopped",
      home,
      daemonPid: state.daemonPid ?? null,
      webPid: state.webPid ?? null,
    });
  })();
}

function printStatus(args: ParsedArgs): Effect.Effect<void, unknown> {
  return Effect.fn("desktop.status")(function* () {
    const home = resolveHome(args.home);
    const state = yield* readDesktopState(desktopStatePath(home));
    yield* printJson({
      status:
        state && isRunning(state.daemonPid) && isRunning(state.webPid)
          ? "running"
          : "stopped",
      home,
      acpTransport: state?.acpTransport ?? "stdio",
      webUrl: state?.webUrl ?? `http://127.0.0.1:${String(args.webPort)}`,
      daemonPid: state?.daemonPid ?? null,
      webPid: state?.webPid ?? null,
      daemonRunning: isRunning(state?.daemonPid),
      webRunning: isRunning(state?.webPid),
    });
  })();
}

function openConsole(args: ParsedArgs): Effect.Effect<void, unknown> {
  return Effect.fn("desktop.open")(function* () {
    const state = yield* readDesktopState(desktopStatePath(resolveHome(args.home)));
    yield* openUrl(state?.webUrl ?? `http://127.0.0.1:${String(args.webPort)}`);
  })();
}

function serveWeb(args: ParsedArgs): Effect.Effect<void, unknown> {
  return Effect.fn("desktop.serveWeb")(function* () {
    const layout = yield* detectRuntimeLayout();
    const home = resolveHome(args.home);
    const acpClient = new PersistentAcpClient(getAcpSocketPath(home));
    if (!existsSync(layout.webRoot)) {
      return yield* Effect.fail(
        new Error(
          `Web assets are missing at ${layout.webRoot}. Run bun run --filter @andy/web build.`,
        ),
      );
    }
    yield* Effect.async<void, unknown>((resume) => {
      const server = createServer((request, response) => {
        void (async () => {
          const url = new URL(
            request.url ?? "/",
            `http://127.0.0.1:${String(args.webPort)}`,
          );
          if (url.pathname === "/acp") {
            if (request.method !== "POST") {
              response.writeHead(405, { "content-type": "application/json" });
              response.end(JSON.stringify({ error: "method_not_allowed" }));
              return;
            }
            try {
              const body = await readRequestBody(request);
              const result = await runAcpBridge(layout, home, body, acpClient);
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
          const relativePath =
            url.pathname === "/" ? "index.html" : url.pathname.slice(1);
          const file = resolve(layout.webRoot, relativePath);
          if (!file.startsWith(resolve(layout.webRoot))) {
            response.writeHead(403, { "content-type": "text/plain" });
            response.end("Forbidden");
            return;
          }
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
      server.once("error", (error) => resume(Effect.fail(error)));
      server.listen(args.webPort, "127.0.0.1", () => {
        console.log(
          `Andy desktop web console listening on http://127.0.0.1:${String(args.webPort)}`,
        );
      });
    });
  })();
}

function detectRuntimeLayout(): Effect.Effect<RuntimeLayout, unknown> {
  return Effect.sync(() => {
    const binDir = dirname(process.execPath);
    const releaseRoot = resolve(binDir, "..");
    if (existsSync(join(releaseRoot, "release.json"))) {
      return {
        mode: "release" as const,
        root: releaseRoot,
        binDir,
        webRoot: join(releaseRoot, "web"),
        daemonCommand: {
          command: join(binDir, executableName("andy-daemon")),
          args: [],
          cwd: releaseRoot,
        },
        desktopCommand: {
          command: process.execPath,
          args: [],
          cwd: releaseRoot,
        },
      };
    }

    const workspaceRoot = findWorkspaceRoot(sourceDir);
    const webRoot = join(workspaceRoot, "apps", "web", "dist");
    return {
      mode: "workspace" as const,
      root: workspaceRoot,
      binDir: join(workspaceRoot, "dist"),
      webRoot,
      daemonCommand: {
        command: "bun",
        args: ["run", "--filter", "@andy/daemon", "dev"],
        cwd: workspaceRoot,
      },
      desktopCommand: {
        command: "bun",
        args: ["run", "--filter", "@andy/desktop", "dev"],
        cwd: workspaceRoot,
      },
    };
  });
}

function spawnDetached(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; logPath: string },
): { pid: number } {
  const output = openSync(options.logPath, "a");
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    detached: true,
    env: options.env,
    stdio: ["ignore", output, output],
  });
  child.unref();
  return { pid: child.pid ?? 0 };
}

function openUrl(url: string): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: () =>
      new Promise<void>((resolvePromise, reject) => {
        const currentPlatform = platform();
        const command =
          currentPlatform === "darwin"
            ? "open"
            : currentPlatform === "win32"
              ? "cmd"
              : "xdg-open";
        const args = currentPlatform === "win32" ? ["/c", "start", "", url] : [url];
        const child = spawn(command, args, { shell: false, stdio: "ignore" });
        child.once("error", reject);
        child.once("exit", (code) => {
          code === 0
            ? resolvePromise()
            : reject(new Error(`${command} exited ${String(code)}.`));
        });
      }),
    catch: (cause) => cause,
  });
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw.length > 0 ? JSON.parse(raw) : {};
}

async function runAcpBridge(
  layout: RuntimeLayout,
  home: string,
  request: unknown,
  acpClient?: PersistentAcpClient,
): Promise<unknown> {
  const payload = isRecord(request) ? request : {};
  const { method: methodValue, params } = payload;
  const method = typeof methodValue === "string" ? methodValue : "";
  if (!method.startsWith("andy.")) {
    throw new Error("ACP bridge method is required.");
  }
  const requestParams = isRecord(params) ? params : {};
  const acpPayload = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: requestParams,
  })}\n`;
  if (acpClient) {
    const persistentResult = await acpClient.request({
      jsonrpc: "2.0",
      method,
      params: requestParams,
    });
    if (persistentResult.connected) {
      return persistentResult.result;
    }
  } else {
    const socketResult = await tryAcpSocketRequest(
      getAcpSocketPath(home),
      acpPayload,
      1,
    );
    if (socketResult.connected) {
      return socketResult.result;
    }
  }
  const result = await spawnAndCollect(
    layout.daemonCommand.command,
    [...layout.daemonCommand.args, "--acp"],
    {
      cwd: layout.daemonCommand.cwd,
      env: { ...process.env, ANDY_HOME: home },
      stdin: acpPayload,
    },
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

function getAcpSocketPath(home: string): string {
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
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin: string;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
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
    child.stdin.end(options.stdin);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDesktopState(
  path: string,
): Effect.Effect<DesktopState | undefined, unknown> {
  return Effect.tryPromise({
    try: async () => {
      try {
        return JSON.parse(await readFile(path, "utf8")) as DesktopState;
      } catch {
        return undefined;
      }
    },
    catch: (cause) => cause,
  });
}

function mkdirEffect(path: string): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: () => mkdir(path, { recursive: true }).then(() => undefined),
    catch: (cause) => cause,
  });
}

function writeText(path: string, content: string): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: () => writeFile(path, content, "utf8"),
    catch: (cause) => cause,
  });
}

function parseArgs(input: readonly string[]): ParsedArgs {
  const rest: string[] = [];
  let home: string | undefined;
  let webPort = 8790;
  let open = true;
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (item === "--home") {
      const value = input[index + 1];
      if (!value) throw new Error("--home requires a value.");
      home = value;
      index += 1;
      continue;
    }
    if (item === "--web-port") {
      const value = Number(input[index + 1]);
      if (!Number.isFinite(value) || value <= 0)
        throw new Error("--web-port requires a positive number.");
      webPort = value;
      index += 1;
      continue;
    }
    if (item === "--no-open") {
      open = false;
      continue;
    }
    rest.push(item ?? "");
  }

  return {
    command: rest[0] ?? "start",
    rest: rest.slice(1),
    ...(home ? { home } : {}),
    webPort,
    open,
  };
}

function resolveHome(home: string | undefined): string {
  const { ANDY_HOME } = process.env;
  return resolve(home ?? ANDY_HOME ?? join(homedir(), ".andy-home"));
}

function desktopStatePath(home: string): string {
  return join(home, ".andy", "desktop.json");
}

function isRunning(pid: number | undefined): boolean {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopPid(pid: number | undefined): void {
  if (!isRunning(pid)) {
    return;
  }
  const runningPid = pid;
  if (!runningPid) {
    return;
  }
  try {
    process.kill(runningPid, "SIGTERM");
  } catch {
    // Process may have exited between status and stop.
  }
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

function findWorkspaceRoot(start: string): string {
  let current = resolve(start);
  while (current !== dirname(current)) {
    if (existsSync(join(current, "package.json")) && basename(current) === "andy") {
      return current;
    }
    current = dirname(current);
  }
  return resolve(sourceDir, "..", "..", "..");
}

function executableName(name: string): string {
  return platform() === "win32" ? `${name}.exe` : name;
}

function printJson(value: unknown): Effect.Effect<void> {
  return Effect.sync(() => {
    console.log(JSON.stringify(value, null, 2));
  });
}
