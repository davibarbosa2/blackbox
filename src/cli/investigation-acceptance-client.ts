import type { BaselineEvidenceBundle } from "../evidence/ledger.js";
import {
  durableIncidentReadSchema,
  type DurableIncidentRead,
} from "../remediation/store.js";
import {
  type BaselineAcceptanceClientOptions,
  runBaselineAcceptanceViaHttp,
} from "./baseline-acceptance-client.js";

export async function runInvestigationAcceptanceViaHttp(
  baseUrl: string,
  options: BaselineAcceptanceClientOptions = {},
): Promise<DurableIncidentRead> {
  const bundle = await runBaselineAcceptanceViaHttp(baseUrl, options);
  return waitForInvestigationViaHttp(baseUrl, bundle, options);
}

export async function waitForInvestigationViaHttp(
  baseUrl: string,
  bundle: BaselineEvidenceBundle,
  options: BaselineAcceptanceClientOptions = {},
): Promise<DurableIncidentRead> {
  const fetcher = options.fetcher ?? fetch;
  const requestOptions = options.signal ? { signal: options.signal } : {};
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  while (Date.now() < deadline) {
    const response = await fetcher(
      `${baseUrl}/api/incidents/${bundle.manifest.incidentId}`,
      requestOptions,
    );
    const incident = durableIncidentReadSchema.safeParse(await response.json());
    if (response.status !== 200 || !incident.success) {
      throw new Error(
        `BLACKBOX Incident investigation failed with HTTP ${response.status}`,
      );
    }
    if (incident.data.remediation.state === "VALIDATION_FAILED") {
      throw new Error(
        `BLACKBOX Incident investigation validation failed: ${incident.data.remediation.error}`,
      );
    }
    if (incident.data.remediation.state !== "AWAITING_APPROVAL") {
      await delay(options.pollIntervalMs ?? 500, options.signal);
      continue;
    }
    assertAcceptanceEvidence(incident.data, bundle);
    return incident.data;
  }
  throw new Error(
    `Incident ${bundle.manifest.incidentId} investigation timed out`,
  );
}

export function formatInvestigationAcceptanceSuccess(
  incident: DurableIncidentRead,
): string {
  if (incident.remediation.state !== "AWAITING_APPROVAL") {
    throw new Error("Investigation has not reached AWAITING_APPROVAL");
  }
  const pending = incident.remediation.pendingDecision;
  return [
    `Investigation state: ${incident.remediation.state}`,
    `Incident: ${incident.incidentId}`,
    `Baseline Run: ${incident.baseline.runId}`,
    `Canonical cause: ${incident.remediation.diagnosis.canonicalCause}`,
    `Subagents: ${incident.remediation.subagents.map((subagent) => `${subagent.title}=${subagent.threadId}`).join(", ")}`,
    `Daytona sandbox: ${incident.remediation.analysis.sandbox.id}`,
    `Pending action: session=${pending.sessionId} turn=${pending.turnId} action=${pending.actionId} call=${pending.callId}`,
  ].join("\n");
}

function assertAcceptanceEvidence(
  incident: DurableIncidentRead,
  bundle: BaselineEvidenceBundle,
): void {
  if (incident.remediation.state !== "AWAITING_APPROVAL") {
    throw new Error("Investigation did not reach AWAITING_APPROVAL");
  }
  const remediation = incident.remediation;
  if (
    incident.baseline.evidenceBundleHash !== bundle.bundleHash ||
    incident.baseline.runId !== bundle.manifest.runId ||
    remediation.evidenceJustification.bundleHash !== bundle.bundleHash ||
    remediation.evidenceJustification.runId !== bundle.manifest.runId
  ) {
    throw new Error("Investigation is not correlated to the Baseline Evidence Bundle");
  }
  if (
    remediation.pendingDecision.toolName !== "apply_policy_patch" ||
    remediation.dryRun.base.hash !== bundle.manifest.fingerprints.policy ||
    remediation.dryRun.affectedCapability !== "send_external_message" ||
    remediation.dryRun.predictedOperationalImpact.protectedDocumentAccess !==
      "unchanged" ||
    !remediation.analysis.execution.stdout
      .split(/\r?\n/)
      .includes("BLACKBOX_INVESTIGATION_ANALYSIS_OK")
  ) {
    throw new Error("Investigation acceptance evidence is incomplete");
  }
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
