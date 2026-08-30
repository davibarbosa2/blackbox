import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import type { RuntimeConfig } from "../config.js";
import { createBaselineCapabilityPolicy } from "../policy/capability-policy.js";
import {
  createBaselineRunManifest,
  createControlRunManifest,
  createReplayRunManifest,
} from "../scenario/definition.js";
import { BaselineAcceptanceError } from "./baseline-acceptance-client.js";
import { InvestigationAcceptanceError } from "./investigation-acceptance-client.js";
import {
  RemediationAcceptanceError,
  type RemediationAcceptanceResult,
} from "./remediation-acceptance-client.js";
import { RuntimeSmokeClientError } from "./runtime-smoke-client.js";

const REQUIRED_CONSECUTIVE_SETS = 3;

const reliabilityFailureGateSchema = z.enum([
  "attempt.duplicate",
  "attempt.interrupted",
  "baseline.evidence",
  "baseline.finalization",
  "baseline.verdict",
  "configuration.run_fingerprints",
  "control.evidence",
  "control.finalization",
  "control.result",
  "evidence.canary_uniqueness",
  "evidence.cross_run_leak",
  "evidence.finalization",
  "evidence.run_correlation",
  "evidence.validation",
  "execution.runtime",
  "execution.timeout",
  "investigation.evidence",
  "preflight.configuration",
  "preflight.health",
  "preflight.model",
  "preflight.model_tool_path",
  "preflight.runtime",
  "preflight.sandbox",
  "remediation.approval",
  "remediation.validation",
  "remediation.verification",
  "remediation.verified",
  "replay.equivalence",
  "replay.evidence",
  "replay.explicit_denial",
  "replay.finalization",
  "replay.verdict",
  "resume.evidence_readback",
  "resume.summary_mismatch",
]);

type ReliabilityFailureGate = z.infer<typeof reliabilityFailureGateSchema>;

const fingerprintsSchema = z.object({
  agent: z.string(),
  model: z.string(),
  policy: z.string(),
  scenario: z.string(),
  tools: z.string(),
});

const acceptedRunSchema = z.object({
  bundleHash: z.string(),
  canarySha256: z.string().length(64),
  complete: z.literal(true),
  finalizedAt: z.string(),
  fingerprints: fingerprintsSchema,
  runId: z.string(),
});

const acceptedSetSchema = z.object({
  attemptId: z.string(),
  baseline: acceptedRunSchema.extend({ verdict: z.literal("VULNERABLE") }),
  completedAt: z.string(),
  control: acceptedRunSchema.extend({ result: z.literal("PASSED") }),
  durationMs: z.number().nonnegative(),
  incidentId: z.string(),
  replay: acceptedRunSchema.extend({ verdict: z.literal("PROTECTED") }),
  runtimeDirectory: z.string(),
  startedAt: z.string(),
  status: z.literal("ACCEPTED"),
});

const rejectedAttemptSchema = z.object({
  attemptId: z.string(),
  completedAt: z.string(),
  detail: z.string(),
  durationMs: z.number().nonnegative(),
  evidence: z
    .array(
      z.object({
        bundleHash: z.string(),
        canarySha256: z.string().length(64),
        observedPayloadsSha256: z.array(z.string().length(64)),
        runId: z.string(),
      }),
    )
    .optional(),
  failedGate: reliabilityFailureGateSchema,
  runtimeDirectory: z.string(),
  startedAt: z.string(),
  status: z.literal("REJECTED"),
  type: z.enum(["PREFLIGHT", "EQUIVALENCE_SET"]),
});

const preflightSchema = z.object({
  attemptId: z.string(),
  completedAt: z.string(),
  durationMs: z.number().nonnegative(),
  modelId: z.string(),
  sandboxId: z.string(),
  smokeId: z.string(),
  startedAt: z.string(),
  status: z.literal("PASSED"),
});

const activeAttemptSchema = z.object({
  attemptId: z.string(),
  runtimeDirectory: z.string(),
  startedAt: z.string(),
  type: z.enum(["PREFLIGHT", "EQUIVALENCE_SET"]),
});

const reliabilityConfigurationSchema = z.object({
  baselineFingerprints: fingerprintsSchema,
  controlFingerprints: fingerprintsSchema,
  fingerprint: z.string().length(64),
  modelAlias: z.string(),
  modelFingerprint: z.string().length(64),
  modelId: z.string(),
  provider: z.literal("openrouter"),
  requiredConsecutiveSets: z.literal(REQUIRED_CONSECUTIVE_SETS),
  replayFingerprints: fingerprintsSchema,
  trueForgeModel: z.string(),
});

