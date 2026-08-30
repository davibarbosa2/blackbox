import { z } from "zod";

import type { BaselineEvidenceBundle } from "../evidence/ledger.js";
import {
  type PolicyRead,
  policyPatchSchema,
} from "../policy/capability-policy.js";

export const runtimeSmokeEvidenceSchema = z.object({
  agent: z.object({
    id: z.string(),
    name: z.string(),
  }),
  execution: z.object({
    exitCode: z.literal(0),
    stdout: z.string(),
    toolCallId: z.string(),
  }),
  health: z.object({
    body: z.literal("OK!"),
    status: z.literal(200),
  }),
  preflight: z.object({
    finishReason: z.literal("tool_calls"),
    responseModel: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
  }),
  provider: z.object({
    modelAlias: z.string(),
    name: z.string(),
    trueForgeModel: z.string(),
    upstreamModelId: z.string(),
  }),
  reconciliation: z.object({
    complete: z.boolean(),
    liveEventIds: z.array(z.string()),
    persistedEventIds: z.array(z.string()),
  }),
  sandbox: z.object({
    event: z.literal("sandbox.created"),
    id: z.string(),
  }),
  turn: z.object({
    sessionId: z.string(),
    status: z.literal("done"),
    turnId: z.string(),
  }),
  versions: z.object({
    node: z.string(),
    pnpm: z.literal("11.16.0"),
    trueForge: z.literal("0.1.4"),
    trueForgeSdk: z.literal("0.1.3"),
  }),
});

export type RuntimeSmokeEvidence = z.infer<typeof runtimeSmokeEvidenceSchema>;

export const runtimeSmokeFailureStageSchema = z.enum([
  "health",
  "configuration",
  "preflight",
  "sandbox-smoke",
]);

export type RuntimeSmokeFailureStage = z.infer<
  typeof runtimeSmokeFailureStageSchema
>;

const baselineToolCallSchema = z.object({
  arguments: z.string(),
  eventId: z.string(),
  occurredAt: z.string(),
  toolCallId: z.string(),
  toolName: z.enum([
    "get_support_ticket",
    "search_internal_documents",
    "read_internal_document",
    "send_external_message",
  ]),
});

export type BaselineToolCall = z.infer<typeof baselineToolCallSchema>;

export const baselineExecutionEvidenceSchema = z.object({
  mcpInitialization: z.object({
    eventId: z.string(),
    occurredAt: z.string(),
    serverName: z.literal("blackbox-scenario"),
  }),
  sessionId: z.string(),
  toolCalls: z.array(baselineToolCallSchema),
  toolResponses: z.array(
    z.object({
      content: z.string(),
      eventId: z.string(),
      occurredAt: z.string(),
      toolCallId: z.string(),
    }),
  ),
  turn: z.object({
    eventId: z.string(),
    occurredAt: z.string(),
    status: z.literal("done"),
    turnId: z.string(),
  }),
});

export type BaselineExecutionEvidence = z.infer<
  typeof baselineExecutionEvidenceSchema
>;

export const evidenceJustificationSchema = z.strictObject({
  bundleHash: z.string().length(64),
  runId: z.string(),
  summary: z.string().min(1),
});

export const investigationProposalSchema = z.strictObject({
  canonicalCause: z.literal(
    "missing_destination_allowlist_in_send_external_message",
  ),
  evidenceJustification: evidenceJustificationSchema,
  patch: policyPatchSchema,
});

export type InvestigationProposal = z.infer<
  typeof investigationProposalSchema
>;

const completedSubagentSchema = z.strictObject({
  createdEventId: z.string(),
  doneEventId: z.string(),
  inputHash: z.string().length(64),
  outputHash: z.string().length(64),
  status: z.literal("done"),
  threadId: z.string(),
  title: z.string(),
});

export const evidenceProvenanceSubagentOutputSchema = z.strictObject({
  bundleHash: z.string().length(64),
  canonicalCause: z.literal(
    "missing_destination_allowlist_in_send_external_message",
  ),
  marker: z.literal("EVIDENCE_PROVENANCE_VERIFIED"),
  runId: z.string(),
});

export const evidenceProvenanceSubagentSchema = completedSubagentSchema.extend({
  output: evidenceProvenanceSubagentOutputSchema,
  role: z.literal("EvidenceProvenanceVerifier"),
});

export const policyPatchSubagentOutputSchema = z.strictObject({
  marker: z.literal("POLICY_PATCH_REVIEWED"),
  policyHash: z.string().length(64),
  policyVersion: z.number().int().positive(),
  protectedDocumentAccess: z.literal("unchanged"),
  trustedDestination: z.url(),
});

export const policyPatchSubagentSchema = completedSubagentSchema.extend({
  output: policyPatchSubagentOutputSchema,
  role: z.literal("PolicyPatchReviewer"),
});

export const subagentEvidenceSchema = z.discriminatedUnion("role", [
  evidenceProvenanceSubagentSchema,
  policyPatchSubagentSchema,
]);

export const investigationAnalysisResultSchema = z.strictObject({
  bundleHash: z.string().length(64),
  canarySha256: z.string().length(64),
  canonicalCause: z.literal(
    "missing_destination_allowlist_in_send_external_message",
  ),
  policyHash: z.string().length(64),
  runId: z.string(),
});

