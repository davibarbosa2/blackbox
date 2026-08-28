import { isDeepStrictEqual } from "node:util";

import {
  baselineEvidenceBundleSchema,
  type BaselineEvidenceBundle,
  controlEvidenceBundleSchema,
  type ControlEvidenceBundle,
  replayEvidenceBundleSchema,
  type ReplayEvidenceBundle,
} from "../evidence/ledger.js";
import {
  durableIncidentReadSchema,
  type DurableIncidentRead,
  type PendingPolicyDecision,
} from "../remediation/store.js";
import type { BaselineAcceptanceClientOptions } from "./baseline-acceptance-client.js";
import { runInvestigationAcceptanceViaHttp } from "./investigation-acceptance-client.js";

const EQUIVALENT_FINGERPRINTS = [
  "agent",
  "model",
  "scenario",
  "tools",
] as const;

export interface RemediationApprovalContext {
  baselineBundleHash: string;
  baselineRunId: string;
  candidateHash: string;
  candidateVersion: number;
  incidentId: string;
  pendingDecision: PendingPolicyDecision;
}

export interface RemediationAcceptanceResult {
  baseline: BaselineEvidenceBundle;
  control: ControlEvidenceBundle;
  incident: DurableIncidentRead;
  replay: ReplayEvidenceBundle;
}

export async function runRemediationAcceptanceViaHttp(
  baseUrl: string,
  options: BaselineAcceptanceClientOptions = {},
): Promise<RemediationAcceptanceResult> {
  const incident = await runInvestigationAcceptanceViaHttp(baseUrl, options);
  if (incident.remediation.state !== "AWAITING_APPROVAL") {
    throw new Error("Incident did not reach AWAITING_APPROVAL");
  }
  return waitForRemediationVerificationViaHttp(
    baseUrl,
    {
      baselineBundleHash: incident.baseline.evidenceBundleHash,
      baselineRunId: incident.baseline.runId,
      candidateHash: incident.remediation.dryRun.candidateHash,
      candidateVersion: incident.remediation.dryRun.candidate.version,
      incidentId: incident.incidentId,
      pendingDecision: incident.remediation.pendingDecision,
    },
    options,
  );
}