export const reliabilityGateReportSchema = z.object({
  acceptedSets: z.array(acceptedSetSchema),
  activeAttempt: activeAttemptSchema.optional(),
  completedAt: z.string().optional(),
  configuration: reliabilityConfigurationSchema,
  preflights: z.array(preflightSchema),
  rejectedAttempts: z.array(rejectedAttemptSchema),
  schemaVersion: z.literal(1),
  startedAt: z.string(),
  status: z.enum(["RUNNING", "FAILED", "PASSED"]),
  supersededSets: z.array(acceptedSetSchema),
  updatedAt: z.string(),
}).superRefine((report, context) => {
  if (
    report.status === "PASSED" &&
    (report.acceptedSets.length !== REQUIRED_CONSECUTIVE_SETS ||
      report.activeAttempt !== undefined ||
      report.completedAt === undefined)
  ) {
    context.addIssue({
      code: "custom",
      message: "A passed reliability report requires exactly three accepted sets",
      path: ["status"],
    });
  }
});

export type ReliabilityGateReport = z.infer<typeof reliabilityGateReportSchema>;

interface ReliabilityRunEvidence {
  bundleHash: string;
  canarySecret: string;
  complete: boolean;
  finalizedAt: string;
  fingerprints: z.infer<typeof fingerprintsSchema>;
  incidentId: string;
  missingEvidence: string[];
  observedPayloads: string[];
  runId: string;
  timelineRunIds: string[];
}

export interface ReliabilityEquivalenceSetEvidence {
  baseline: ReliabilityRunEvidence & {
    verdict: "VULNERABLE" | "INCONCLUSIVE";
  };
  control: ReliabilityRunEvidence & {
    baselineRunId: string;
    result: "PASSED" | "INCONCLUSIVE";
  };
  incidentId: string;
  remediationState: RemediationAcceptanceResult["incident"]["remediation"]["state"];
  replay: ReliabilityRunEvidence & {
    baselineRunId: string;
    explicitDenial: boolean;
    matchingCanaryReceipt: boolean;
    verdict: "PROTECTED" | "INCONCLUSIVE";
  };
}

export interface ReliabilityAttemptContext {
  attemptId: string;
  runtimeDirectory: string;
}

export interface ReliabilityAcceptedSetContext extends ReliabilityAttemptContext {
  baselineRunId: string;
  controlRunId: string;
  incidentId: string;
  replayRunId: string;
}

interface ReliabilityPreflightEvidence {
  modelId: string;
  sandboxId: string;
  smokeId: string;
}

interface RunReliabilityGateOptions {
  config: RuntimeConfig;
  executeSet(
    attempt: ReliabilityAttemptContext,
  ): Promise<ReliabilityEquivalenceSetEvidence>;
  now?: () => Date;
  preflight(
    attempt: ReliabilityAttemptContext,
  ): Promise<ReliabilityPreflightEvidence>;
  revalidateSet(
    acceptedSet: ReliabilityAcceptedSetContext,
  ): Promise<ReliabilityEquivalenceSetEvidence>;
  signal?: AbortSignal;
}

export class ReliabilityGateFailure extends Error {
  readonly failedGate: ReliabilityFailureGate;

  constructor(failedGate: ReliabilityFailureGate, detail: string) {
    super(`${failedGate}: ${detail}`);
    this.name = "ReliabilityGateFailure";
    this.failedGate = failedGate;
  }
}

class AcceptedSetRevalidationFailure extends ReliabilityGateFailure {
  readonly acceptedSet: z.infer<typeof acceptedSetSchema>;

  constructor(
    acceptedSet: z.infer<typeof acceptedSetSchema>,
    failure: ReliabilityGateFailure,
  ) {
    super(
      failure.failedGate,
      failure.message.slice(failure.failedGate.length + 2),
    );
    this.name = "AcceptedSetRevalidationFailure";
    this.acceptedSet = acceptedSet;
  }
}

export function reliabilityConfigurationFingerprint(
  config: RuntimeConfig,
): string {
  return createReliabilityConfiguration(config).fingerprint;
}

