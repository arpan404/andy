import {
  optionalNumber,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonValue } from "@andy/types";
import { Effect } from "effect";
import { spawn } from "node:child_process";
import { platform } from "node:os";

const computerControlEnv = process.env as {
  ANDY_ENABLE_COMPUTER_CONTROL?: string;
};
const enabled = computerControlEnv.ANDY_ENABLE_COMPUTER_CONTROL === "1";

startWorkerPlugin((request) =>
  Effect.fn("computer-control.handleRequest")(function* () {
    switch (request.toolName) {
      case "computer.click":
        return yield* gated(() => click(request.input));
      case "computer.type":
        return yield* gated(() => typeText(request.input));
      case "computer.key":
        return yield* gated(() => key(request.input));
      case "computer.window.list":
        return yield* windowList();
      default:
        return yield* Effect.fail(
          new Error(`Unknown computer-control tool '${request.toolName}'.`),
        );
    }
  })(),
);

function gated(run: () => Effect.Effect<JsonValue, unknown>) {
  if (!enabled) {
    return Effect.fail(
      new Error(
        "Computer control is disabled. Set ANDY_ENABLE_COMPUTER_CONTROL=1 after policy approval.",
      ),
    );
  }
  return run();
}

function click(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  const parsed = requireObject(input, "computer.click");
  const x = optionalNumber(parsed, "x");
  const y = optionalNumber(parsed, "y");
  if (x === undefined || y === undefined) {
    return Effect.fail(new Error("computer.click requires x and y."));
  }
  return currentAdapter().click(Math.round(x), Math.round(y));
}

function typeText(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  const parsed = requireObject(input, "computer.type");
  const text = requireString(parsed, "text");
  return currentAdapter().typeText(text);
}

function key(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  const parsed = requireObject(input, "computer.key");
  const value = requireString(parsed, "key");
  return currentAdapter().key(value);
}

function windowList(): Effect.Effect<JsonValue, unknown> {
  return currentAdapter().windowList();
}

interface ComputerControlAdapter {
  platform: string;
  click(x: number, y: number): Effect.Effect<JsonValue, unknown>;
  typeText(text: string): Effect.Effect<JsonValue, unknown>;
  key(value: string): Effect.Effect<JsonValue, unknown>;
  windowList(): Effect.Effect<JsonValue, unknown>;
}

function currentAdapter(): ComputerControlAdapter {
  const currentPlatform = platform();
  if (currentPlatform === "darwin") return macosAdapter;
  if (currentPlatform === "linux") return linuxAdapter;
  if (currentPlatform === "win32") return windowsAdapter;
  return unsupportedAdapter(currentPlatform);
}

const macosAdapter: ComputerControlAdapter = {
  platform: "darwin",
  click: (x, y) =>
    osascript([
      `tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}`,
    ]).pipe(Effect.map(() => ({ clicked: true, x, y, platform: "darwin" }))),
  typeText: (text) =>
    osascript([
      'tell application "System Events"',
      `keystroke ${JSON.stringify(text)}`,
      "end tell",
    ]).pipe(
      Effect.map(() => ({ typed: true, characters: text.length, platform: "darwin" })),
    ),
  key: (value) => {
    const keyCode = macosKeyCodeFor(value);
    const script = keyCode
      ? [`key code ${keyCode}`]
      : [
          `keystroke ${JSON.stringify(value.length === 1 ? value : value.toLowerCase())}`,
        ];
    return osascript(['tell application "System Events"', ...script, "end tell"]).pipe(
      Effect.map(() => ({
        pressed: true,
        key: value,
        mode: keyCode ? "keyCode" : "keystroke",
        platform: "darwin",
      })),
    );
  },
  windowList: () =>
    osascript([
      'tell application "System Events"',
      "set appNames to name of every process whose background only is false",
      "return appNames as string",
      "end tell",
    ]).pipe(
      Effect.map((output) => ({
        platform: "darwin",
        applications: output
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      })),
    ),
};

