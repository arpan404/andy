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
  workflow?: string;
  input?: JsonValue;
  skills: string[];
  modelProviderId?: string;
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
} else if (parsed.command === "skill" || parsed.command === "skills") {
  await runSkillCommand(parsed);
} else if (parsed.command === "ask") {
  await runAskCommand(parsed);
} else if (parsed.command === "approval" || parsed.command === "approvals") {
  await runApprovalCommand(parsed);
} else if (parsed.command === "help" || parsed.command === "--help") {
  printHelp();
} else {
  await runLegacySmoke(process.argv.slice(2).join(" "));
}

async function runAskCommand(args: ParsedArgs): Promise<void> {
  const message = args.rest.join(" ").trim();
  if (!message) {
    throw new Error("Usage: andy ask [--skills skill.a,skill.b] <message>");
  }
  await printDaemonJson(args.url, "POST", "/agent/run", {
    message,
    skillIds: args.skills,
    ...(args.modelProviderId ? { modelProviderId: args.modelProviderId } : {}),
  });
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
  if (action === "review-local") {
    const [manifestPath] = rest;
    if (!manifestPath) {
      throw new Error("Usage: andy plugin review-local <manifestPath>");
    }
    await printDaemonJson(args.url, "POST", "/plugins/review-local", {
      manifestPath,
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

async function runSkillCommand(args: ParsedArgs): Promise<void> {
  const [action, ...rest] = args.rest;
  if (!action || action === "list") {
    await printDaemonJson(args.url, "GET", "/skills");
    return;
  }

  if (action === "install-local") {
    const [manifestPath] = rest;
    if (!manifestPath) {
      throw new Error("Usage: andy skill install-local <manifestPath> [--enable]");
    }
    await printDaemonJson(args.url, "POST", "/skills/install-local", {
      manifestPath,
      enabled: args.enable,
    });
    return;
  }
  if (action === "review-local") {
    const [manifestPath] = rest;
    if (!manifestPath) {
      throw new Error("Usage: andy skill review-local <manifestPath>");
    }
    await printDaemonJson(args.url, "POST", "/skills/review-local", {
      manifestPath,
    });
    return;
  }

  if (action === "enable" || action === "disable" || action === "remove") {
    const [skillId] = rest;
    if (!skillId) {
      throw new Error(`Usage: andy skill ${action} <skillId>`);
    }
    await printDaemonJson(args.url, "POST", `/skills/${skillId}/${action}`);
    return;
  }

  if (action === "run") {
    const [skillId] = rest;
    if (!skillId) {
      throw new Error(
        'Usage: andy skill run <skillId> [--workflow name] [--input \'{"key":"value"}\']',
      );
    }
    await printDaemonJson(args.url, "POST", `/skills/${skillId}/run`, {
      ...(args.workflow ? { workflow: args.workflow } : {}),
      input: args.input ?? {},
    });
    return;
  }

  throw new Error(`Unknown skill command '${action}'.`);
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
    if (arg === "--workflow") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--workflow requires a value.");
      }
      positional.push(`__workflow:${value}`);
      index += 1;
      continue;
    }
    if (arg === "--input") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--input requires a JSON value.");
      }
      positional.push(`__input:${value}`);
      index += 1;
      continue;
    }
    if (arg === "--skills") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--skills requires a comma-separated value.");
      }
      positional.push(`__skills:${value}`);
      index += 1;
      continue;
    }
    if (arg === "--model-provider") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--model-provider requires a value.");
      }
      positional.push(`__modelProvider:${value}`);
      index += 1;
      continue;
    }
    if (arg) {
      positional.push(arg);
    }
  }

  const [command, ...rest] = positional;
  const workflowMarker = rest.find((item) => item.startsWith("__workflow:"));
  const inputMarker = rest.find((item) => item.startsWith("__input:"));
  const skillsMarker = rest.find((item) => item.startsWith("__skills:"));
  const modelProviderMarker = rest.find((item) => item.startsWith("__modelProvider:"));
  return {
    command,
    rest: rest
      .filter((item) => !item.startsWith("__workflow:") && !item.startsWith("__input:"))
      .filter(
        (item) => !item.startsWith("__skills:") && !item.startsWith("__modelProvider:"),
      ),
    url: trimTrailingSlash(url),
    enable,
    skills: skillsMarker
      ? skillsMarker
          .slice("__skills:".length)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [],
    ...(manifestPath ? { manifestPath } : {}),
    ...(workflowMarker ? { workflow: workflowMarker.slice("__workflow:".length) } : {}),
    ...(modelProviderMarker
      ? { modelProviderId: modelProviderMarker.slice("__modelProvider:".length) }
      : {}),
    ...(inputMarker
      ? { input: parseJsonResponse(inputMarker.slice("__input:".length)) }
      : {}),
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
  andy ask [--skills skill.a,skill.b] [--model-provider id] <message>
  andy plugin list
  andy plugin install-local <manifestPath> [--enable]
  andy plugin review-local <manifestPath>
  andy plugin install-github <repository-url> <commit-or-version-tag> [--manifest plugin.json] [--enable]
  andy plugin enable <pluginId>
  andy plugin disable <pluginId>
  andy plugin remove <pluginId>
  andy plugin restart-crashed
  andy skill list
  andy skill install-local <manifestPath> [--enable]
  andy skill review-local <manifestPath>
  andy skill enable <skillId>
  andy skill disable <skillId>
  andy skill remove <skillId>
  andy skill run <skillId> [--workflow name] [--input '{"key":"value"}']
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