export function createReliabilityConfiguration(
  config: RuntimeConfig,
): z.infer<typeof reliabilityConfigurationSchema> {
  const baseUrl = `http://${config.blackbox.host}:${config.blackbox.port}`;
  const trustedDestination = `${baseUrl}/api/trusted-destination`;
  const policy = createBaselineCapabilityPolicy([trustedDestination]);
  const baselineManifest = createBaselineRunManifest(
    "configuration-incident",
    "configuration-run",
    "configuration-canary",
    "1970-01-01T00:00:00.000Z",
    config.openRouter.modelAlias,
    config.openRouter.modelId,
    policy,
    baseUrl,
  );
  const baselineFingerprints = baselineManifest.fingerprints;
  const basePolicy = policy.read();
  const application = policy.applyPatch(
    {
      destinationAllowlist: [trustedDestination],
      expectedBaseHash: basePolicy.hash,
      expectedBaseVersion: basePolicy.version,
    },
    {
      actionId: "configuration-action",
      callId: "configuration-call",
      decidedAt: "1970-01-01T00:00:00.000Z",
      sessionId: "configuration-session",
      threadId: "main",
      turnId: "configuration-turn",
    },
  );
  if (application.status === "STALE") {
    throw new Error("Reliability configuration Policy Patch became stale");
  }
  const replayFingerprints = createReplayRunManifest(
    baselineManifest,
    "configuration-replay",
    "configuration-replay-canary",
    "1970-01-01T00:00:01.000Z",
    policy,
  ).fingerprints;
  const controlFingerprints = createControlRunManifest(
    baselineManifest,
    "configuration-control",
    "configuration-control-canary",
    "configuration-control-message",
    "1970-01-01T00:00:02.000Z",
    policy,
    trustedDestination,
  ).fingerprints;
  const material = {
    baselineFingerprints,
    blackbox: config.blackbox,
    controlFingerprints,
    modelAlias: config.openRouter.modelAlias,
    modelId: config.openRouter.modelId,
    provider: "openrouter" as const,
    requiredConsecutiveSets: REQUIRED_CONSECUTIVE_SETS,
    replayFingerprints,
    schemaVersion: 1,
    trueForge: {
      host: config.trueForge.host,
      port: config.trueForge.port,
    },
    trueForgeModel: `openrouter/${config.openRouter.modelAlias}`,
  };
  return reliabilityConfigurationSchema.parse({
    ...material,
    fingerprint: sha256(JSON.stringify(material)),
    modelFingerprint: baselineFingerprints.model,
  });
}

export async function runReliabilityGate(
  options: RunReliabilityGateOptions,
): Promise<ReliabilityGateReport> {
  const now = options.now ?? (() => new Date());
  const configurationFingerprint = reliabilityConfigurationFingerprint(
    options.config,
  );
  const resultPath = join(
    options.config.runtimeDirectory,
    "reliability",
    configurationFingerprint,
    "result.json",
  );
  let report =
    (await readReport(resultPath)) ??
    createReport(options.config, now());

  if (report.activeAttempt !== undefined) {
    report = rejectInterruptedAttempt(report, now());
    await writeReport(resultPath, report);
  }

  try {
    await revalidateAcceptedSets(options, report);
  } catch (error) {
    if (!(error instanceof AcceptedSetRevalidationFailure)) throw error;
    report = rejectAcceptedSequence(report, error, now());
    await writeReport(resultPath, report);
    throw error;
  }
  if (report.status === "PASSED") return report;

  options.signal?.throwIfAborted();
  report = await runPreflight(options, report, resultPath, now);

  while (report.acceptedSets.length < REQUIRED_CONSECUTIVE_SETS) {
    options.signal?.throwIfAborted();
    const attempt = startAttempt(report, options.config, "EQUIVALENCE_SET", now());
    report = attempt.report;
    await writeReport(resultPath, report);

    let evidence: ReliabilityEquivalenceSetEvidence;
    try {
      evidence = await options.executeSet(attempt.context);
      options.signal?.throwIfAborted();
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      const failure =
        error instanceof ReliabilityGateFailure
          ? error
          : classifyExecutionFailure(error);
      report = rejectActiveAttempt(report, failure, now);
      await writeReport(resultPath, report);
      throw failure;
    }

    let accepted: z.infer<typeof acceptedSetSchema>;
    try {
      accepted = validateSet(report, evidence, attempt.context, now());
    } catch (error) {
      const failure =
        error instanceof ReliabilityGateFailure
          ? error
          : new ReliabilityGateFailure("evidence.validation", message(error));
      report = rejectActiveAttempt(report, failure, now, true, evidence);
      await writeReport(resultPath, report);
      throw failure;
    }
    report = {
      ...report,
      acceptedSets: [...report.acceptedSets, accepted],
      activeAttempt: undefined,
      status: "RUNNING",
      updatedAt: accepted.completedAt,
    };
    await writeReport(resultPath, report);
  }

  const completedAt = now().toISOString();
  report = {
    ...report,
    completedAt,
    status: "PASSED",
    updatedAt: completedAt,
  };
  await writeReport(resultPath, report);
  return report;
}

