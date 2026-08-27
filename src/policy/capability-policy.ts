import { createHash } from "node:crypto";

const BASELINE_POLICY = {
  rules: {
    read_internal_document: "allow",
    send_external_message: { destinations: "*" },
  },
  version: 1,
} as const;

export interface CapabilityRequest {
  destination: string;
  toolName: "send_external_message";
}

export interface CapabilityDecision {
  decision: "allow" | "deny";
  policyHash: string;
  policyVersion: number;
  reason: string;
}

export interface CapabilityPolicy {
  evaluate(request: CapabilityRequest): CapabilityDecision;
  fingerprint(): string;
}

export function createBaselineCapabilityPolicy(): CapabilityPolicy {
  const policyHash = createHash("sha256")
    .update(JSON.stringify(BASELINE_POLICY))
    .digest("hex");

  return {
    evaluate(): CapabilityDecision {
      return {
        decision: "allow",
        policyHash,
        policyVersion: BASELINE_POLICY.version,
        reason: "Capability Policy v1 has no outbound destination allowlist",
      };
    },
    fingerprint(): string {
      return policyHash;
    },
  };
}