export const investigationAnalysisSchema = z.strictObject({
  artifact: z.strictObject({
    commandHash: z.string().length(64),
    path: z.literal("/tmp/blackbox-investigation-analysis.py"),
  }),
  execution: z.strictObject({
    exitCode: z.literal(0),
    stdout: z.string(),
    toolCallId: z.string(),
  }),
  sandbox: z.strictObject({
    event: z.literal("sandbox.created"),
    id: z.string(),
  }),
  result: investigationAnalysisResultSchema,
});

export const investigationDiagnosisSchema = z.strictObject({
  canonicalCause: z.literal(
    "missing_destination_allowlist_in_send_external_message",
  ),
  summary: z.string().min(1),
});

export const pendingPolicyActionSchema = z.strictObject({
  actionId: z.string(),
  callId: z.string(),
  proposal: investigationProposalSchema,
  sessionId: z.string(),
  threadId: z.string(),
  toolName: z.literal("apply_policy_patch"),
  turnId: z.string(),
});

export const pendingPolicyDecisionSchema = pendingPolicyActionSchema.omit({
  proposal: true,
});

export type PendingPolicyDecision = z.infer<
  typeof pendingPolicyDecisionSchema
>;

export const investigationExecutionEvidenceSchema = z.strictObject({
  analysis: investigationAnalysisSchema,
  diagnosis: investigationDiagnosisSchema,
  pendingAction: pendingPolicyActionSchema,
  subagents: z.tuple([
    policyPatchSubagentSchema,
    evidenceProvenanceSubagentSchema,
  ]),
});

export type InvestigationExecutionEvidence = z.infer<
  typeof investigationExecutionEvidenceSchema
>;

export const investigationMilestoneSchema = z.strictObject({
  kind: z.enum([
    "TURN_STARTED",
    "INVESTIGATOR_MCP_INITIALIZED",
    "POLICY_REVIEW_STARTED",
    "POLICY_REVIEW_COMPLETED",
    "EVIDENCE_REVIEW_STARTED",
    "EVIDENCE_REVIEW_COMPLETED",
    "ANALYSIS_SANDBOX_CREATED",
    "ANALYSIS_EXECUTION_STARTED",
    "ANALYSIS_EXECUTION_COMPLETED",
    "POLICY_PATCH_DRAFTED",
    "POLICY_ACTION_OBSERVED",
  ]),
  occurredAt: z.string(),
  sessionId: z.string(),
  sourceEventId: z.string(),
});

export type InvestigationMilestone = z.infer<
  typeof investigationMilestoneSchema
>;

export const policyActionResolutionSchema = z.strictObject({
  decision: z.enum(["allow", "deny"]),
  pendingDecision: pendingPolicyDecisionSchema,
  resumedTurnId: z.string(),
  status: z.literal("done"),
});

export type PolicyActionResolution = z.infer<
  typeof policyActionResolutionSchema
>;

export interface BaselineExecutionRequest {
  mcpAuthorization: string;
  onToolCall?: (call: BaselineToolCall) => void;
  runId: string;
  signal?: AbortSignal;
}

export interface InvestigationExecutionRequest {
  bundle: BaselineEvidenceBundle;
  mcpAuthorization: string;
  onMilestone?: (milestone: InvestigationMilestone) => void;
  policy: PolicyRead;
  signal?: AbortSignal;
  trustedDestination: string;
}

export interface PolicyActionResolutionRequest {
  decision: "allow" | "deny";
  mcpAuthorization: string;
  pendingDecision: z.infer<typeof pendingPolicyDecisionSchema>;
  signal?: AbortSignal;
}

export class RuntimeSmokeStageError extends Error {
  readonly stage: RuntimeSmokeFailureStage;

  constructor(stage: RuntimeSmokeFailureStage, cause: unknown) {
    super(cause instanceof Error ? cause.message : "Runtime smoke failed", {
      cause,
    });
    this.name = "RuntimeSmokeStageError";
    this.stage = stage;
  }
}

export class InvestigationExecutionError extends Error {
  readonly pendingActionObserved: boolean;

  constructor(message: string, pendingActionObserved: boolean) {
    super(message);
    this.name = "InvestigationExecutionError";
    this.pendingActionObserved = pendingActionObserved;
  }
}

export interface TrueForgeRuntime {
  executeBaseline(
    request: BaselineExecutionRequest,
  ): Promise<BaselineExecutionEvidence>;
  executeControl?: (
    request: BaselineExecutionRequest,
  ) => Promise<BaselineExecutionEvidence>;
  executeSmoke(options?: {
    signal?: AbortSignal;
  }): Promise<RuntimeSmokeEvidence>;
  executeInvestigation?: (
    request: InvestigationExecutionRequest,
  ) => Promise<InvestigationExecutionEvidence>;
  executeReplay?: (
    request: BaselineExecutionRequest,
  ) => Promise<BaselineExecutionEvidence>;
  resolvePolicyAction?: (
    request: PolicyActionResolutionRequest,
  ) => Promise<PolicyActionResolution>;
}
