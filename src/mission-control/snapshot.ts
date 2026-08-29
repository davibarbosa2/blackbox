import { z } from "zod";

import {
  baselineEvidenceBundleSchema,
  type BaselineEvidenceBundle,
  type EvidenceRecord,
  type EvidenceRunRead,
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

const approvalSchema = policyPatchDryRunSchema.extend({
  evidenceJustification: evidenceJustificationSchema,
  pendingDecision: pendingPolicyDecisionSchema,
});

export const missionControlSnapshotSchema = z.strictObject({
  activity: z.array(activitySchema),
  approval: approvalSchema.nullable(),
  baseline: baselineSummarySchema.nullable(),
  comparison: z.null(),
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
});

export type MissionControlSnapshot = z.infer<
  typeof missionControlSnapshotSchema
>;

export function createMissionControlSnapshot(
  run: EvidenceRunRead | undefined,
  incident: DurableIncidentRead | undefined,
  baselineRunning: boolean,
  decisionPending: boolean,
): MissionControlSnapshot {
  const baseline = readBaselineBundle(run);
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
  const failure = readFailure(run, incident);

  return missionControlSnapshotSchema.parse({
    activity: [
      ...timelineActivity(run?.timeline ?? [], reference),
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
    comparison: null,
    decisionPending,
    failure,
    incident:
      incident === undefined
        ? run === undefined
          ? null
          : { id: run.manifest.incidentId, status: "OPEN" }
        : { id: incident.incidentId, status: incident.incidentStatus },
    phase: phaseForStatus(status),
    status,
  });
}

function readBaselineBundle(
  run: EvidenceRunRead | undefined,
): BaselineEvidenceBundle | undefined {
  if (run?.bundle?.manifest.kind !== "baseline") return undefined;
  return baselineEvidenceBundleSchema.parse(run.bundle);
}

function evidenceReference(
  bundle: BaselineEvidenceBundle | undefined,
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
      title: "Baseline Evidence Bundle finalized",
    });
  }
  return activity;
}

function activityFromRecord(
  record: EvidenceRecord,
  evidence: z.infer<typeof evidenceReferenceSchema> | null,
): z.infer<typeof activitySchema> | undefined {
  if (record.type === "tool.called") {
    return {
      detail: "Observed in the finalized TrueForge event sequence.",
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

function readFailure(
  run: EvidenceRunRead | undefined,
  incident: DurableIncidentRead | undefined,
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
