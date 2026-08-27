import { z } from "zod";

import {
  evidenceBundleSchema,
  type EvidenceBundle,
} from "../evidence/ledger.js";

const healthSchema = z.object({ status: z.literal("ok") });
const startIncidentSchema = z.object({
  evidenceUrl: z.string(),
  incidentId: z.string(),
  runId: z.string(),
  status: z.literal("running"),
});
const runningRunSchema = z.object({
  runId: z.string(),
  status: z.literal("running"),
});

interface BaselineAcceptanceClientOptions {
  fetcher?: typeof fetch;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function runBaselineAcceptanceViaHttp(
  baseUrl: string,
  options: BaselineAcceptanceClientOptions = {},
): Promise<EvidenceBundle> {
  const fetcher = options.fetcher ?? fetch;
  const requestOptions = options.signal ? { signal: options.signal } : {};
  const health = await fetcher(`${baseUrl}/healthz`, requestOptions);
  if (!health.ok || !healthSchema.safeParse(await health.json()).success) {
    throw new Error(`BLACKBOX health check failed with HTTP ${health.status}`);
  }
  const startResponse = await fetcher(`${baseUrl}/api/incidents`, {
    ...requestOptions,
    method: "POST",
  });
  const started = startIncidentSchema.safeParse(await startResponse.json());
  if (startResponse.status !== 202 || !started.success) {
    throw new Error(
      `BLACKBOX refused to start the Incident with HTTP ${startResponse.status}`,
    );
  }

  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  while (Date.now() < deadline) {
    const response = await fetcher(
      new URL(started.data.evidenceUrl, baseUrl),
      requestOptions,
    );
    const body = await response.json();
    if (response.status === 202 && runningRunSchema.safeParse(body).success) {
      await delay(options.pollIntervalMs ?? 500, options.signal);
      continue;
    }
    const bundle = evidenceBundleSchema.safeParse(body);
    if (response.status !== 200 || !bundle.success) {
      throw new Error(
        `BLACKBOX Evidence Bundle failed with HTTP ${response.status}`,
      );
    }
    if (
      bundle.data.verdict !== "VULNERABLE" ||
      !bundle.data.completeness.complete
    ) {
      throw new Error(
        `Baseline acceptance expected VULNERABLE with complete evidence, received ${bundle.data.verdict}`,
      );
    }
    return bundle.data;
  }
  throw new Error(`Baseline Run ${started.data.runId} timed out`);
}

export function formatBaselineAcceptanceSuccess(
  bundle: EvidenceBundle,
): string {
  const fingerprints = bundle.manifest.fingerprints;
  return [
    `Baseline verdict: ${bundle.verdict}`,
    `Incident: ${bundle.manifest.incidentId}`,
    `Run: ${bundle.manifest.runId}`,
    `Fingerprints: agent=${fingerprints.agent} model=${fingerprints.model} policy=${fingerprints.policy} scenario=${fingerprints.scenario} tools=${fingerprints.tools}`,
    `Evidence records: ${bundle.timeline.length}`,
    `Evidence Bundle hash: ${bundle.bundleHash}`,
  ].join("\n");
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
