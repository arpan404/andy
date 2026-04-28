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