export async function waitForRemediationVerificationViaHttp(
  baseUrl: string,
  context: RemediationApprovalContext,
  options: BaselineAcceptanceClientOptions = {},
): Promise<RemediationAcceptanceResult> {
  const fetcher = options.fetcher ?? fetch;
  const requestOptions = options.signal ? { signal: options.signal } : {};
  const decision = await fetcher(
    `${baseUrl}/api/incidents/${context.incidentId}/remediation-decisions`,
    {
      ...requestOptions,
      body: JSON.stringify({
        decision: "allow",
        pendingDecision: context.pendingDecision,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  if (decision.status !== 202) {
    throw new Error(
      `BLACKBOX refused Remediation approval with HTTP ${decision.status}`,
    );
  }

  const deadline = Date.now() + (options.timeoutMs ?? 20 * 60_000);
  let verified: DurableIncidentRead | undefined;
  while (Date.now() < deadline) {
    const response = await fetcher(
      `${baseUrl}/api/incidents/${context.incidentId}`,
      requestOptions,
    );
    const incident = durableIncidentReadSchema.safeParse(await response.json());
    if (response.status !== 200 || !incident.success) {
      throw new Error(
        `BLACKBOX Remediation read failed with HTTP ${response.status}`,
      );
    }
    if (incident.data.remediation.state === "VALIDATION_FAILED") {
      throw new Error(
        `BLACKBOX Remediation validation failed: ${incident.data.remediation.error}`,
      );
    }
    if (
      incident.data.remediation.state === "DENIED" ||
      incident.data.remediation.state === "STALE"
    ) {
      throw new Error(
        `BLACKBOX Remediation ended in ${incident.data.remediation.state}`,
      );
    }
    if (incident.data.remediation.state === "VERIFIED") {
      verified = incident.data;
      break;
    }
    await delay(options.pollIntervalMs ?? 500, options.signal);
  }
  if (verified === undefined || verified.remediation.state !== "VERIFIED") {
    throw new Error(`Incident ${context.incidentId} verification timed out`);
  }

  const [baselineResponse, replayResponse, controlResponse] = await Promise.all([
    fetcher(
      `${baseUrl}/api/runs/${context.baselineRunId}/evidence`,
      requestOptions,
    ),
    fetcher(
      `${baseUrl}/api/runs/${verified.remediation.verification.replay.runId}/evidence`,
      requestOptions,
    ),
    fetcher(
      `${baseUrl}/api/runs/${verified.remediation.verification.control.runId}/evidence`,
      requestOptions,
    ),
  ]);
  const [baselineBody, replayBody, controlBody] = await Promise.all([
    baselineResponse.json(),
    replayResponse.json(),
    controlResponse.json(),
  ]);
  const baseline = baselineEvidenceBundleSchema.safeParse(baselineBody);
  const replay = replayEvidenceBundleSchema.safeParse(replayBody);
  const control = controlEvidenceBundleSchema.safeParse(controlBody);
  if (
    baselineResponse.status !== 200 ||
    replayResponse.status !== 200 ||
    controlResponse.status !== 200 ||
    !baseline.success ||
    !replay.success ||
    !control.success
  ) {
    throw new Error("BLACKBOX verification Evidence Bundles were unavailable");
  }
  assertVerifiedEvidence(context, verified, baseline.data, replay.data, control.data);
  return {
    baseline: baseline.data,
    control: control.data,
    incident: verified,
    replay: replay.data,
  };
}

export function formatRemediationAcceptanceSuccess(
  result: RemediationAcceptanceResult,
): string {
  if (result.incident.remediation.state !== "VERIFIED") {
    throw new Error("Remediation has not reached VERIFIED");
  }
  return [
    `Remediation state: ${result.incident.remediation.state}`,
    `Incident: ${result.incident.incidentId}`,
    `Applied policy: version=${result.incident.remediation.policyReadback.version} hash=${result.incident.remediation.policyReadback.hash}`,
    `Baseline verdict: ${result.baseline.verdict} bundle=${result.baseline.bundleHash}`,
    `Replay verdict: ${result.replay.verdict} bundle=${result.replay.bundleHash}`,
    `Control result: ${result.control.controlResult} bundle=${result.control.bundleHash}`,
  ].join("\n");
}

function assertVerifiedEvidence(
  context: RemediationApprovalContext,
  incident: DurableIncidentRead,
  baseline: BaselineEvidenceBundle,
  replay: ReplayEvidenceBundle,
  control: ControlEvidenceBundle,
): void {
  if (incident.remediation.state !== "VERIFIED") {
    throw new Error("Remediation did not reach VERIFIED");
  }
  const remediation = incident.remediation;
  if (
    incident.incidentStatus !== "RESOLVED" ||
    incident.baseline.evidenceBundleHash !== baseline.bundleHash ||
    baseline.bundleHash !== context.baselineBundleHash ||
    baseline.manifest.runId !== context.baselineRunId ||
    baseline.verdict !== "VULNERABLE" ||
    !baseline.completeness.complete ||
    remediation.policyReadback.hash !== context.candidateHash ||
    remediation.policyReadback.version !== context.candidateVersion
  ) {
    throw new Error("Verified Remediation baseline or policy readback mismatched");
  }
  const expectedLifecycle = [
    "DRAFTED",
    "DRY_RUN_PASSED",
    "AWAITING_APPROVAL",
    "APPLIED",
    "VERIFYING",
    "VERIFIED",
  ];
  if (
    !isDeepStrictEqual(
      remediation.lifecycle.map((event) => event.state),
      expectedLifecycle,
    )
  ) {
    throw new Error("Verified Remediation lifecycle evidence was incomplete");
  }
  if (
    replay.bundleHash !== remediation.verification.replay.bundleHash ||
    replay.manifest.runId !== remediation.verification.replay.runId ||
    replay.manifest.baselineRunId !== baseline.manifest.runId ||
    replay.verdict !== "PROTECTED" ||
    !replay.completeness.complete ||
    replay.manifest.fingerprints.policy !== context.candidateHash ||
    !equivalentFingerprints(baseline, replay)
  ) {
    throw new Error("Attack Replay evidence did not prove equivalent protection");
  }
  const replayDenied = replay.timeline.some(
    (record) =>
      record.type === "policy.evaluated" &&
      record.decision === "deny" &&
      record.policyHash === context.candidateHash,
  );
  const replayCutoff = replay.timeline.some(
    (record) => record.type === "sink.observation_cutoff",
  );
  const replayLeaked = replay.timeline.some(
    (record) =>
      record.type === "message.received" &&
      record.payload === replay.manifest.canarySecret,
  );
  if (!replayDenied || !replayCutoff || replayLeaked) {
    throw new Error("Attack Replay denial or bounded no-receipt proof was missing");
  }
  if (
    control.bundleHash !== remediation.verification.control.bundleHash ||
    control.manifest.runId !== remediation.verification.control.runId ||
    control.manifest.baselineRunId !== baseline.manifest.runId ||
    control.controlResult !== "PASSED" ||
    !control.completeness.complete ||
    control.manifest.fingerprints.policy !== context.candidateHash ||
    !equivalentFingerprints(baseline, control) ||
    !control.timeline.some(
      (record) =>
        record.type === "message.received_trusted" &&
        record.payload === control.manifest.controlMessage,
    )
  ) {
    throw new Error("Control Run evidence did not prove the trusted workflow");
  }
}

function equivalentFingerprints(
  baseline: BaselineEvidenceBundle,
  verification: ReplayEvidenceBundle | ControlEvidenceBundle,
): boolean {
  return EQUIVALENT_FINGERPRINTS.every((fingerprint) => {
    return (
      baseline.manifest.fingerprints[fingerprint] ===
      verification.manifest.fingerprints[fingerprint]
    );
  });
}

async function delay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const complete = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = setTimeout(complete, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
