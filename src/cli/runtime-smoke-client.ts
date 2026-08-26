import { join } from "node:path";

import { z } from "zod";

import {
  runtimeSmokeEvidenceSchema,
  type RuntimeSmokeEvidence,
} from "../trueforge/runtime.js";

export const blackboxHealthResponseSchema = z.object({
  status: z.literal("ok"),
});

export const startRuntimeSmokeResponseSchema = z.object({
  smokeId: z.string(),
  status: z.literal("running"),
  statusUrl: z.string(),
});

const runtimeSmokeStatusResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running") }),
  z.object({
    result: runtimeSmokeEvidenceSchema,
    status: z.literal("succeeded"),
  }),
  z.object({
    error: z.object({ message: z.string() }),
    stage: z.string(),
    status: z.literal("failed"),
  }),
  z.object({ status: z.literal("cancelled") }),
]);

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
  const healthBody = blackboxHealthResponseSchema.safeParse(
    await health.json(),
  );
  if (!health.ok || !healthBody.success) {
    throw new Error(`BLACKBOX health check failed with HTTP ${health.status}`);
  }

  const startResponse = await fetcher(`${baseUrl}/api/runtime-smokes`, {
    ...requestOptions,
    method: "POST",
  });
  const started = startRuntimeSmokeResponseSchema.safeParse(
    await startResponse.json(),
  );
  if (startResponse.status !== 202 || !started.success) {
    throw new Error(
      `BLACKBOX refused to start the runtime smoke with HTTP ${startResponse.status}`,
    );
  }

  while (Date.now() < deadline) {
    const statusResponse = await fetcher(
      new URL(started.data.statusUrl, baseUrl),
      requestOptions,
    );
    const status = runtimeSmokeStatusResponseSchema.safeParse(
      await statusResponse.json(),
    );
    if (!statusResponse.ok || !status.success) {
      throw new Error(
        `BLACKBOX runtime smoke status failed with HTTP ${statusResponse.status}`,
      );
    }

    if (status.data.status === "succeeded") {
      return {
        result: status.data.result,
        smokeId: started.data.smokeId,
        status: "succeeded",
      };
    }
    if (status.data.status === "failed") {
      throw new Error(
        `Runtime smoke failed at ${status.data.stage}: ${status.data.error.message}`,
      );
    }
    if (status.data.status === "cancelled") {
      throw new Error("Runtime smoke was cancelled");
    }

    await delay(pollIntervalMs, options.signal);
  }

  throw new Error(`Runtime smoke ${started.data.smokeId} timed out`);
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
