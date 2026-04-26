import { jsonSchema, tool, type ToolSet } from "ai";
import type { RuntimeToolRecord } from "./types.js";

export function toAiSdkToolName(qualifiedName: string): string {
  return `andy_${Buffer.from(qualifiedName, "utf8").toString("base64url")}`;
}

export function buildAiSdkTools(tools: readonly RuntimeToolRecord[]): ToolSet {
  return Object.fromEntries(
    tools.map((record) => [
      record.aiToolName,
      tool({
        description: [
          record.description,
          `Andy qualified tool: ${record.qualifiedName}.`,
          `Capabilities: ${record.capabilities.join(", ") || "none"}.`,
          `Risk: ${record.risk}.`,
        ].join(" "),
        inputSchema: jsonSchema({
          type: "object",
          additionalProperties: true,
        }),
      }),
    ]),
  );
}
