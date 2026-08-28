import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

const BASELINE_POLICY = {
  rules: {
    read_internal_document: "allow",
    send_external_message: { destinations: "*" },
  },
  version: 1,
} as const;

const policyRulesSchema = z.strictObject({
  read_internal_document: z.literal("allow"),
  send_external_message: z.strictObject({
    destinations: z.union([z.literal("*"), z.array(z.url()).min(1)]),
  }),
});

export const policyReadSchema = z.strictObject({
  hash: z.string().length(64),
  rules: policyRulesSchema,
  version: z.number().int().positive(),
});

export type PolicyRead = z.infer<typeof policyReadSchema>;

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

export const policyApprovalEvidenceSchema = z.strictObject({
  actionId: z.string(),
  callId: z.string(),
  decidedAt: z.string(),
  sessionId: z.string(),
  threadId: z.string(),
  turnId: z.string(),
});

export type PolicyApprovalEvidence = z.infer<
  typeof policyApprovalEvidenceSchema
>;

const appliedPolicyResultSchema = z.strictObject({
  approval: policyApprovalEvidenceSchema,
  readback: policyReadSchema,
  status: z.literal("APPLIED"),
});

export const policyApplicationResultSchema = z.union([
  appliedPolicyResultSchema,
  appliedPolicyResultSchema.extend({
    status: z.literal("ALREADY_APPLIED"),
  }),
  z.strictObject({
    readback: policyReadSchema,
    status: z.literal("STALE"),
  }),
]);

export type PolicyApplicationResult = z.infer<
  typeof policyApplicationResultSchema
>;

export interface CapabilityPolicy {
  applyPatch(
    patch: PolicyPatch,
    approval: PolicyApprovalEvidence,
  ): PolicyApplicationResult;
  close(): void;
  dryRunPatch(patch: PolicyPatch): PolicyPatchDryRun;
  evaluate(request: CapabilityRequest): CapabilityDecision;
  fingerprint(): string;
  read(): PolicyRead;
  readApplication(actionId: string): PolicyApplicationResult | undefined;
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
  let policy = baselinePolicyRead();
  const applications = new Map<string, PolicyApplicationResult>();
  const canonicalAllowlist = parseTrustedDestinations(trustedDestinations);

  return {
    applyPatch(patch, approval) {
      const result = applyPatchToState(
        policy,
        patch,
        approval,
        canonicalAllowlist,
        applications.get(approval.actionId),
      );
      if (result.status === "APPLIED") {
        policy = result.readback;
        applications.set(approval.actionId, result);
      }
      return result;
    },
    close() {},
    dryRunPatch(patch) {
      return createDryRun(policy, patch, canonicalAllowlist);
    },
    evaluate(request) {
      return evaluateRequest(policy, request);
    },
    fingerprint() {
      return policy.hash;
    },
    read() {
      return structuredClone(policy);
    },
    readApplication(actionId) {
      const application = applications.get(actionId);
      return application === undefined
        ? undefined
        : structuredClone(application);
    },
  };
}

const policyRowSchema = z.object({ policy_json: z.string() });
const applicationRowSchema = z.object({ application_json: z.string() });