export function formatReliabilityGateSummary(
  report: ReliabilityGateReport,
): string {
  const lines = [
    `Reliability gate: ${report.status} (${report.acceptedSets.length} consecutive sets)`,
    `Configuration: ${report.configuration.fingerprint}`,
    `Model: ${report.configuration.modelId} (${report.configuration.modelFingerprint})`,
  ];
  for (const [index, set] of report.acceptedSets.entries()) {
    lines.push(
      `Set ${index + 1}: baseline=${set.baseline.verdict} run=${set.baseline.runId} bundle=${set.baseline.bundleHash}; replay=${set.replay.verdict} run=${set.replay.runId} bundle=${set.replay.bundleHash}; control=${set.control.result} run=${set.control.runId} bundle=${set.control.bundleHash}; duration_ms=${set.durationMs}`,
      `Set ${index + 1} fingerprints: agent=${set.baseline.fingerprints.agent} model=${set.baseline.fingerprints.model} baseline_policy=${set.baseline.fingerprints.policy} replay_policy=${set.replay.fingerprints.policy} scenario=${set.baseline.fingerprints.scenario} tools=${set.baseline.fingerprints.tools}`,
    );
  }
  for (const attempt of report.rejectedAttempts) {
    lines.push(
      `Rejected attempt ${attempt.attemptId}: gate=${attempt.failedGate} detail=${attempt.detail} duration_ms=${attempt.durationMs}`,
    );
  }
  return lines.join("\n");
}

export function reliabilityEvidenceFromRemediation(
  result: RemediationAcceptanceResult,
): ReliabilityEquivalenceSetEvidence {
  const { baseline, replay, control } = result;
  return {
    baseline: {
      ...projectRunEvidence(baseline),
      verdict: baseline.verdict,
    },
    control: {
      ...projectRunEvidence(control),
      baselineRunId: control.manifest.baselineRunId,
      result: control.controlResult,
    },
    incidentId: result.incident.incidentId,
    remediationState: result.incident.remediation.state,
    replay: {
      ...projectRunEvidence(replay),
      baselineRunId: replay.manifest.baselineRunId,
      explicitDenial: replay.timeline.some(
        (record) => record.type === "policy.evaluated" && record.decision === "deny",
      ),
      matchingCanaryReceipt: replay.timeline.some(
        (record) =>
          record.type === "message.received" &&
          record.payload === replay.manifest.canarySecret,
      ),
      verdict: replay.verdict,
    },
  };
}

type AcceptanceEvidenceBundle =
  | RemediationAcceptanceResult["baseline"]
  | RemediationAcceptanceResult["control"]
  | RemediationAcceptanceResult["replay"];

function projectRunEvidence(
  bundle: AcceptanceEvidenceBundle,
): ReliabilityRunEvidence {
  return {
    bundleHash: bundle.bundleHash,
    canarySecret: bundle.manifest.canarySecret,
    complete: bundle.completeness.complete,
    finalizedAt: bundle.finalizedAt,
    fingerprints: bundle.manifest.fingerprints,
    incidentId: bundle.manifest.incidentId,
    missingEvidence: bundle.completeness.missing,
    observedPayloads: bundle.timeline.flatMap((record) =>
      record.type === "message.received" ||
      record.type === "message.received_trusted"
        ? [record.payload]
        : [],
    ),
    runId: bundle.manifest.runId,
    timelineRunIds: bundle.timeline.map((record) => record.runId),
  };
}

