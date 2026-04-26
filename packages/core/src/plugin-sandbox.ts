import { Effect } from "effect";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { RealFileSystem, type AgentFileSystem } from "@andy/vfs";
import { PluginSandboxError } from "./errors.js";
import { stringifyCause } from "./utils.js";

export interface PluginSandbox {
  pluginId: string;
  root: string;
  scratchRoot: string;
  storageRoot: string;
  scratchFs: AgentFileSystem;
  storageFs: AgentFileSystem;
  dispose(): Effect.Effect<void, PluginSandboxError>;
}

export interface PluginSandboxOptions {
  pluginId: string;
  baseDir?: string;
  keepAfterStop?: boolean;
}

export class PluginSandboxFactory {
  create(
    options: PluginSandboxOptions,
  ): Effect.Effect<PluginSandbox, PluginSandboxError> {
    return Effect.fn("PluginSandboxFactory.create")(() =>
      Effect.tryPromise({
        try: async () => {
          const baseDir = resolve(options.baseDir ?? tmpdir());
          const root = await mkdtemp(join(baseDir, `andy-plugin-${options.pluginId}-`));
          const scratchRoot = join(root, "scratch");
          const storageRoot = join(root, "storage");
          await mkdir(scratchRoot, { recursive: true });
          await mkdir(storageRoot, { recursive: true });

          return {
            pluginId: options.pluginId,
            root,
            scratchRoot,
            storageRoot,
            scratchFs: new RealFileSystem({ root: scratchRoot }),
            storageFs: new RealFileSystem({ root: storageRoot }),
            dispose: () =>
              options.keepAfterStop
                ? Effect.void
                : Effect.tryPromise({
                    try: () => rm(root, { force: true, recursive: true }),
                    catch: (cause) =>
                      new PluginSandboxError({
                        pluginId: options.pluginId,
                        root,
                        message: `Failed to remove plugin sandbox '${root}'.`,
                        cause: stringifyCause(cause),
                      }),
                  }),
          };
        },
        catch: (cause) =>
          new PluginSandboxError({
            pluginId: options.pluginId,
            root: options.baseDir ?? tmpdir(),
            message: `Failed to create sandbox for plugin '${options.pluginId}'.`,
            cause: stringifyCause(cause),
          }),
      }),
    )();
  }
}

export type ProcessIsolationKind =
  | "process-boundary"
  | "macos-sandbox-exec"
  | "container";

export interface ProcessIsolationProfile {
  kind: ProcessIsolationKind;
  allowNetwork?: boolean;
  containerImage?: string;
  containerRuntime?: "docker" | "podman";
}

export interface ProcessLaunchCommand {
  command: string;
  args: readonly string[];
}

export function buildSandboxedLaunchCommand(options: {
  bunExecutable: string;
  entry: string;
  profile: ProcessIsolationProfile;
  sandbox: PluginSandbox;
}): Effect.Effect<ProcessLaunchCommand, PluginSandboxError> {
  return Effect.fn("buildSandboxedLaunchCommand")(function* () {
    if (options.profile.kind === "process-boundary") {
      return {
        command: options.bunExecutable,
        args: [options.entry],
      };
    }

    if (options.profile.kind === "macos-sandbox-exec") {
      const profilePath = join(options.sandbox.root, "sandbox.sb");
      yield* Effect.tryPromise({
        try: () =>
          writeFile(
            profilePath,
            createMacOsSandboxProfile({
              allowNetwork: options.profile.allowNetwork ?? false,
              sandbox: options.sandbox,
            }),
            "utf8",
          ),
        catch: (cause) =>
          new PluginSandboxError({
            pluginId: options.sandbox.pluginId,
            root: options.sandbox.root,
            message: `Failed to write macOS sandbox profile for plugin '${options.sandbox.pluginId}'.`,
            cause: stringifyCause(cause),
          }),
      });
      return {
        command: "sandbox-exec",
        args: ["-f", profilePath, options.bunExecutable, options.entry],
      };
    }

    return {
      command: options.profile.containerRuntime ?? "docker",
      args: [
        "run",
        "--rm",
        "--network",
        options.profile.allowNetwork ? "bridge" : "none",
        "--read-only",
        "--tmpfs",
        "/tmp",
        "-v",
        `${options.sandbox.storageRoot}:/andy/storage:rw`,
        "-v",
        `${options.sandbox.scratchRoot}:/andy/scratch:rw`,
        options.profile.containerImage ?? "oven/bun:latest",
        "bun",
        options.entry,
      ],
    };
  })();
}

export function checkProcessIsolationAvailability(
  profile: ProcessIsolationProfile,
): Effect.Effect<boolean> {
  return Effect.fn("checkProcessIsolationAvailability")(() =>
    Effect.sync(() => {
      if (profile.kind === "process-boundary") {
        return true;
      }

      if (profile.kind === "macos-sandbox-exec") {
        return commandExists("sandbox-exec");
      }

      return commandExists(profile.containerRuntime ?? "docker");
    }),
  )();
}

function createMacOsSandboxProfile(options: {
  allowNetwork: boolean;
  sandbox: PluginSandbox;
}): string {
  const networkRule = options.allowNetwork ? "(allow network*)" : "(deny network*)";
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    '(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/System") (subpath "/Library") (subpath "/opt") (literal "/dev/null") (literal "/dev/urandom"))',
    `(allow file-read* file-write* (subpath "${escapeSandboxPath(options.sandbox.root)}"))`,
    networkRule,
    "",
  ].join("\n");
}

function escapeSandboxPath(filePath: string): string {
  return filePath.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
  });
  return result.status === 0 || result.signal === null;
}
