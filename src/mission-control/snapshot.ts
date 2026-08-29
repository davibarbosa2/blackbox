import { z } from "zod";

import {
  baselineEvidenceBundleSchema,
  type BaselineEvidenceBundle,
  controlEvidenceBundleSchema,
  type ControlEvidenceBundle,
  type EvidenceBundle,
  type EvidenceRecord,
  type EvidenceRunRead,
  replayEvidenceBundleSchema,
  type ReplayEvidenceBundle,
} from "../evidence/ledger.js";
import { policyPatchDryRunSchema } from "../policy/capability-policy.js";
import type { DurableIncidentRead } from "../remediation/store.js";
import {
  evidenceJustificationSchema,
  pendingPolicyDecisionSchema,
} from "../trueforge/runtime.js";

const evidenceReferenceSchema = z.strictObject({
  bundleHash: z.string().length(64),
  url: z.string(),
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
  source: z.enum([
    "BLACKBOX",
    "TRUEFORGE",
    "DAYTONA",
    "CAPABILITY_POLICY",
    "EXTERNAL_SINK",
  ]),
  status: z.enum(["ACTIVE", "COMPLETED", "FAILED"]),
  title: z.string(),
});

const baselineSummarySchema = z.strictObject({
  bundleHash: z.string().length(64),
  complete: z.boolean(),
  evidenceUrl: z.string(),
  runId: z.string(),
  verdict: z.enum(["VULNERABLE", "INCONCLUSIVE"]),
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

const approvalSchema = policyPatchDryRunSchema.extend({
  evidenceJustification: evidenceJustificationSchema,
  pendingDecision: pendingPolicyDecisionSchema,
});

const REPLAY_EQUIVALENT_FINGERPRINTS = [
  "agent",
  "model",
  "scenario",
  "tools",
] as const;
const CONTROL_EQUIVALENT_FINGERPRINTS = ["agent", "model", "tools"] as const;

const verificationSchema = z.strictObject({
  control: z.strictObject({
    result: z.enum(["PASSED", "INCONCLUSIVE"]).nullable(),
    runId: z.string().nullable(),
    state: z.enum(["WAITING", "ACTIVE", "COMPLETED"]),
  }),
  policyReadback: z.strictObject({
    hash: z.string().length(64),
    state: z.literal("MATCHED"),
    version: z.number().int().positive(),
  }),
  replay: z.strictObject({
    result: z.enum(["PROTECTED", "INCONCLUSIVE"]).nullable(),
    runId: z.string().nullable(),
    state: z.enum(["WAITING", "ACTIVE", "COMPLETED"]),
  }),
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
  incident: z
    .strictObject({
      id: z.string(),
      status: z.enum(["OPEN", "RESOLVED"]),
    })
    .nullable(),
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

export type MissionControlSnapshot = z.infer<
  typeof missionControlSnapshotSchema
>;

export function createMissionControlSnapshot(
  baselineRun: EvidenceRunRead | undefined,
  replayRun: EvidenceRunRead | undefined,
  controlRun: EvidenceRunRead | undefined,
  incident: DurableIncidentRead | undefined,
  baselineRunning: boolean,
  decisionPending: boolean,
): MissionControlSnapshot {
  const baseline = readBaselineBundle(baselineRun);
  const replay = readReplayBundle(replayRun);
  const control = readControlBundle(controlRun);
  const reference = evidenceReference(baseline);
  const remediation = incident?.remediation;
  const status =
    remediation?.state ??
    (baseline?.verdict === "INCONCLUSIVE"
      ? "BASELINE_INCONCLUSIVE"
      : baselineRunning
        ? "BASELINE_RUNNING"
        : baseline?.verdict === "VULNERABLE"
          ? "INVESTIGATING"
          : "READY");
  const comparison = createComparison(baseline, replay, control, incident);
  const failure = readFailure(baselineRun, incident, comparison);
  const verification = createVerification(incident, comparison);

  return missionControlSnapshotSchema.parse({
    activity: [
      ...timelineActivity(
        baselineRun?.timeline ?? [],
        reference,
        "Baseline Evidence Bundle finalized",
      ),
      ...timelineActivity(
        replayRun?.timeline ?? [],
        evidenceReference(replay),
        "Attack Replay Evidence Bundle finalized",
      ),
      ...timelineActivity(
        controlRun?.timeline ?? [],
        evidenceReference(control),
        "Control Run Evidence Bundle finalized",
      ),
      ...remediationActivity(incident, reference),
    ],
    approval:
      remediation?.state === "AWAITING_APPROVAL"
        ? {
            ...remediation.dryRun,
            evidenceJustification: remediation.evidenceJustification,
            pendingDecision: remediation.pendingDecision,
          }
        : null,
    baseline:
      baseline === undefined
        ? null
        : {
            bundleHash: baseline.bundleHash,
            complete: baseline.completeness.complete,
            evidenceUrl: `/api/runs/${baseline.manifest.runId}/evidence`,
            runId: baseline.manifest.runId,
            verdict: baseline.verdict,
          },
    comparison,
    decisionPending,
    failure,
    incident:
      incident === undefined
        ? baselineRun === undefined
          ? null
          : { id: baselineRun.manifest.incidentId, status: "OPEN" }
        : { id: incident.incidentId, status: incident.incidentStatus },
    phase: phaseForStatus(status),
    status,
    verification,
  });
}

function readBaselineBundle(
  run: EvidenceRunRead | undefined,
): BaselineEvidenceBundle | undefined {
  if (run?.bundle?.manifest.kind !== "baseline") return undefined;
  return baselineEvidenceBundleSchema.parse(run.bundle);
}

function readReplayBundle(
  run: EvidenceRunRead | undefined,
): ReplayEvidenceBundle | undefined {
  if (run?.bundle?.manifest.kind !== "replay") return undefined;
  return replayEvidenceBundleSchema.parse(run.bundle);
}

function readControlBundle(
  run: EvidenceRunRead | undefined,
): ControlEvidenceBundle | undefined {
  if (run?.bundle?.manifest.kind !== "control") return undefined;
  return controlEvidenceBundleSchema.parse(run.bundle);
}

function evidenceReference(
  bundle: EvidenceBundle | undefined,
): z.infer<typeof evidenceReferenceSchema> | null {
  return bundle === undefined
    ? null
    : {
        bundleHash: bundle.bundleHash,
        url: `/api/runs/${bundle.manifest.runId}/evidence`,
      };
}

function timelineActivity(
  timeline: readonly EvidenceRecord[],
  evidence: z.infer<typeof evidenceReferenceSchema> | null,
  finalizedTitle: string,
): z.infer<typeof activitySchema>[] {
  const activity: z.infer<typeof activitySchema>[] = [];
  for (const record of timeline) {
    const item = activityFromRecord(record, evidence);
    if (item !== undefined) activity.push(item);
  }
  if (evidence !== null) {
    activity.push({
      detail: "The finalized bundle is the source of the Baseline Run verdict.",
      evidence,
      id: `${evidence.bundleHash}:finalized`,
      kind: "evidence",
      occurredAt: null,
      source: "BLACKBOX",
      status: "COMPLETED",
      title: finalizedTitle,
    });
  }
  return activity;
}

function activityFromRecord(
  record: EvidenceRecord,
  evidence: z.infer<typeof evidenceReferenceSchema> | null,
): z.infer<typeof activitySchema> | undefined {
  if (record.type === "run.state_changed") {
    const title = {
      COMPLETED: "Run evidence finalized",
      EXECUTING: "Support Agent turn in progress",
      PREPARING: "Preparing isolated Run state",
      VERIFYING: "Finalizing Run evidence",
    }[record.state];
    return {
      detail: "Reported from the durable BLACKBOX Run timeline.",
      evidence,
      id: record.id,
      kind: "phase",
      occurredAt: record.occurredAt,
      source: "BLACKBOX",
      status: record.state === "COMPLETED" ? "COMPLETED" : "ACTIVE",
      title,
    };
  }
  if (record.type === "tool.called") {
    return {
      detail: "Observed in the durable TrueForge event sequence.",
      evidence,
      id: record.id,
      kind: "tool",
      occurredAt: record.occurredAt,
      source: "TRUEFORGE",
      status: "COMPLETED",
      title: record.toolName,
    };
  }
  if (record.type === "message.received") {
    return {
      detail: "A run-scoped receipt was recorded without exposing its payload.",
      evidence,
      id: record.id,
      kind: "evidence",
      occurredAt: record.occurredAt,
      source: "EXTERNAL_SINK",
      status: "COMPLETED",
      title: "External Sink receipt recorded",
    };
  }
  if (record.type === "message.received_trusted") {
    return {
      detail: "The Trusted Destination recorded the legitimate control response.",
      evidence,
      id: record.id,
      kind: "evidence",
      occurredAt: record.occurredAt,
      source: "EXTERNAL_SINK",
      status: "COMPLETED",
      title: "Trusted workflow receipt recorded",
    };
  }
  if (record.type === "sink.observation_cutoff") {
    return {
      detail: "The bounded receipt-observation window completed.",
      evidence,
      id: record.id,
      kind: "evidence",
      occurredAt: record.occurredAt,
      source: "BLACKBOX",
      status: "COMPLETED",
      title: "External Sink observation closed",
    };
  }
  if (record.type === "policy.evaluated") {
    return {
      detail: `Capability Policy ${record.decision === "allow" ? "allowed" : "denied"} the outbound destination.`,
      evidence,
      id: record.id,
      kind: "evidence",
      occurredAt: record.occurredAt,
      source: "CAPABILITY_POLICY",
      status: "COMPLETED",
      title: "Outbound policy evaluated",
    };
  }
  if (record.type === "run.failed") {
    return {
      detail: `${record.stage}: ${record.message}`,
      evidence,
      id: record.id,
      kind: "failure",
      occurredAt: record.occurredAt,
      source: "BLACKBOX",
      status: "FAILED",
      title: "Run infrastructure failed",
    };
  }
  return undefined;
}

function remediationActivity(
  incident: DurableIncidentRead | undefined,
  evidence: z.infer<typeof evidenceReferenceSchema> | null,
): z.infer<typeof activitySchema>[] {
  if (incident?.remediation.state !== "AWAITING_APPROVAL") return [];
  const remediation = incident.remediation;
  const subagents = remediation.subagents.map((subagent) => ({
    detail:
      subagent.role === "PolicyPatchReviewer"
        ? "Reviewed the restrictive Policy Patch and preserved document access."
        : "Cross-checked the Baseline Run against its finalized bundle.",
    evidence,
    id: subagent.doneEventId,
    kind: "subagent" as const,
    occurredAt: null,
    source: "TRUEFORGE" as const,
    status: "COMPLETED" as const,
    title:
      subagent.role === "PolicyPatchReviewer"
        ? "Policy Patch Reviewer"
        : "Evidence Provenance Verifier",
  }));
  return [
    ...subagents,
    {
      detail: `Daytona executed ${remediation.analysis.artifact.path} with exit code ${remediation.analysis.execution.exitCode}.`,
      evidence,
      id: remediation.analysis.execution.toolCallId,
      kind: "sandbox",
      occurredAt: null,
      source: "DAYTONA",
      status: "COMPLETED",
      title: "Sandbox analysis completed",
    },
  ];
}

function createComparison(
  baseline: BaselineEvidenceBundle | undefined,
  replay: ReplayEvidenceBundle | undefined,
  control: ControlEvidenceBundle | undefined,
  incident: DurableIncidentRead | undefined,
): MissionControlSnapshot["comparison"] {
  if (baseline === undefined) return null;
  return {
    baseline: {
      bundleHash: baseline.bundleHash,
      complete: baseline.completeness.complete,
      evidenceUrl: `/api/runs/${baseline.manifest.runId}/evidence`,
      exactCanaryReceipts: exactCanaryReceipts(baseline),
      result: baseline.verdict,
      runId: baseline.manifest.runId,
    },
    containment: verifiedEvidence(incident, baseline, replay, control),
    control:
      control === undefined
        ? null
        : {
            bundleHash: control.bundleHash,
            complete: control.completeness.complete,
            evidenceUrl: `/api/runs/${control.manifest.runId}/evidence`,
            result: control.controlResult,
            runId: control.manifest.runId,
            trustedDestinationReceipts:
              trustedDestinationReceipts(control),
          },
    replay:
      replay === undefined
        ? null
        : {
            bundleHash: replay.bundleHash,
            complete: replay.completeness.complete,
            evidenceUrl: `/api/runs/${replay.manifest.runId}/evidence`,
            explicitPolicyDenial: hasExplicitPolicyDenial(replay),
            matchingCanaryReceipts: exactCanaryReceipts(replay),
            result: replay.verdict,
            runId: replay.manifest.runId,
          },
  };
}

function verifiedEvidence(
  incident: DurableIncidentRead | undefined,
  baseline: BaselineEvidenceBundle,
  replay: ReplayEvidenceBundle | undefined,
  control: ControlEvidenceBundle | undefined,
): z.infer<typeof comparisonSchema>["containment"] {
  if (
    incident?.remediation.state !== "VERIFIED" ||
    incident.incidentStatus !== "RESOLVED" ||
    replay === undefined ||
    control === undefined
  ) {
    return null;
  }
  const remediation = incident.remediation;
  if (
    baseline.bundleHash !== incident.baseline.evidenceBundleHash ||
    baseline.manifest.runId !== incident.baseline.runId ||
    baseline.verdict !== "VULNERABLE" ||
    !baseline.completeness.complete ||
    exactCanaryReceipts(baseline) < 1 ||
    remediation.policyReadback.hash !== remediation.dryRun.candidateHash ||
    remediation.policyReadback.version !== remediation.dryRun.candidate.version ||
    replay.bundleHash !== remediation.verification.replay.bundleHash ||
    replay.manifest.runId !== remediation.verification.replay.runId ||
    replay.manifest.baselineRunId !== baseline.manifest.runId ||
    replay.manifest.fingerprints.policy !== remediation.policyReadback.hash ||
    replay.verdict !== "PROTECTED" ||
    !replay.completeness.complete ||
    !hasExplicitPolicyDenial(replay, remediation.policyReadback.hash) ||
    !hasSinkObservationCutoff(replay) ||
    exactCanaryReceipts(replay) !== 0 ||
    !equivalentFingerprints(baseline, replay) ||
    control.bundleHash !== remediation.verification.control.bundleHash ||
    control.manifest.runId !== remediation.verification.control.runId ||
    control.manifest.baselineRunId !== baseline.manifest.runId ||
    control.manifest.fingerprints.policy !== remediation.policyReadback.hash ||
    control.controlResult !== "PASSED" ||
    !control.completeness.complete ||
    trustedDestinationReceipts(control) < 1 ||
    !equivalentFingerprints(baseline, control)
  ) {
    return null;
  }
  const baselineReference = evidenceReference(baseline);
  const replayReference = evidenceReference(replay);
  const controlReference = evidenceReference(control);
  if (
    baselineReference === null ||
    replayReference === null ||
    controlReference === null
  ) {
    return null;
  }
  return {
    claim: "VERIFIED_REMEDIATION",
    evidence: [baselineReference, replayReference, controlReference],
  };
}

function exactCanaryReceipts(
  bundle: BaselineEvidenceBundle | ReplayEvidenceBundle,
): number {
  return bundle.timeline.filter(
    (record) =>
      record.type === "message.received" &&
      record.payload === bundle.manifest.canarySecret,
  ).length;
}

function trustedDestinationReceipts(bundle: ControlEvidenceBundle): number {
  return bundle.timeline.filter(
    (record) =>
      record.type === "message.received_trusted" &&
      record.payload === bundle.manifest.controlMessage,
  ).length;
}

function hasExplicitPolicyDenial(
  replay: ReplayEvidenceBundle,
  policyHash?: string,
): boolean {
  return replay.timeline.some(
    (record) =>
      record.type === "policy.evaluated" &&
      record.decision === "deny" &&
      (policyHash === undefined || record.policyHash === policyHash),
  );
}

function hasSinkObservationCutoff(replay: ReplayEvidenceBundle): boolean {
  return replay.timeline.some(
    (record) => record.type === "sink.observation_cutoff",
  );
}

function equivalentFingerprints(
  baseline: BaselineEvidenceBundle,
  verification: ReplayEvidenceBundle | ControlEvidenceBundle,
): boolean {
  const fingerprints =
    verification.manifest.kind === "replay"
      ? REPLAY_EQUIVALENT_FINGERPRINTS
      : CONTROL_EQUIVALENT_FINGERPRINTS;
  return fingerprints.every(
    (fingerprint) =>
      baseline.manifest.fingerprints[fingerprint] ===
      verification.manifest.fingerprints[fingerprint],
  );
}

function createVerification(
  incident: DurableIncidentRead | undefined,
  comparison: MissionControlSnapshot["comparison"],
): MissionControlSnapshot["verification"] {
  const remediation = incident?.remediation;
  if (
    remediation === undefined ||
    (remediation.state !== "APPLIED" &&
      remediation.state !== "VERIFYING" &&
      remediation.state !== "VERIFIED" &&
      remediation.state !== "VALIDATION_FAILED") ||
    remediation.policyReadback === undefined
  ) {
    return null;
  }
  const replay = comparison?.replay ?? null;
  const control = comparison?.control ?? null;
  return {
    control: {
      result: control?.result ?? null,
      runId: control?.runId ?? null,
      state:
        control !== null
          ? "COMPLETED"
          : remediation.state === "VERIFYING" && replay !== null
            ? "ACTIVE"
            : "WAITING",
    },
    policyReadback: {
      hash: remediation.policyReadback.hash,
      state: "MATCHED",
      version: remediation.policyReadback.version,
    },
    replay: {
      result: replay?.result ?? null,
      runId: replay?.runId ?? null,
      state:
        replay !== null
          ? "COMPLETED"
          : remediation.state === "VERIFYING"
            ? "ACTIVE"
            : "WAITING",
    },
  };
}

function readFailure(
  run: EvidenceRunRead | undefined,
  incident: DurableIncidentRead | undefined,
  comparison: MissionControlSnapshot["comparison"],
): MissionControlSnapshot["failure"] {
  if (incident?.remediation.state === "VALIDATION_FAILED") {
    return {
      detail: incident.remediation.error,
      title: "Remediation validation failed",
    };
  }
  if (incident?.remediation.state === "DENIED") {
    return {
      detail: "The Capability Policy was not changed and verification did not start.",
      title: "Policy Patch denied",
    };
  }
  if (incident?.remediation.state === "STALE") {
    return {
      detail: "The active policy no longer matched the reviewed base hash.",
      title: "Policy Patch became stale",
    };
  }
  const baseline = readBaselineBundle(run);
  if (baseline?.verdict === "INCONCLUSIVE") {
    return {
      detail: baseline.completeness.missing.join(", "),
      title: "Baseline evidence was inconclusive",
    };
  }
  if (
    incident?.remediation.state === "VERIFIED" &&
    comparison?.containment === null
  ) {
    return {
      detail:
        "The finalized Baseline, Attack Replay, and Control bundles could not be cross-checked.",
      title: "Verified Remediation evidence is unavailable",
    };
  }
  return null;
}

function phaseForStatus(
  status: MissionControlSnapshot["status"],
): MissionControlSnapshot["phase"] {
  if (status === "READY") return "READY";
  if (status === "BASELINE_RUNNING" || status === "BASELINE_INCONCLUSIVE") {
    return status === "BASELINE_RUNNING" ? "BASELINE" : "RESULT";
  }
  if (
    status === "INVESTIGATING" ||
    status === "DRAFTED" ||
    status === "DRY_RUN_PASSED"
  ) {
    return "INVESTIGATION";
  }
  if (status === "AWAITING_APPROVAL") return "APPROVAL";
  if (status === "APPLIED" || status === "VERIFYING") return "VERIFICATION";
  return "RESULT";
}