const linuxAdapter: ComputerControlAdapter = {
  platform: "linux",
  click: (x, y) =>
    runCommand("xdotool", ["mousemove", String(x), String(y), "click", "1"]).pipe(
      Effect.map(() => ({
        clicked: true,
        x,
        y,
        platform: "linux",
        backend: "xdotool",
      })),
    ),
  typeText: (text) =>
    runCommand("xdotool", ["type", "--clearmodifiers", text]).pipe(
      Effect.map(() => ({
        typed: true,
        characters: text.length,
        platform: "linux",
        backend: "xdotool",
      })),
    ),
  key: (value) =>
    runCommand("xdotool", ["key", linuxKeyName(value)]).pipe(
      Effect.map(() => ({
        pressed: true,
        key: value,
        platform: "linux",
        backend: "xdotool",
      })),
    ),
  windowList: () =>
    runCommand("wmctrl", ["-l"]).pipe(
      Effect.map((output) => ({
        platform: "linux",
        backend: "wmctrl",
        windows: output
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      })),
    ),
};

const windowsAdapter: ComputerControlAdapter = {
  platform: "win32",
  click: (x, y) =>
    powershell(`
if (-not ("Andy.Mouse" -as [type])) {
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace Andy {
  public static class Mouse {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extraInfo);
  }
}
'@
}
[Andy.Mouse]::SetCursorPos(${x}, ${y}) | Out-Null
[Andy.Mouse]::mouse_event(0x0002, 0, 0, 0, 0)
[Andy.Mouse]::mouse_event(0x0004, 0, 0, 0, 0)
`).pipe(Effect.map(() => ({ clicked: true, x, y, platform: "win32" }))),
  typeText: (text) =>
    powershell(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(text)})
`).pipe(
      Effect.map(() => ({ typed: true, characters: text.length, platform: "win32" })),
    ),
  key: (value) =>
    powershell(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(windowsKeyName(value))})
`).pipe(Effect.map(() => ({ pressed: true, key: value, platform: "win32" }))),
  windowList: () =>
    powershell(
      "Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -ExpandProperty MainWindowTitle",
    ).pipe(
      Effect.map((output) => ({
        platform: "win32",
        windows: output
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      })),
    ),
};

function unsupportedAdapter(currentPlatform: string): ComputerControlAdapter {
  const unsupported = () =>
    Effect.fail(
      new Error(`Computer control is not supported on platform '${currentPlatform}'.`),
    );
  return {
    platform: currentPlatform,
    click: unsupported,
    typeText: unsupported,
    key: unsupported,
    windowList: unsupported,
  };
}

function osascript(lines: string[]): Effect.Effect<string, unknown> {
  return Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(
          "osascript",
          lines.flatMap((line) => ["-e", line]),
          {
            shell: false,
          },
        );
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
          code === 0 ? resolve(stdout) : reject(new Error(stderr));
        });
      }),
    catch: (cause) => cause,
  });
}

function runCommand(
  command: string,
  args: readonly string[],
): Effect.Effect<string, unknown> {
  return Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(command, [...args], { shell: false });
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`${command} timed out.`));
        }, 30_000);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          code === 0
            ? resolve(stdout)
            : reject(new Error(stderr || `${command} exited ${code}.`));
        });
      }),
    catch: (cause) => cause,
  });
}

function powershell(script: string): Effect.Effect<string, unknown> {
  return runCommand("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
}

function macosKeyCodeFor(value: string): number | undefined {
  const keyCodes: Record<string, number> = {
    return: 36,
    enter: 36,
    tab: 48,
    space: 49,
    delete: 51,
    escape: 53,
    esc: 53,
    command: 55,
    shift: 56,
    capslock: 57,
    option: 58,
    control: 59,
    left: 123,
    right: 124,
    down: 125,
    up: 126,
  };
  return keyCodes[value.toLowerCase()];
}

function linuxKeyName(value: string): string {
  const keys: Record<string, string> = {
    return: "Return",
    enter: "Return",
    escape: "Escape",
    esc: "Escape",
    delete: "BackSpace",
    backspace: "BackSpace",
    space: "space",
    tab: "Tab",
    left: "Left",
    right: "Right",
    up: "Up",
    down: "Down",
  };
  return keys[value.toLowerCase()] ?? value;
}

function windowsKeyName(value: string): string {
  const keys: Record<string, string> = {
    return: "{ENTER}",
    enter: "{ENTER}",
    escape: "{ESC}",
    esc: "{ESC}",
    delete: "{DEL}",
    backspace: "{BACKSPACE}",
    tab: "{TAB}",
    left: "{LEFT}",
    right: "{RIGHT}",
    up: "{UP}",
    down: "{DOWN}",
  };
  return keys[value.toLowerCase()] ?? value;
}
