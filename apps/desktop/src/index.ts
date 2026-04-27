#!/usr/bin/env node
import { Effect } from "effect";
import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, platform } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = dirname(fileURLToPath(import.meta.url));

interface DesktopState {
  daemonPid?: number;
  webPid?: number;
  daemonUrl: string;
  webUrl: string;
  home: string;
  startedAt: string;
}

interface ParsedArgs {
  command: string;
  rest: readonly string[];
  home?: string;
  daemonUrl: string;
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
        daemonUrl: existing.daemonUrl,
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
      daemonUrl: args.daemonUrl,
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
      daemonUrl: state?.daemonUrl ?? args.daemonUrl,
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
  let daemonUrl = "http://127.0.0.1:8765";
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
    if (item === "--daemon-url") {
      const value = input[index + 1];
      if (!value) throw new Error("--daemon-url requires a value.");
      daemonUrl = value;
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
    daemonUrl,
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
