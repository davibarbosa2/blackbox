import "dotenv/config";

import { join } from "node:path";

import { parseRuntimeConfig, type RuntimeConfig } from "../config.js";
import { startOwnedBlackbox } from "./owned-blackbox.js";
import {
  formatReliabilityGateSummary,
  reliabilityConfigurationFingerprint,
  reliabilityEvidenceFromRemediation,
  runReliabilityGate,
} from "./reliability-gate-client.js";
import { runRemediationAcceptanceViaHttp } from "./remediation-acceptance-client.js";
import { runRuntimeSmokeViaHttp } from "./runtime-smoke-client.js";

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env);
  const shutdown = observeShutdownSignals();
  try {
    const report = await runReliabilityGate({
      config,
      async executeSet(attempt) {
        const attemptConfig = configForRuntimeDirectory(
          config,
          attempt.runtimeDirectory,
        );
        return withOwnedBlackbox(attemptConfig, shutdown.signal, async (baseUrl) =>
          reliabilityEvidenceFromRemediation(
            await runRemediationAcceptanceViaHttp(baseUrl, {
              signal: shutdown.signal,
            }),
          ),
        );
      },
      async preflight(attempt) {
        const preflightConfig = configForRuntimeDirectory(
          config,
          attempt.runtimeDirectory,
        );
        const smoke = await withOwnedBlackbox(
          preflightConfig,
          shutdown.signal,
          (baseUrl) =>
            runRuntimeSmokeViaHttp(baseUrl, { signal: shutdown.signal }),
        );
        return {
          modelId: smoke.result.provider.upstreamModelId,
          sandboxId: smoke.result.sandbox.id,
          smokeId: smoke.smokeId,
        };
      },
      signal: shutdown.signal,
    });
    const resultPath = join(
      config.runtimeDirectory,
      "reliability",
      report.configuration.fingerprint,
      "result.json",
    );
    await writeOutput(
      `${formatReliabilityGateSummary(report)}\nReport: ${resultPath}\n`,
    );
  } catch (error) {
    const signal = shutdown.receivedSignal();
    if (signal !== undefined) {
      process.exitCode = signal === "SIGINT" ? 130 : 143;
      return;
    }
    const resultPath = join(
      config.runtimeDirectory,
      "reliability",
      reliabilityConfigurationFingerprint(config),
      "result.json",
    );
    throw new Error(`${message(error)}\nReport: ${resultPath}`, {
      cause: error,
    });
  } finally {
    shutdown.dispose();
  }
}

async function withOwnedBlackbox<T>(
  config: RuntimeConfig,
  signal: AbortSignal,
  operation: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const blackbox = await startOwnedBlackbox(config, signal);
  try {
    return await operation(blackbox.baseUrl);
  } finally {
    await blackbox.stop();
  }
}

function configForRuntimeDirectory(
  config: RuntimeConfig,
  runtimeDirectory: string,
): RuntimeConfig {
  return {
    ...config,
    runtimeDirectory,
    trueForge: {
      ...config.trueForge,
      sqlitePath: join(runtimeDirectory, "trueforge.sqlite"),
    },
  };
}

interface ShutdownObservation {
  dispose(): void;
  receivedSignal(): NodeJS.Signals | undefined;
  signal: AbortSignal;
}

function observeShutdownSignals(): ShutdownObservation {
  const controller = new AbortController();
  let received: NodeJS.Signals | undefined;
  const request = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) return;
    received = signal;
    controller.abort(new Error(`Received ${signal}`));
  };
  const interrupt = (): void => request("SIGINT");
  const terminate = (): void => request("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  return {
    dispose(): void {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    },
    receivedSignal: () => received,
    signal: controller.signal,
  };
}

async function writeOutput(output: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(output, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

void main().catch((cause: unknown) => {
  process.stderr.write(`Reliability gate failed: ${message(cause)}\n`);
  if (process.exitCode === undefined) process.exitCode = 1;
});
