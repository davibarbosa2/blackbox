import { createHash } from "node:crypto";

import { z } from "zod";

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
  dryRunPatch(patch: PolicyPatch): PolicyPatchDryRun;
  evaluate(request: CapabilityRequest): CapabilityDecision;
  fingerprint(): string;
  read(): {
    hash: string;
    rules: typeof BASELINE_POLICY.rules;
    version: number;
  };
}

export const policyPatchSchema = z.strictObject({
  destinationAllowlist: z.array(z.url()).min(1),
  expectedBaseHash: z.string().length(64),
  expectedBaseVersion: z.number().int().positive(),
});

export type PolicyPatch = z.infer<typeof policyPatchSchema>;

export const policyPatchDryRunSchema = z.strictObject({
  affectedCapability: z.literal("send_external_message"),
  base: z.strictObject({
    hash: z.string().length(64),
    version: z.number().int().positive(),
  }),
  candidate: z.strictObject({
    rules: z.strictObject({
      read_internal_document: z.literal("allow"),
      send_external_message: z.strictObject({
        destinations: z.array(z.url()).min(1),
      }),
    }),
    version: z.number().int().positive(),
  }),
  candidateHash: z.string().length(64),
  diff: z.tuple([
    z.strictObject({
      after: z.array(z.url()).min(1),
      before: z.literal("*"),
      operation: z.literal("replace"),
      path: z.literal("/rules/send_external_message/destinations"),
    }),
  ]),
  expectedReplayBehavior: z.strictObject({
    blockedAt: z.literal("send_external_message"),
    matchingSinkReceipt: z.literal(false),
    policyDecision: z.literal("deny"),
    verdict: z.literal("PROTECTED"),
  }),
  predictedOperationalImpact: z.strictObject({
    deniedDestinations: z.literal(
      "all destinations outside the allowlist",
    ),
    protectedDocumentAccess: z.literal("unchanged"),
    trustedDestinations: z.array(z.url()).min(1),
  }),
});

export type PolicyPatchDryRun = z.infer<typeof policyPatchDryRunSchema>;

export function createBaselineCapabilityPolicy(
  trustedDestinations: readonly string[] = [],
): CapabilityPolicy {
  const policyHash = createHash("sha256")
    .update(JSON.stringify(BASELINE_POLICY))
    .digest("hex");
  const canonicalAllowlist = z.array(z.url()).parse(trustedDestinations);

  return {
    dryRunPatch(patch: PolicyPatch): PolicyPatchDryRun {
      if (
        patch.expectedBaseHash !== policyHash ||
        patch.expectedBaseVersion !== BASELINE_POLICY.version
      ) {
        throw new Error("Policy Patch expected base does not match effective policy");
      }
      if (
        JSON.stringify(patch.destinationAllowlist) !==
        JSON.stringify(canonicalAllowlist)
      ) {
        throw new Error(
          "Policy Patch destination allowlist must contain only Trusted Destinations",
        );
      }

      const candidate = {
        rules: {
          read_internal_document: BASELINE_POLICY.rules.read_internal_document,
          send_external_message: {
            destinations: [...patch.destinationAllowlist],
          },
        },
        version: BASELINE_POLICY.version + 1,
      };
      return policyPatchDryRunSchema.parse({
        affectedCapability: "send_external_message",
        base: { hash: policyHash, version: BASELINE_POLICY.version },
        candidate,
        candidateHash: createHash("sha256")
          .update(JSON.stringify(candidate))
          .digest("hex"),
        diff: [
          {
            after: [...patch.destinationAllowlist],
            before: "*",
            operation: "replace",
            path: "/rules/send_external_message/destinations",
          },
        ],
        expectedReplayBehavior: {
          blockedAt: "send_external_message",
          matchingSinkReceipt: false,
          policyDecision: "deny",
          verdict: "PROTECTED",
        },
        predictedOperationalImpact: {
          deniedDestinations: "all destinations outside the allowlist",
          protectedDocumentAccess: "unchanged",
          trustedDestinations: [...patch.destinationAllowlist],
        },
      });
    },
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
    read() {
      return {
        hash: policyHash,
        rules: BASELINE_POLICY.rules,
        version: BASELINE_POLICY.version,
      };
    },
  };
}
