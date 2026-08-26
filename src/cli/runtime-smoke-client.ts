import { join } from "node:path";

import type { RuntimeSmokeEvidence } from "../trueforge/runtime.js";

interface RuntimeSmokeClientOptions {
  fetcher?: typeof fetch;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SuccessfulRuntimeSmoke {
  result: RuntimeSmokeEvidence;
  smokeId: string;
  status: "succeeded";
}

export function formatRuntimeSmokeSuccess(
  smoke: SuccessfulRuntimeSmoke,
  runtimeDirectory: string,
): string {
  const { result } = smoke;
  return [
    `Runtime smoke succeeded: ${smoke.smokeId}`,
    `Provider/model: ${result.provider.name} / ${result.provider.upstreamModelId} -> ${result.provider.trueForgeModel}`,
    `Preflight: response_model=${result.preflight.responseModel} finish_reason=${result.preflight.finishReason} tool=${result.preflight.toolName}`,
    `${result.sandbox.event}: ${result.sandbox.id}`,
    `sandbox.exec: exit_code=${result.execution.exitCode} stdout=${result.execution.stdout.trim()}`,
    `turn.done.status: ${result.turn.status} (session=${result.turn.sessionId} turn=${result.turn.turnId})`,
    `Event reconciliation: ${result.reconciliation.liveEventIds.length} live = ${result.reconciliation.persistedEventIds.length} persisted`,
    `Result: ${join(runtimeDirectory, "smokes", smoke.smokeId, "result.json")}`,
  ].join("\n");
}

export async function runRuntimeSmokeViaHttp(
  baseUrl: string,
  options: RuntimeSmokeClientOptions = {},
): Promise<SuccessfulRuntimeSmoke> {
  const fetcher = options.fetcher ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  const requestOptions = options.signal ? { signal: options.signal } : {};

  const health = await fetcher(`${baseUrl}/healthz`, requestOptions);
  const healthBody: unknown = await health.json();
  if (!health.ok || !isObject(healthBody) || healthBody.status !== "ok") {
    throw new Error(`BLACKBOX health check failed with HTTP ${health.status}`);
  }

  const startResponse = await fetcher(`${baseUrl}/api/runtime-smokes`, {
    ...requestOptions,
    method: "POST",
  });
  const started: unknown = await startResponse.json();
  if (
    startResponse.status !== 202 ||
    !isObject(started) ||
    typeof started.smokeId !== "string" ||
    typeof started.statusUrl !== "string"
  ) {
    throw new Error(
      `BLACKBOX refused to start the runtime smoke with HTTP ${startResponse.status}`,
    );
  }

  while (Date.now() < deadline) {
    const statusResponse = await fetcher(
      new URL(started.statusUrl, baseUrl),
      requestOptions,
    );
    const status: unknown = await statusResponse.json();
    if (!statusResponse.ok || !isObject(status)) {
      throw new Error(
        `BLACKBOX runtime smoke status failed with HTTP ${statusResponse.status}`,
      );
    }

    if (status.status === "succeeded" && isObject(status.result)) {
      return {
        result: status.result as unknown as RuntimeSmokeEvidence,
        smokeId: started.smokeId,
        status: "succeeded",
      };
    }
    if (status.status === "failed") {
      const stage = typeof status.stage === "string" ? status.stage : "unknown";
      const message =
        isObject(status.error) && typeof status.error.message === "string"
          ? status.error.message
          : "Runtime smoke failed";
      throw new Error(`Runtime smoke failed at ${stage}: ${message}`);
    }
    if (status.status === "cancelled") {
      throw new Error("Runtime smoke was cancelled");
    }

    await delay(pollIntervalMs, options.signal);
  }

  throw new Error(`Runtime smoke ${started.smokeId} timed out`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