export function createSqliteCapabilityPolicy(
  path: string,
  trustedDestinations: readonly string[] = [],
): CapabilityPolicy {
  const database = new DatabaseSync(path);
  const canonicalAllowlist = parseTrustedDestinations(trustedDestinations);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS capability_policy (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      policy_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS policy_applications (
      action_id TEXT PRIMARY KEY,
      application_json TEXT NOT NULL
    );
  `);
  database
    .prepare(
      "INSERT OR IGNORE INTO capability_policy (singleton, policy_json) VALUES (1, ?)",
    )
    .run(JSON.stringify(baselinePolicyRead()));

  const read = (): PolicyRead => {
    const row = policyRowSchema.parse(
      database
        .prepare(
          "SELECT policy_json FROM capability_policy WHERE singleton = 1",
        )
        .get(),
    );
    return policyReadSchema.parse(JSON.parse(row.policy_json));
  };
  const readApplication = (
    actionId: string,
  ): PolicyApplicationResult | undefined => {
    const row = database
      .prepare(
        "SELECT application_json FROM policy_applications WHERE action_id = ?",
      )
      .get(actionId);
    if (row === undefined) return undefined;
    const parsed = applicationRowSchema.parse(row);
    return policyApplicationResultSchema.parse(
      JSON.parse(parsed.application_json),
    );
  };

  return {
    applyPatch(patch, approval) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = applyPatchToState(
          read(),
          patch,
          approval,
          canonicalAllowlist,
          readApplication(approval.actionId),
        );
        if (result.status === "APPLIED") {
          database
            .prepare(
              "INSERT INTO policy_applications (action_id, application_json) VALUES (?, ?)",
            )
            .run(approval.actionId, JSON.stringify(result));
          database
            .prepare(
              "UPDATE capability_policy SET policy_json = ? WHERE singleton = 1",
            )
            .run(JSON.stringify(result.readback));
        }
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      database.close();
    },
    dryRunPatch(patch) {
      return createDryRun(read(), patch, canonicalAllowlist);
    },
    evaluate(request) {
      return evaluateRequest(read(), request);
    },
    fingerprint() {
      return read().hash;
    },
    read,
    readApplication,
  };
}

function applyPatchToState(
  current: PolicyRead,
  sourcePatch: PolicyPatch,
  sourceApproval: PolicyApprovalEvidence,
  canonicalAllowlist: readonly string[],
  existing: PolicyApplicationResult | undefined,
): PolicyApplicationResult {
  const patch = policyPatchSchema.parse(sourcePatch);
  const approval = policyApprovalEvidenceSchema.parse(sourceApproval);
  validateCanonicalAllowlist(patch, canonicalAllowlist);
  const candidate = candidatePolicy(patch);
  const candidateRead = policyReadSchema.parse({
    ...candidate,
    hash: hashPolicy(candidate),
  });

  if (existing !== undefined) {
    if (
      existing.status === "STALE" ||
      existing.approval.actionId !== approval.actionId ||
      existing.approval.callId !== approval.callId ||
      existing.approval.sessionId !== approval.sessionId ||
      existing.approval.threadId !== approval.threadId ||
      existing.approval.turnId !== approval.turnId ||
      existing.readback.hash !== candidateRead.hash
    ) {
      throw new Error("Policy approval action already has different content");
    }
    return policyApplicationResultSchema.parse({
      ...existing,
      status: "ALREADY_APPLIED",
    });
  }
  if (
    patch.expectedBaseHash !== current.hash ||
    patch.expectedBaseVersion !== current.version
  ) {
    return { readback: structuredClone(current), status: "STALE" };
  }

  return policyApplicationResultSchema.parse({
    approval,
    readback: candidateRead,
    status: "APPLIED",
  });
}

function createDryRun(
  current: PolicyRead,
  sourcePatch: PolicyPatch,
  canonicalAllowlist: readonly string[],
): PolicyPatchDryRun {
  const patch = policyPatchSchema.parse(sourcePatch);
  if (
    patch.expectedBaseHash !== current.hash ||
    patch.expectedBaseVersion !== current.version ||
    current.rules.send_external_message.destinations !== "*"
  ) {
    throw new Error("Policy Patch expected base does not match effective policy");
  }
  validateCanonicalAllowlist(patch, canonicalAllowlist);
  const candidate = candidatePolicy(patch);
  return policyPatchDryRunSchema.parse({
    affectedCapability: "send_external_message",
    base: { hash: current.hash, version: current.version },
    candidate,
    candidateHash: hashPolicy(candidate),
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
}

function candidatePolicy(patch: PolicyPatch) {
  return {
    rules: {
      read_internal_document: "allow" as const,
      send_external_message: {
        destinations: [...patch.destinationAllowlist],
      },
    },
    version: patch.expectedBaseVersion + 1,
  };
}

function evaluateRequest(
  policy: PolicyRead,
  request: CapabilityRequest,
): CapabilityDecision {
  const destinations = policy.rules.send_external_message.destinations;
  if (destinations === "*") {
    return {
      decision: "allow",
      policyHash: policy.hash,
      policyVersion: policy.version,
      reason: "Capability Policy v1 has no outbound destination allowlist",
    };
  }
  const allowed = destinations.includes(request.destination);
  return {
    decision: allowed ? "allow" : "deny",
    policyHash: policy.hash,
    policyVersion: policy.version,
    reason: allowed
      ? "Destination is present in the Capability Policy allowlist"
      : "Destination is not present in the Capability Policy allowlist",
  };
}

function validateCanonicalAllowlist(
  patch: PolicyPatch,
  canonicalAllowlist: readonly string[],
): void {
  if (
    JSON.stringify(patch.destinationAllowlist) !==
    JSON.stringify(canonicalAllowlist)
  ) {
    throw new Error(
      "Policy Patch destination allowlist must contain only Trusted Destinations",
    );
  }
}

function parseTrustedDestinations(
  trustedDestinations: readonly string[],
): string[] {
  return z.array(z.url()).parse(trustedDestinations);
}

function baselinePolicyRead(): PolicyRead {
  return policyReadSchema.parse({
    ...BASELINE_POLICY,
    hash: hashPolicy(BASELINE_POLICY),
  });
}

function hashPolicy(policy: { rules: unknown; version: number }): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}
