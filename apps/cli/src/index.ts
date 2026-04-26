#!/usr/bin/env node
import { ConsoleAuditSink } from "@andy/audit";
import { AgentRuntime } from "@andy/core";
import { definePlugin, defineTool } from "@andy/plugin-sdk";
import { CapabilityPolicy } from "@andy/policy";
import { getJsonObjectProperty, isJsonObject, type JsonValue } from "@andy/types";
import { Effect } from "effect";

type HttpMethod = "GET" | "POST";

interface ParsedArgs {
  command: string | undefined;
  rest: string[];
  url: string;
  enable: boolean;
  manifestPath?: string;
}

const corePlugin = definePlugin({
  id: "andy.core",
  name: "Andy Core Tools",
  version: "0.1.0",
  capabilities: ["agent.respond"],
  tools: [
    defineTool({
      name: "agent.respond",
      description: "Return a direct response through the plugin execution path.",
      capabilities: ["agent.respond"],
      risk: "low",
      execute(input: { message: string }, context) {
        return Effect.gen(function* () {
          yield* context.scratchFs.writeFile("last-message.txt", input.message.trim());
          return {
            message:
              input.message.trim().length > 0
                ? `Andy plugin runtime received: ${input.message}`
                : "Andy plugin runtime is ready.",
          };
        });
      },
    }),
  ],
});

const parsed = parseArgs(process.argv.slice(2));

if (parsed.command === "status") {
  await printDaemonJson(parsed.url, "GET", "/status");
} else if (parsed.command === "plugin" || parsed.command === "plugins") {
  await runPluginCommand(parsed);
} else if (parsed.command === "approval" || parsed.command === "approvals") {
  await runApprovalCommand(parsed);
} else if (parsed.command === "help" || parsed.command === "--help") {
  printHelp();
} else {
  await runLegacySmoke(process.argv.slice(2).join(" "));
}

async function runPluginCommand(args: ParsedArgs): Promise<void> {
  const [action, ...rest] = args.rest;
  if (!action || action === "list") {
    await printDaemonJson(args.url, "GET", "/plugins");
    return;
  }

  if (action === "install-local") {
    const [manifestPath] = rest;
    if (!manifestPath) {
      throw new Error("Usage: andy plugin install-local <manifestPath> [--enable]");
    }
    await printDaemonJson(args.url, "POST", "/plugins/install-local", {
      manifestPath,
      enabled: args.enable,
    });
    return;
  }

  if (action === "install-github") {
    const [repository, ref] = rest;
    if (!repository || !ref) {
      throw new Error(
        "Usage: andy plugin install-github <repository-url> <commit-or-version-tag> [--manifest plugin.json] [--enable]",
      );
    }
    await printDaemonJson(args.url, "POST", "/plugins/install-github", {
      repository,
      ref,
      ...(args.manifestPath ? { manifestPath: args.manifestPath } : {}),
      enabled: args.enable,
    });
    return;
  }

  if (action === "enable" || action === "disable" || action === "remove") {
    const [pluginId] = rest;
    if (!pluginId) {
      throw new Error(`Usage: andy plugin ${action} <pluginId>`);
    }
    await printDaemonJson(args.url, "POST", `/plugins/${pluginId}/${action}`);
    return;
  }

  if (action === "restart-crashed") {
    await printDaemonJson(args.url, "POST", "/plugins/restart-crashed");
    return;
  }

  throw new Error(`Unknown plugin command '${action}'.`);
}

async function runApprovalCommand(args: ParsedArgs): Promise<void> {
  const [action, approvalId] = args.rest;
  if (!action || action === "list") {
    await printDaemonJson(args.url, "GET", "/approvals");
    return;
  }

  if (action === "approve" || action === "deny") {
    if (!approvalId) {
      throw new Error(`Usage: andy approval ${action} <approvalId>`);
    }
    await printDaemonJson(args.url, "POST", `/approvals/${approvalId}/${action}`);
    return;
  }

  throw new Error(`Unknown approval command '${action}'.`);
}

async function printDaemonJson(
  baseUrl: string,
  method: HttpMethod,
  path: string,
  body?: JsonValue,
): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const text = await response.text();
  const parsedBody = parseJsonResponse(text);
  if (!response.ok) {
    throw new Error(
      `Daemon request failed with ${response.status}: ${JSON.stringify(parsedBody)}`,
    );
  }
  console.log(JSON.stringify(parsedBody, null, 2));
}

function parseArgs(input: string[]): ParsedArgs {
  const { ANDY_DAEMON_URL } = process.env;
  let url = ANDY_DAEMON_URL ?? "http://127.0.0.1:8765";
  let enable = false;
  let manifestPath: string | undefined;
  const positional: string[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (arg === "--url") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--url requires a value.");
      }
      url = trimTrailingSlash(value);
      index += 1;
      continue;
    }
    if (arg === "--enable") {
      enable = true;
      continue;
    }
    if (arg === "--manifest") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--manifest requires a value.");
      }
      manifestPath = value;
      index += 1;
      continue;
    }
    if (arg) {
      positional.push(arg);
    }
  }

  const [command, ...rest] = positional;
  return {
    command,
    rest,
    url: trimTrailingSlash(url),
    enable,
    ...(manifestPath ? { manifestPath } : {}),
  };
}

function parseJsonResponse(text: string): JsonValue {
  if (text.trim().length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(text);
  return isJsonValue(parsed) ? parsed : { value: String(parsed) };
}

function isJsonValue(value: unknown): value is JsonValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every(isJsonValue)) ||
    (typeof value === "object" &&
      value !== null &&
      Object.values(value).every(isJsonValue))
  );
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function printHelp(): void {
  console.log(`Andy CLI

Usage:
  andy status [--url http://127.0.0.1:8765]
  andy plugin list
  andy plugin install-local <manifestPath> [--enable]
  andy plugin install-github <repository-url> <commit-or-version-tag> [--manifest plugin.json] [--enable]
  andy plugin enable <pluginId>
  andy plugin disable <pluginId>
  andy plugin remove <pluginId>
  andy plugin restart-crashed
  andy approval list
  andy approval approve <approvalId>
  andy approval deny <approvalId>

Environment:
  ANDY_DAEMON_URL overrides the daemon URL.`);
}

async function runLegacySmoke(message: string): Promise<void> {
  const audit = new ConsoleAuditSink();
  const policy = new CapabilityPolicy({
    allowedCapabilities: new Set(["agent.respond"]),
  });
  const runtime = new AgentRuntime({ audit, policy });
  Effect.runSync(runtime.registerPlugin(corePlugin));

  const result = await Effect.runPromise(
    runtime.executeTool("agent.respond", {
      message,
    }),
  );

  console.log(readMessage(result.output));
}

function readMessage(value: JsonValue): string {
  if (isJsonObject(value)) {
    const message = getJsonObjectProperty(value, "message");
    if (typeof message === "string") {
      return message;
    }
  }

  return "Andy plugin runtime completed without a message.";
}