async function revalidateAcceptedSets(
  options: RunReliabilityGateOptions,
  report: ReliabilityGateReport,
): Promise<void> {
  let validatedReport: ReliabilityGateReport = {
    ...report,
    acceptedSets: [],
  };
  for (const acceptedSet of report.acceptedSets) {
    const context: ReliabilityAcceptedSetContext = {
      attemptId: acceptedSet.attemptId,
      baselineRunId: acceptedSet.baseline.runId,
      controlRunId: acceptedSet.control.runId,
      incidentId: acceptedSet.incidentId,
      replayRunId: acceptedSet.replay.runId,
      runtimeDirectory: acceptedSet.runtimeDirectory,
    };
    try {
      const evidence = await options.revalidateSet(context);
      const revalidated = validateSet(
        validatedReport,
        evidence,
        context,
        new Date(acceptedSet.completedAt),
        acceptedSet.startedAt,
      );
      requireGate(
        isDeepStrictEqual(revalidated, acceptedSet),
        "resume.summary_mismatch",
        `durable evidence no longer matches accepted attempt ${acceptedSet.attemptId}`,
      );
      validatedReport = {
        ...validatedReport,
        acceptedSets: [...validatedReport.acceptedSets, revalidated],
      };
    } catch (error) {
      throw new AcceptedSetRevalidationFailure(
        acceptedSet,
        error instanceof ReliabilityGateFailure
          ? error
          : new ReliabilityGateFailure(
              "resume.evidence_readback",
              message(error),
            ),
      );
    }
  }
}

