import type { JsonObject, JsonValue } from "@andy/types";
import { Schema } from "effect";
import type { RiskLevel } from "@andy/plugin-sdk";

export type SkillLifecycleStatus = "installed" | "enabled" | "disabled" | "removed";

export interface SkillManifest {
  schemaVersion?: string;
  id: string;
  name: string;
  version: string;
  description: string;
  risk: RiskLevel;
  instructions?: string;
  requiredPlugins: string[];
  requiredCapabilities: string[];
  workflows: SkillWorkflow[];
}

export interface SkillWorkflow {
  name: string;
  description: string;
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
  steps: SkillWorkflowStep[];
}

export interface SkillWorkflowStep {
  id: string;
  toolName: string;
  input: JsonObject;
  description?: string;
  when?: string;
  forEach?: string;
  continueOnError?: boolean;
  saveAs?: string;
}

export const SkillWorkflowStepSchema = Schema.Struct({
  id: Schema.String,
  toolName: Schema.String,
  input: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  description: Schema.optional(Schema.String),
  when: Schema.optional(Schema.String),
  forEach: Schema.optional(Schema.String),
  continueOnError: Schema.optional(Schema.Boolean),
  saveAs: Schema.optional(Schema.String),
});

export const SkillWorkflowSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  inputSchema: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  outputSchema: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  steps: Schema.Array(SkillWorkflowStepSchema),
});

export const SkillManifestSchema = Schema.Struct({
  schemaVersion: Schema.optional(Schema.String),
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  description: Schema.String,
  risk: Schema.Literal("low", "medium", "high", "critical"),
  instructions: Schema.optional(Schema.String),
  requiredPlugins: Schema.Array(Schema.String),
  requiredCapabilities: Schema.Array(Schema.String),
  workflows: Schema.Array(SkillWorkflowSchema),
});

export class SkillCapabilityUndeclaredError extends Schema.TaggedError<SkillCapabilityUndeclaredError>()(
  "SkillCapabilityUndeclaredError",
  {
    skillId: Schema.String,
    workflow: Schema.String,
    stepId: Schema.String,
    toolName: Schema.String,
    capability: Schema.String,
    message: Schema.String,
  },
) {}

export class SkillWorkflowInvalidError extends Schema.TaggedError<SkillWorkflowInvalidError>()(
  "SkillWorkflowInvalidError",
  {
    skillId: Schema.String,
    workflow: Schema.String,
    message: Schema.String,
  },
) {}

export function parseSkillManifest(input: unknown): SkillManifest {
  const manifest = Schema.decodeUnknownSync(SkillManifestSchema)(
    input,
  ) as SkillManifest;
  assertSkillManifest(manifest);
  return manifest;
}

export function assertSkillManifest(manifest: SkillManifest): void {
  if (manifest.workflows.length === 0) {
    throw new SkillWorkflowInvalidError({
      skillId: manifest.id,
      workflow: "",
      message: `Skill '${manifest.id}' must declare at least one workflow.`,
    });
  }

  const requiredCapabilities = new Set(manifest.requiredCapabilities);
  for (const workflow of manifest.workflows) {
    if (workflow.steps.length === 0) {
      throw new SkillWorkflowInvalidError({
        skillId: manifest.id,
        workflow: workflow.name,
        message: `Skill '${manifest.id}' workflow '${workflow.name}' must declare at least one step.`,
      });
    }
    const stepIds = new Set<string>();
    for (const step of workflow.steps) {
      if (stepIds.has(step.id)) {
        throw new SkillWorkflowInvalidError({
          skillId: manifest.id,
          workflow: workflow.name,
          message: `Skill '${manifest.id}' workflow '${workflow.name}' has duplicate step id '${step.id}'.`,
        });
      }
      stepIds.add(step.id);

      const capability = inferCapabilityFromToolName(step.toolName);
      if (!requiredCapabilities.has(capability)) {
        throw new SkillCapabilityUndeclaredError({
          skillId: manifest.id,
          workflow: workflow.name,
          stepId: step.id,
          toolName: step.toolName,
          capability,
          message: `Skill '${manifest.id}' step '${step.id}' uses tool '${step.toolName}' but requiredCapabilities does not include '${capability}'.`,
        });
      }
    }
  }
}

export function inferCapabilityFromToolName(toolName: string): string {
  const parts = toolName.split(".");
  if (parts.length >= 2 && parts.at(-2) && parts.at(-1)) {
    return `${parts.at(-2)}.${parts.at(-1)}`;
  }
  return toolName;
}

export function isJsonObjectRecord(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
