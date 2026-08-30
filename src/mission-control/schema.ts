import { z } from "zod";

const evidenceReferenceSchema = z.strictObject({
  bundleHash: z.string().length(64),
  url: z.string(),
});

const activityTraceSchema = z.strictObject({
  durationMs: z.number().int().nonnegative().nullable(),
  outcome: z.enum([
    "PENDING",
    "SUCCEEDED",
    "DELIVERY_UNCONFIRMED",
    "DENIED",
    "FAILED",
    "RESPONSE_RECORDED",
  ]),
  result: z.string().min(1),
  safeArguments: z
    .array(
      z.strictObject({
        label: z.string().min(1),
        value: z.string().min(1),
      }),
    )
    .max(3),
  why: z.string().min(1),
});

const activitySchema = z.strictObject({
  detail: z.string().nullable(),
  evidence: evidenceReferenceSchema.nullable(),
  id: z.string(),
  kind: z.enum([
    "phase",
    "tool",
    "evidence",
    "subagent",
    "sandbox",
    "failure",
  ]),
  occurredAt: z.string().nullable(),
  scope: z.enum([
    "BASELINE",
    "INVESTIGATION",
    "DECISION",
    "REPLAY",
    "CONTROL",
  ]),
  source: z.enum([
    "BLACKBOX",
    "TRUEFORGE",
    "SCENARIO_MCP",
    "DAYTONA",
    "CAPABILITY_POLICY",
    "EXTERNAL_SINK",
    "TRUSTED_DESTINATION",
  ]),
  status: z.enum(["ACTIVE", "COMPLETED", "FAILED"]),
  title: z.string(),
  trace: activityTraceSchema.optional(),
});

const baselineSummarySchema = z.strictObject({
  bundleHash: z.string().length(64),
  complete: z.boolean(),
  evidenceUrl: z.string(),
  runId: z.string(),
  verdict: z.enum(["VULNERABLE", "INCONCLUSIVE"]),
});

const candidatePolicySchema = z.strictObject({
  rules: z.strictObject({
    read_internal_document: z.literal("allow"),
    send_external_message: z.strictObject({
      destinations: z.array(z.url()).min(1),
    }),
  }),
  version: z.number().int().positive(),
});

const approvalSchema = z.strictObject({
  affectedCapability: z.literal("send_external_message"),
  base: z.strictObject({
    hash: z.string().length(64),
    version: z.number().int().positive(),
  }),
  candidate: candidatePolicySchema,
  candidateHash: z.string().length(64),
  diff: z.tuple([
    z.strictObject({
      after: z.array(z.url()).min(1),
      before: z.literal("*"),
      operation: z.literal("replace"),
      path: z.literal("/rules/send_external_message/destinations"),
    }),
  ]),
  evidenceJustification: z.strictObject({
    bundleHash: z.string().length(64),
    runId: z.string(),
    summary: z.string().min(1),
  }),
  expectedReplayBehavior: z.strictObject({
    blockedAt: z.literal("send_external_message"),
    matchingSinkReceipt: z.literal(false),
    policyDecision: z.literal("deny"),
    verdict: z.literal("PROTECTED"),
  }),
  pendingDecision: z.strictObject({
    actionId: z.string(),
    callId: z.string(),
    sessionId: z.string(),
    threadId: z.string(),
    toolName: z.literal("apply_policy_patch"),
    turnId: z.string(),
  }),
  predictedOperationalImpact: z.strictObject({
    deniedDestinations: z.literal(
      "all destinations outside the allowlist",
    ),
    protectedDocumentAccess: z.literal("unchanged"),
    trustedDestinations: z.array(z.url()).min(1),
  }),
});

const comparisonSchema = z.strictObject({
  baseline: z.strictObject({
    bundleHash: z.string().length(64),
    complete: z.boolean(),
    evidenceUrl: z.string(),
    exactCanaryReceipts: z.number().int().nonnegative(),
    result: z.enum(["VULNERABLE", "INCONCLUSIVE"]),
    runId: z.string(),
  }),
  containment: z
    .strictObject({
      claim: z.literal("VERIFIED_REMEDIATION"),
      evidence: z.tuple([
        evidenceReferenceSchema,
        evidenceReferenceSchema,
        evidenceReferenceSchema,
      ]),
    })
    .nullable(),
  control: z
    .strictObject({
      bundleHash: z.string().length(64),
      complete: z.boolean(),
      evidenceUrl: z.string(),
      result: z.enum(["PASSED", "INCONCLUSIVE"]),
      runId: z.string(),
      trustedDestinationReceipts: z.number().int().nonnegative(),
    })
    .nullable(),
  replay: z
    .strictObject({
      bundleHash: z.string().length(64),
      complete: z.boolean(),
      evidenceUrl: z.string(),
      explicitPolicyDenial: z.boolean(),
      matchingCanaryReceipts: z.number().int().nonnegative(),
      result: z.enum(["PROTECTED", "INCONCLUSIVE"]),
      runId: z.string(),
    })
    .nullable(),
});

const verificationSchema = z.strictObject({
  control: z.strictObject({
    result: z.enum(["PASSED", "INCONCLUSIVE"]).nullable(),
    runId: z.string().nullable(),
    state: z.enum(["WAITING", "ACTIVE", "COMPLETED", "INCONCLUSIVE"]),
  }),
  policyReadback: z.strictObject({
    hash: z.string().length(64),
    state: z.literal("MATCHED"),
    version: z.number().int().positive(),
  }),
  replay: z.strictObject({
    result: z.enum(["PROTECTED", "INCONCLUSIVE"]).nullable(),
    runId: z.string().nullable(),
    state: z.enum(["WAITING", "ACTIVE", "COMPLETED", "INCONCLUSIVE"]),
  }),
});

const integrationsSchema = z.strictObject({
  trueForgeSessionId: z.string().nullable(),
  trueForgeUrl: z.url(),
});

export const missionControlSnapshotSchema = z.strictObject({
  activity: z.array(activitySchema),
  approval: approvalSchema.nullable(),
  baseline: baselineSummarySchema.nullable(),
  comparison: comparisonSchema.nullable(),
  decisionPending: z.boolean(),
  failure: z
    .strictObject({
      detail: z.string(),
      title: z.string(),
    })
    .nullable(),
  integrations: integrationsSchema.optional(),
  incident: z
    .strictObject({
      id: z.string(),
      status: z.enum(["OPEN", "RESOLVED"]),
    })
    .nullable(),
  operationActive: z.boolean(),
  phase: z.enum([
    "READY",
    "BASELINE",
    "INVESTIGATION",
    "APPROVAL",
    "VERIFICATION",
    "RESULT",
  ]),
  status: z.enum([
    "READY",
    "BASELINE_RUNNING",
    "BASELINE_INCONCLUSIVE",
    "INVESTIGATING",
    "DRAFTED",
    "DRY_RUN_PASSED",
    "AWAITING_APPROVAL",
    "DENIED",
    "STALE",
    "APPLIED",
    "VERIFYING",
    "VERIFIED",
    "VALIDATION_FAILED",
  ]),
  verification: verificationSchema.nullable(),
});

export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export type MissionControlActivity = z.infer<typeof activitySchema>;
export type MissionControlComparison = z.infer<typeof comparisonSchema>;
export type MissionControlSnapshot = z.infer<
  typeof missionControlSnapshotSchema
>;
