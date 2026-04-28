export type TrustLevel =
  | "trusted_user"
  | "trusted_system"
  | "trusted_tool"
  | "untrusted";

export interface ProvenanceLabel {
  sourceId: string;
  sourceType:
    | "user"
    | "system"
    | "browser"
    | "email"
    | "document"
    | "calendar"
    | "messaging"
    | "file"
    | "tool";
  trust: TrustLevel;
  domain?: string;
}

export interface ProvenancePolicyDecision {
  type: "allow" | "deny" | "ask";
  reason?: string;
}

export interface ToolOutputProvenanceInput {
  toolName: string;
  runId: string;
  output: unknown;
}

const externalWriteCapabilities = new Set([
  "messaging.send",
  "messaging.manage_webhook",
  "browser.submit_form",
  "email.send",
  "calendar.write",
  "filesystem.write",
  "filesystem.delete",
  "shell.execute",
]);

const secretCapabilities = new Set(["secrets.get"]);

export function hasUntrustedProvenance(
  labels: readonly ProvenanceLabel[] | undefined,
): boolean {
  return (labels ?? []).some((label) => label.trust === "untrusted");
}

export function decideProvenancePolicy(input: {
  provenance?: readonly ProvenanceLabel[];
  capabilities: readonly string[];
}): ProvenancePolicyDecision {
  if (!hasUntrustedProvenance(input.provenance)) {
    return { type: "allow" };
  }
  if (input.capabilities.some((capability) => secretCapabilities.has(capability))) {
    return {
      type: "deny",
      reason: "Untrusted source context cannot request secret access.",
    };
  }
  if (
    input.capabilities.some((capability) => externalWriteCapabilities.has(capability))
  ) {
    return {
      type: "ask",
      reason:
        "This action combines untrusted source context with an external or write side effect.",
    };
  }
  return { type: "allow" };
}

export function inferToolOutputProvenance(
  input: ToolOutputProvenanceInput,
): readonly ProvenanceLabel[] {
  const explicit = readExplicitProvenance(input.output);
  if (explicit.length > 0) {
    return explicit;
  }
  const sourceType = inferSourceTypeFromToolName(input.toolName);
  if (!sourceType) {
    return [];
  }
  const domain = inferSourceDomain(input.output);
  return [
    {
      sourceId: inferSourceId(input.output) ?? `${input.toolName}:${input.runId}`,
      sourceType,
      trust: "untrusted",
      ...(domain ? { domain } : {}),
    },
  ];
}

function inferSourceTypeFromToolName(
  toolName: string,
): ProvenanceLabel["sourceType"] | undefined {
  if (toolName.startsWith("browser.") || toolName.includes(".browser.")) {
    return "browser";
  }
  if (
    toolName === "filesystem.read" ||
    toolName === "filesystem.read_sensitive" ||
    toolName === "filesystem.list" ||
    toolName.endsWith(".filesystem.read") ||
    toolName.endsWith(".filesystem.read_sensitive") ||
    toolName.endsWith(".filesystem.list")
  ) {
    return "file";
  }
  if (
    toolName.startsWith("telegram.") ||
    toolName.startsWith("whatsapp.") ||
    toolName.startsWith("messaging.") ||
    toolName.includes(".telegram.") ||
    toolName.includes(".whatsapp.") ||
    toolName.includes(".messaging.")
  ) {
    return "messaging";
  }
  return undefined;
}

function readExplicitProvenance(output: unknown): readonly ProvenanceLabel[] {
  if (!isRecord(output)) {
    return [];
  }
  const { provenance } = output as { provenance?: unknown };
  if (!Array.isArray(provenance)) {
    return [];
  }
  return provenance.flatMap((item): ProvenanceLabel[] => {
    if (!isRecord(item)) {
      return [];
    }
    const { sourceId, sourceType, trust, domain } = item;
    if (
      typeof sourceId !== "string" ||
      !isSourceType(sourceType) ||
      !isTrustLevel(trust)
    ) {
      return [];
    }
    return [
      {
        sourceId,
        sourceType,
        trust,
        ...(typeof domain === "string" ? { domain } : {}),
      },
    ];
  });
}

function inferSourceId(output: unknown): string | undefined {
  if (!isRecord(output)) {
    return undefined;
  }
  for (const key of ["url", "path", "messageId", "conversationId", "id", "source"]) {
    const value = output[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function inferSourceDomain(output: unknown): string | undefined {
  if (!isRecord(output)) {
    return undefined;
  }
  const { url } = output as { url?: unknown };
  if (typeof url === "string") {
    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  }
  const { domain } = output as { domain?: unknown };
  return typeof domain === "string" ? domain : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSourceType(value: unknown): value is ProvenanceLabel["sourceType"] {
  return (
    value === "user" ||
    value === "system" ||
    value === "browser" ||
    value === "email" ||
    value === "document" ||
    value === "calendar" ||
    value === "messaging" ||
    value === "file" ||
    value === "tool"
  );
}

function isTrustLevel(value: unknown): value is TrustLevel {
  return (
    value === "trusted_user" ||
    value === "trusted_system" ||
    value === "trusted_tool" ||
    value === "untrusted"
  );
}