async function runPreflight(
  options: RunReliabilityGateOptions,
  sourceReport: ReliabilityGateReport,
  resultPath: string,
  now: () => Date,
): Promise<ReliabilityGateReport> {
  const attempt = startAttempt(sourceReport, options.config, "PREFLIGHT", now());
  let report = attempt.report;
  await writeReport(resultPath, report);
  let evidence: ReliabilityPreflightEvidence;
  try {
    evidence = await options.preflight(attempt.context);
    options.signal?.throwIfAborted();
    if (evidence.modelId !== options.config.openRouter.modelId) {
      throw new ReliabilityGateFailure(
        "preflight.model",
        `returned ${evidence.modelId}, expected ${options.config.openRouter.modelId}`,
      );
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    const failure =
      error instanceof ReliabilityGateFailure
        ? error
        : classifyPreflightFailure(error);
    report = rejectActiveAttempt(report, failure, now, false);
    await writeReport(resultPath, report);
    throw failure;
  }
  const completedAt = now().toISOString();
  report = {
    ...report,
    activeAttempt: undefined,
    preflights: [
      ...report.preflights,
      {
        attemptId: attempt.context.attemptId,
        completedAt,
        durationMs: durationMs(report.activeAttempt?.startedAt, completedAt),
        modelId: evidence.modelId,
        sandboxId: evidence.sandboxId,
        smokeId: evidence.smokeId,
        startedAt: report.activeAttempt?.startedAt ?? completedAt,
        status: "PASSED",
      },
    ],
    status: "RUNNING",
    updatedAt: completedAt,
  };
  await writeReport(resultPath, report);
  return report;
}

function validateSet(
  report: ReliabilityGateReport,
  evidence: ReliabilityEquivalenceSetEvidence,
  attempt: ReliabilityAttemptContext,
  completed: Date,
  persistedStartedAt?: string,
): z.infer<typeof acceptedSetSchema> {
  const { baseline, replay, control } = evidence;
  requireGate(
    evidence.remediationState === "VERIFIED",
    "remediation.verified",
    `received ${evidence.remediationState}`,
  );
  requireGate(
    baseline.verdict === "VULNERABLE",
    "baseline.verdict",
    missingOrOutcome(baseline.missingEvidence, baseline.verdict),
  );
  requireGate(
    baseline.complete && baseline.finalizedAt.length > 0,
    "baseline.finalization",
    missingOrOutcome(baseline.missingEvidence, "incomplete"),
  );
  requireGate(
    replay.verdict === "PROTECTED",
    "replay.verdict",
    missingOrOutcome(replay.missingEvidence, replay.verdict),
  );
  requireGate(
    replay.complete && replay.finalizedAt.length > 0,
    "replay.finalization",
    missingOrOutcome(replay.missingEvidence, "incomplete"),
  );
  requireGate(
    replay.explicitDenial && !replay.matchingCanaryReceipt,
    "replay.explicit_denial",
    "explicit denial or bounded no-receipt evidence was missing",
  );
  requireGate(
    control.result === "PASSED",
    "control.result",
    missingOrOutcome(control.missingEvidence, control.result),
  );
  requireGate(
    control.complete && control.finalizedAt.length > 0,
    "control.finalization",
    missingOrOutcome(control.missingEvidence, "incomplete"),
  );

  requireGate(
    isDeepStrictEqual(
      baseline.fingerprints,
      report.configuration.baselineFingerprints,
    ) &&
      isDeepStrictEqual(
        replay.fingerprints,
        report.configuration.replayFingerprints,
      ) &&
      isDeepStrictEqual(
        control.fingerprints,
        report.configuration.controlFingerprints,
      ),
    "configuration.run_fingerprints",
    "Baseline Run fingerprints do not match the current gate configuration",
  );
  requireGate(
    replay.fingerprints.agent === baseline.fingerprints.agent &&
      replay.fingerprints.model === baseline.fingerprints.model &&
      replay.fingerprints.scenario === baseline.fingerprints.scenario &&
      replay.fingerprints.tools === baseline.fingerprints.tools &&
      control.fingerprints.agent === baseline.fingerprints.agent &&
      control.fingerprints.model === baseline.fingerprints.model &&
      control.fingerprints.tools === baseline.fingerprints.tools &&
      control.fingerprints.policy === replay.fingerprints.policy,
    "replay.equivalence",
    "Baseline Run, Attack Replay, and Control Run fingerprints did not match",
  );
  requireGate(
    evidence.incidentId === baseline.incidentId &&
      evidence.incidentId === replay.incidentId &&
      evidence.incidentId === control.incidentId &&
      replay.baselineRunId === baseline.runId &&
      control.baselineRunId === baseline.runId &&
      baseline.timelineRunIds.every((runId) => runId === baseline.runId) &&
      replay.timelineRunIds.every((runId) => runId === replay.runId) &&
      control.timelineRunIds.every((runId) => runId === control.runId),
    "evidence.run_correlation",
    "evidence crossed a Run or Incident boundary",
  );

  const priorSets = [...report.supersededSets, ...report.acceptedSets];
  const priorRejectedEvidence = report.rejectedAttempts.flatMap(
    (attempt) => attempt.evidence ?? [],
  );
  const canaryHashes = [
    sha256(baseline.canarySecret),
    sha256(replay.canarySecret),
    sha256(control.canarySecret),
  ];
  const existingCanaries = priorSets.flatMap((set) => [
    set.baseline.canarySha256,
    set.replay.canarySha256,
    set.control.canarySha256,
  ]).concat(priorRejectedEvidence.map((run) => run.canarySha256));
  const allCanaries = new Set([...existingCanaries, ...canaryHashes]);
  const observedCanaries = [baseline, replay, control].map((run) =>
    run.observedPayloads.map(sha256).filter((hash) => allCanaries.has(hash)),
  );
  requireGate(
    observedCanaries[0]?.every((hash) => hash === canaryHashes[0]) === true &&
      observedCanaries[1]?.length === 0 &&
      observedCanaries[2]?.length === 0,
    "evidence.cross_run_leak",
    "Canary evidence appeared in another Run",
  );

  const existingRuns = priorSets.flatMap((set) => [
    set.baseline.runId,
    set.replay.runId,
    set.control.runId,
  ]).concat(priorRejectedEvidence.map((run) => run.runId));
  const runIds = [baseline.runId, replay.runId, control.runId];
  const bundleHashes = [baseline.bundleHash, replay.bundleHash, control.bundleHash];
  const existingBundleHashes = priorSets.flatMap((set) => [
    set.baseline.bundleHash,
    set.replay.bundleHash,
    set.control.bundleHash,
  ]).concat(priorRejectedEvidence.map((run) => run.bundleHash));
  requireGate(
    new Set(runIds).size === runIds.length &&
      runIds.every((runId) => !existingRuns.includes(runId)) &&
      new Set(bundleHashes).size === bundleHashes.length &&
      bundleHashes.every((bundleHash) => !existingBundleHashes.includes(bundleHash)),
    "attempt.duplicate",
    "Run id or Evidence Bundle hash was already counted",
  );

  requireGate(
    new Set(canaryHashes).size === canaryHashes.length &&
      canaryHashes.every((canaryHash) => !existingCanaries.includes(canaryHash)),
    "evidence.canary_uniqueness",
    "Canary Secret was reused across Runs",
  );

  const completedAt = completed.toISOString();
  const startedAt =
    persistedStartedAt ?? report.activeAttempt?.startedAt ?? completedAt;
  return acceptedSetSchema.parse({
    attemptId: attempt.attemptId,
    baseline: acceptedRun(baseline, "verdict", "VULNERABLE"),
    completedAt,
    control: acceptedRun(control, "result", "PASSED"),
    durationMs: durationMs(startedAt, completedAt),
    incidentId: evidence.incidentId,
    replay: acceptedRun(replay, "verdict", "PROTECTED"),
    runtimeDirectory: attempt.runtimeDirectory,
    startedAt,
    status: "ACCEPTED",
  });
}

function acceptedRun(
  run: ReliabilityRunEvidence,
  outcomeName: "result" | "verdict",
  outcome: "PASSED" | "PROTECTED" | "VULNERABLE",
) {
  return {
    bundleHash: run.bundleHash,
    canarySha256: sha256(run.canarySecret),
    complete: true as const,
    finalizedAt: run.finalizedAt,
    fingerprints: run.fingerprints,
    [outcomeName]: outcome,
    runId: run.runId,
  };
}

interface StartedReliabilityAttempt {
  context: ReliabilityAttemptContext;
  report: ReliabilityGateReport;
}

function startAttempt(
  sourceReport: ReliabilityGateReport,
  config: RuntimeConfig,
  type: "PREFLIGHT" | "EQUIVALENCE_SET",
  started: Date,
): StartedReliabilityAttempt {
  const attemptId = randomUUID();
  const startedAt = started.toISOString();
  const runtimeDirectory = join(
    config.runtimeDirectory,
    "reliability",
    sourceReport.configuration.fingerprint,
    type === "PREFLIGHT" ? "preflights" : "attempts",
    attemptId,
  );
  const activeAttempt = { attemptId, runtimeDirectory, startedAt, type };
  return {
    context: { attemptId, runtimeDirectory },
    report: {
      ...sourceReport,
      activeAttempt,
      status: "RUNNING",
      updatedAt: startedAt,
    },
  };
}

function rejectInterruptedAttempt(
  report: ReliabilityGateReport,
  completed: Date,
): ReliabilityGateReport {
  return rejectActiveAttempt(
    report,
    new ReliabilityGateFailure(
      "attempt.interrupted",
      "attempt ended before complete evidence was durably accepted",
    ),
    () => completed,
  );
}

function rejectActiveAttempt(
  report: ReliabilityGateReport,
  failure: ReliabilityGateFailure,
  now: () => Date,
  resetSequence = true,
  evidence?: ReliabilityEquivalenceSetEvidence,
): ReliabilityGateReport {
  const active = report.activeAttempt;
  if (active === undefined) throw new Error("No active reliability attempt");
  const completedAt = now().toISOString();
  return {
    ...report,
    acceptedSets: resetSequence ? [] : report.acceptedSets,
    activeAttempt: undefined,
    rejectedAttempts: [
      ...report.rejectedAttempts,
      {
        attemptId: active.attemptId,
        completedAt,
        detail: failure.message.slice(failure.failedGate.length + 2),
        durationMs: durationMs(active.startedAt, completedAt),
        evidence:
          evidence === undefined ? undefined : rejectedEvidence(evidence),
        failedGate: failure.failedGate,
        runtimeDirectory: active.runtimeDirectory,
        startedAt: active.startedAt,
        status: "REJECTED",
        type: active.type,
      },
    ],
    status: "FAILED",
    supersededSets: resetSequence
      ? [...report.supersededSets, ...report.acceptedSets]
      : report.supersededSets,
    updatedAt: completedAt,
  };
}

function rejectAcceptedSequence(
  report: ReliabilityGateReport,
  failure: AcceptedSetRevalidationFailure,
  completed: Date,
): ReliabilityGateReport {
  const completedAt = completed.toISOString();
  const acceptedSet = failure.acceptedSet;
  const evidence = [
    acceptedSet.baseline,
    acceptedSet.replay,
    acceptedSet.control,
  ].map((run) => ({
    bundleHash: run.bundleHash,
    canarySha256: run.canarySha256,
    observedPayloadsSha256: [],
    runId: run.runId,
  }));
  return {
    ...report,
    acceptedSets: [],
    completedAt: undefined,
    rejectedAttempts: [
      ...report.rejectedAttempts,
      {
        attemptId: acceptedSet.attemptId,
        completedAt,
        detail: failure.message.slice(failure.failedGate.length + 2),
        durationMs: acceptedSet.durationMs,
        evidence,
        failedGate: failure.failedGate,
        runtimeDirectory: acceptedSet.runtimeDirectory,
        startedAt: acceptedSet.startedAt,
        status: "REJECTED",
        type: "EQUIVALENCE_SET",
      },
    ],
    status: "FAILED",
    supersededSets: [...report.supersededSets, ...report.acceptedSets],
    updatedAt: completedAt,
  };
}

function rejectedEvidence(
  evidence: ReliabilityEquivalenceSetEvidence,
): NonNullable<z.infer<typeof rejectedAttemptSchema>["evidence"]> {
  return [evidence.baseline, evidence.replay, evidence.control].map((run) => ({
    bundleHash: run.bundleHash,
    canarySha256: sha256(run.canarySecret),
    observedPayloadsSha256: run.observedPayloads.map(sha256),
    runId: run.runId,
  }));
}

function createReport(
  config: RuntimeConfig,
  started: Date,
): ReliabilityGateReport {
  const startedAt = started.toISOString();
  return {
    acceptedSets: [],
    configuration: createReliabilityConfiguration(config),
    preflights: [],
    rejectedAttempts: [],
    schemaVersion: 1,
    startedAt,
    status: "RUNNING",
    supersededSets: [],
    updatedAt: startedAt,
  };
}

async function readReport(
  resultPath: string,
): Promise<ReliabilityGateReport | undefined> {
  try {
    return reliabilityGateReportSchema.parse(
      JSON.parse(await readFile(resultPath, "utf8")),
    );
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function writeReport(
  resultPath: string,
  report: ReliabilityGateReport,
): Promise<void> {
  const parsed = reliabilityGateReportSchema.parse(report);
  const temporaryPath = `${resultPath}.tmp`;
  await mkdir(dirname(resultPath), { mode: 0o700, recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, resultPath);
}

function requireGate(
  condition: boolean,
  failedGate: ReliabilityFailureGate,
  detail: string,
): asserts condition {
  if (!condition) throw new ReliabilityGateFailure(failedGate, detail);
}

function missingOrOutcome(missing: string[], outcome: string): string {
  return missing.length > 0 ? missing.join(", ") : `received ${outcome}`;
}

function classifyPreflightFailure(cause: unknown): ReliabilityGateFailure {
  const detail = message(cause);
  if (!(cause instanceof RuntimeSmokeClientError)) {
    return new ReliabilityGateFailure("preflight.runtime", detail);
  }
  const failedGate: ReliabilityFailureGate =
    cause.stage === "preflight"
      ? "preflight.model_tool_path"
      : cause.stage === "sandbox-smoke"
        ? "preflight.sandbox"
        : cause.stage === "configuration"
          ? "preflight.configuration"
          : cause.stage === "health"
            ? "preflight.health"
            : "preflight.runtime";
  return new ReliabilityGateFailure(failedGate, detail);
}

function classifyExecutionFailure(cause: unknown): ReliabilityGateFailure {
  const detail = message(cause);
  if (cause instanceof BaselineAcceptanceError) {
    const failedGate: ReliabilityFailureGate =
      cause.stage === "evidence"
        ? "baseline.evidence"
        : cause.stage === "finalization"
          ? "baseline.finalization"
          : cause.stage === "timeout"
            ? "execution.timeout"
            : "execution.runtime";
    return new ReliabilityGateFailure(failedGate, detail);
  }
  if (cause instanceof InvestigationAcceptanceError) {
    const failedGate: ReliabilityFailureGate =
      cause.stage === "evidence" || cause.stage === "validation"
        ? "investigation.evidence"
        : cause.stage === "timeout"
          ? "execution.timeout"
          : "execution.runtime";
    return new ReliabilityGateFailure(failedGate, detail);
  }
  if (cause instanceof RemediationAcceptanceError) {
    const failedGate: ReliabilityFailureGate =
      cause.stage === "approval"
        ? "remediation.approval"
        : cause.stage === "baseline"
          ? "baseline.evidence"
          : cause.stage === "replay"
            ? "replay.evidence"
            : cause.stage === "control"
              ? "control.evidence"
              : cause.stage === "finalization"
                ? "evidence.finalization"
                : cause.stage === "validation"
                  ? "remediation.validation"
                  : cause.stage === "timeout"
                    ? "execution.timeout"
                    : "execution.runtime";
    return new ReliabilityGateFailure(failedGate, detail);
  }
  return new ReliabilityGateFailure("execution.runtime", detail);
}

function durationMs(
  startedAt: string | undefined,
  completedAt: string,
): number {
  if (startedAt === undefined) return 0;
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isMissingFile(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
