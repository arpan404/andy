import {
  optionalNumber,
  optionalStringArray,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonValue } from "@andy/types";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";

type SwarmAgent = {
  id: string;
  role: string;
  status: "planned" | "spawned" | "delegated" | "completed" | "cancelled";
  task?: string;
};

type Swarm = {
  id: string;
  goal: string;
  status: "planned" | "running" | "completed" | "cancelled";
  agents: SwarmAgent[];
  createdAt: string;
  updatedAt: string;
};

const maxAgents = 8;
const allowedRoles = new Set([
  "planner",
  "researcher",
  "coder",
  "reviewer",
  "operator",
  "summarizer",
]);
const swarms = new Map<string, Swarm>();

startWorkerPlugin((request) =>
  Effect.fn("swarm-orchestrator.handleRequest")(function* () {
    switch (request.toolName) {
      case "swarm.plan":
        return planSwarm(request.input);
      case "swarm.spawn":
        return spawnSwarm(request.input);
      case "swarm.delegate":
        return delegateTask(request.input);
      case "swarm.join":
        return joinSwarm(request.input);
      case "swarm.cancel":
        return cancelSwarm(request.input);
      default:
        return yield* Effect.fail(
          new Error(`Unknown swarm-orchestrator tool '${request.toolName}'.`),
        );
    }
  })(),
);

function planSwarm(input: JsonValue): JsonValue {
  const parsed = requireObject(input, "swarm.plan");
  const goal = requireString(parsed, "goal");
  const roles = normalizeRoles(optionalStringArray(parsed, "roles"));
  const count = clampAgentCount(optionalNumber(parsed, "agentCount") ?? roles.length);
  return {
    goal,
    maxAgents,
    requiresApproval: count > 3,
    agents: roles.slice(0, count).map((role, index) => ({
      id: `planned-${index + 1}`,
      role,
      status: "planned",
    })),
  };
}

function spawnSwarm(input: JsonValue): JsonValue {
  const parsed = requireObject(input, "swarm.spawn");
  const goal = requireString(parsed, "goal");
  const roles = normalizeRoles(optionalStringArray(parsed, "roles"));
  const count = clampAgentCount(optionalNumber(parsed, "agentCount") ?? roles.length);
  const now = new Date().toISOString();
  const swarm: Swarm = {
    id: randomUUID(),
    goal,
    status: "running",
    agents: roles.slice(0, count).map((role) => ({
      id: randomUUID(),
      role,
      status: "spawned",
    })),
    createdAt: now,
    updatedAt: now,
  };
  swarms.set(swarm.id, swarm);
  return swarm;
}

function delegateTask(input: JsonValue): JsonValue {
  const parsed = requireObject(input, "swarm.delegate");
  const swarm = getSwarm(requireString(parsed, "swarmId"));
  const agentId = requireString(parsed, "agentId");
  const task = requireString(parsed, "task");
  const agent = swarm.agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new Error(`Unknown swarm agent '${agentId}'.`);
  }
  agent.task = task;
  agent.status = "delegated";
  swarm.updatedAt = new Date().toISOString();
  return { swarmId: swarm.id, agent };
}

function joinSwarm(input: JsonValue): JsonValue {
  const parsed = requireObject(input, "swarm.join");
  const swarm = getSwarm(requireString(parsed, "swarmId"));
  if (swarm.agents.every((agent) => agent.status !== "cancelled")) {
    for (const agent of swarm.agents) {
      if (agent.status === "delegated" || agent.status === "spawned") {
        agent.status = "completed";
      }
    }
    swarm.status = "completed";
  }
  swarm.updatedAt = new Date().toISOString();
  return {
    swarmId: swarm.id,
    status: swarm.status,
    summary: `${swarm.agents.length} bounded agent(s) joined for: ${swarm.goal}`,
    agents: swarm.agents,
  };
}

function cancelSwarm(input: JsonValue): JsonValue {
  const parsed = requireObject(input, "swarm.cancel");
  const swarm = getSwarm(requireString(parsed, "swarmId"));
  swarm.status = "cancelled";
  swarm.updatedAt = new Date().toISOString();
  for (const agent of swarm.agents) {
    agent.status = "cancelled";
  }
  return swarm;
}

function getSwarm(id: string): Swarm {
  const swarm = swarms.get(id);
  if (!swarm) {
    throw new Error(`Unknown swarm '${id}'.`);
  }
  return swarm;
}

function normalizeRoles(roles: readonly string[] | undefined): string[] {
  const requested = roles?.length ? roles : ["planner", "researcher", "summarizer"];
  const normalized = requested.filter((role) => allowedRoles.has(role));
  if (normalized.length === 0) {
    throw new Error("No allowed swarm roles were requested.");
  }
  return normalized;
}

function clampAgentCount(count: number): number {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("agentCount must be a positive integer.");
  }
  return Math.min(count, maxAgents);
}
