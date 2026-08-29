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
import type { DurableIncidentRead } from "../remediation/store.js";
import type { InvestigationMilestone } from "../trueforge/runtime.js";
import {
  type EvidenceReference,
  type MissionControlActivity,
  type MissionControlComparison,
  type MissionControlSnapshot,
  missionControlSnapshotSchema,
} from "./schema.js";

const REPLAY_EQUIVALENT_FINGERPRINTS = [
  "agent",
  "model",
  "scenario",
  "tools",
] as const;
const CONTROL_EQUIVALENT_FINGERPRINTS = ["agent", "model", "tools"] as const;

export function createMissionControlSnapshot(
  baselineRun: EvidenceRunRead | undefined,
  replayRun: EvidenceRunRead | undefined,
  controlRun: EvidenceRunRead | undefined,
  incident: DurableIncidentRead | undefined,
  baselineRunning: boolean,
  decisionPending: boolean,
  trueForgeUrl?: string,
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
  const trueForgeSessionId = readTrueForgeSessionId(incident);

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
      ...remediationActivity(incident),
    ],
    approval:
      remediation?.state === "AWAITING_APPROVAL"
        ? {
            ...remediation.dryRun,
            evidenceJustification: {
              bundleHash: remediation.evidenceJustification.bundleHash,
              runId: remediation.evidenceJustification.runId,
              summary:
                "The finalized Baseline Evidence Bundle proves an exact run-scoped Canary receipt at the controlled External Sink through send_external_message.",
            },
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
    integrations:
      trueForgeUrl === undefined
        ? undefined
        : { trueForgeSessionId, trueForgeUrl },
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

function readTrueForgeSessionId(
  incident: DurableIncidentRead | undefined,
): string | null {
  const remediation = incident?.remediation;
  if (remediation === undefined) return null;
  if (remediation.investigationProgress !== undefined) {
    return remediation.investigationProgress.sessionId;
  }
  if (
    "pendingDecision" in remediation &&
    remediation.pendingDecision !== undefined
  ) {
    return remediation.pendingDecision.sessionId;
  }
  if ("decision" in remediation && remediation.decision !== undefined) {
    return remediation.decision.sessionId;
  }
  return null;
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
): EvidenceReference | null {
  return bundle === undefined
    ? null
    : {
        bundleHash: bundle.bundleHash,
        url: `/api/runs/${bundle.manifest.runId}/evidence`,
      };
}

function timelineActivity(
  timeline: readonly EvidenceRecord[],
  evidence: EvidenceReference | null,
  finalizedTitle: string,
): MissionControlActivity[] {
  const activity: MissionControlActivity[] = [];
  const currentStateId = timeline
    .filter((record) => record.type === "run.state_changed")
    .at(-1)?.id;
  for (const record of timeline) {
    const item = activityFromRecord(
      record,
      evidence,
      record.id === currentStateId,
    );
    if (item !== undefined) activity.push(item);
  }
  if (evidence !== null) {
    activity.push({
      detail: "This finalized bundle is the source of the displayed Run result.",
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
  evidence: EvidenceReference | null,
  currentState: boolean,
): MissionControlActivity | undefined {
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
      status:
        record.state === "COMPLETED" || !currentState
          ? "COMPLETED"
          : "ACTIVE",
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
      source: "TRUSTED_DESTINATION",
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
      detail: `${record.stage}: the Run could not complete at this infrastructure boundary.`,
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
): MissionControlActivity[] {
  const remediation = incident?.remediation;
  if (remediation === undefined) return [];
  const progress = remediation.investigationProgress?.milestones ?? [];
  const progressKinds = new Set(progress.map((milestone) => milestone.kind));
  const streamed = progress.map((milestone) =>
    activityFromInvestigationMilestone(
      milestone,
      remediation.state,
      progressKinds,
      "analysis" in remediation && remediation.analysis !== undefined,
    ),
  );
  const decision = "decision" in remediation ? remediation.decision : undefined;
  const decisionActivity: MissionControlActivity[] =
    decision === undefined
      ? []
      : [
          {
            detail:
              decision.decision === "allow"
                ? "The exact pending TrueForge Policy Patch action was approved by a human."
                : "The exact pending TrueForge Policy Patch action was declined by a human.",
            evidence: null,
            id: `${decision.callId}:human-decision:${decision.decision}`,
            kind: "phase",
            occurredAt: decision.decidedAt,
            source: "BLACKBOX",
            status: "COMPLETED",
            title:
              decision.decision === "allow"
                ? "Policy Patch approved by human"
                : "Policy Patch declined by human",
          },
        ];
  if (
    !("analysis" in remediation) ||
    !("subagents" in remediation) ||
    remediation.analysis === undefined ||
    remediation.subagents === undefined
  ) {
    return [...streamed, ...decisionActivity];
  }
  const subagents = remediation.subagents.map((subagent) => ({
    detail: "Focused review completion is retained in durable Incident state.",
    evidence: null,
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
  const finalized: MissionControlActivity[] = [
    ...subagents,
    {
      detail: `Durable Incident state records a Daytona exit code of ${remediation.analysis.execution.exitCode}.`,
      evidence: null,
      id: remediation.analysis.execution.toolCallId,
      kind: "sandbox",
      occurredAt: null,
      source: "DAYTONA",
      status: "COMPLETED",
      title: "Sandbox analysis completed",
    },
  ];
  return [
    ...new Map(
      [...streamed, ...finalized, ...decisionActivity].map((activity) => [activity.id, activity]),
    ).values(),
  ];
}

function activityFromInvestigationMilestone(
  milestone: InvestigationMilestone,
  remediationState: DurableIncidentRead["remediation"]["state"],
  progressKinds: ReadonlySet<InvestigationMilestone["kind"]>,
  analysisComplete: boolean,
): MissionControlActivity {
  const completed =
    remediationState !== "INVESTIGATING" ||
    milestone.kind === "INVESTIGATOR_MCP_INITIALIZED" ||
    milestone.kind === "POLICY_REVIEW_COMPLETED" ||
    milestone.kind === "EVIDENCE_REVIEW_COMPLETED" ||
    milestone.kind === "POLICY_ACTION_OBSERVED" ||
    (milestone.kind === "POLICY_REVIEW_STARTED" &&
      progressKinds.has("POLICY_REVIEW_COMPLETED")) ||
    (milestone.kind === "EVIDENCE_REVIEW_STARTED" &&
      progressKinds.has("EVIDENCE_REVIEW_COMPLETED")) ||
    (milestone.kind === "ANALYSIS_SANDBOX_CREATED" && analysisComplete);
  const display = {
    ANALYSIS_SANDBOX_CREATED: {
      kind: "sandbox" as const,
      source: "DAYTONA" as const,
      title: "Daytona sandbox analysis running",
    },
    EVIDENCE_REVIEW_COMPLETED: {
      kind: "subagent" as const,
      source: "TRUEFORGE" as const,
      title: "Evidence Provenance Verifier",
    },
    EVIDENCE_REVIEW_STARTED: {
      kind: "subagent" as const,
      source: "TRUEFORGE" as const,
      title: "Evidence provenance review started",
    },
    INVESTIGATOR_MCP_INITIALIZED: {
      kind: "phase" as const,
      source: "TRUEFORGE" as const,
      title: "Incident evidence connected",
    },
    POLICY_ACTION_OBSERVED: {
      kind: "phase" as const,
      source: "TRUEFORGE" as const,
      title: "Policy Patch proposal observed",
    },
    POLICY_REVIEW_COMPLETED: {
      kind: "subagent" as const,
      source: "TRUEFORGE" as const,
      title: "Policy Patch Reviewer",
    },
    POLICY_REVIEW_STARTED: {
      kind: "subagent" as const,
      source: "TRUEFORGE" as const,
      title: "Policy Patch review started",
    },
    TURN_STARTED: {
      kind: "phase" as const,
      source: "TRUEFORGE" as const,
      title: "TrueForge investigation started",
    },
  }[milestone.kind];
  return {
    detail:
      "Sanitized progress derived from durable TrueForge stream metadata; no prompt, secret, or reasoning content is retained.",
    evidence: null,
    id: milestone.sourceEventId,
    kind: display.kind,
    occurredAt: milestone.occurredAt,
    source: display.source,
    status: completed ? "COMPLETED" : "ACTIVE",
    title: display.title,
  };
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
): MissionControlComparison["containment"] {
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
          ? control.result === "PASSED" && control.complete
            ? "COMPLETED"
            : "INCONCLUSIVE"
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
          ? replay.result === "PROTECTED" && replay.complete
            ? "COMPLETED"
            : "INCONCLUSIVE"
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
      detail: safeValidationFailure(incident.remediation.error, comparison),
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

function safeValidationFailure(
  error: string,
  comparison: MissionControlSnapshot["comparison"],
): string {
  const replayInconclusive =
    comparison?.replay?.result === "INCONCLUSIVE" ||
    comparison?.replay?.complete === false;
  const controlInconclusive =
    comparison?.control?.result === "INCONCLUSIVE" ||
    comparison?.control?.complete === false;
  if (replayInconclusive && controlInconclusive) {
    return "The automatic Attack Replay and legitimate Control Run did not complete their evidence gates. Containment is withheld; inspect the server log for the private cause.";
  }
  if (replayInconclusive) {
    return "The automatic Attack Replay did not complete its evidence gates. Containment is withheld; inspect the server log for the private cause.";
  }
  if (controlInconclusive) {
    return "The legitimate Control Run did not complete its evidence gates. Containment is withheld; inspect the server log for the private cause.";
  }
  const category = error.toLowerCase();
  if (category.includes("replay")) {
    return "The automatic Attack Replay did not complete its evidence gates. Containment is withheld; inspect the server log for the private cause.";
  }
  if (category.includes("control")) {
    return "The legitimate Control Run did not complete its evidence gates. Containment is withheld; inspect the server log for the private cause.";
  }
  if (
    category.includes("policy") ||
    category.includes("patch") ||
    category.includes("application")
  ) {
    return "The approved Capability Policy change could not be validated. Containment is withheld; inspect the server log for the private cause.";
  }
  if (
    category.includes("trueforge") ||
    category.includes("investigation")
  ) {
    return "TrueForge did not complete the investigation boundary. No policy success is implied; inspect the server log for the private cause.";
  }
  return "Automatic Remediation validation did not complete. Containment is withheld; inspect the server log for the private cause.";
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
