import "dotenv/config";

import { parseRuntimeConfig } from "../config.js";
import {
  formatBaselineAcceptanceSuccess,
  runBaselineAcceptanceViaHttp,
} from "./baseline-acceptance-client.js";
import { startOwnedBlackbox } from "./owned-blackbox.js";

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env);
  const controller = new AbortController();
  let receivedSignal: NodeJS.Signals | undefined;
  const abort = (signal: NodeJS.Signals): void => {
    receivedSignal = signal;
    controller.abort(new Error(`Received ${signal}`));
  };
  process.once("SIGINT", () => abort("SIGINT"));
  process.once("SIGTERM", () => abort("SIGTERM"));

  const blackbox = await startOwnedBlackbox(config, controller.signal);
  let failure: { error: unknown } | undefined;
  try {
    const bundle = await runBaselineAcceptanceViaHttp(blackbox.baseUrl, {
      signal: controller.signal,
    });
    await writeOutput(`${formatBaselineAcceptanceSuccess(bundle)}\n`);
  } catch (error) {
    failure = { error };
  } finally {
    await blackbox.stop();
  }

  if (receivedSignal === "SIGINT") {
    process.exitCode = 130;
    return;
  }
  if (receivedSignal === "SIGTERM") {
    process.exitCode = 143;
    return;
  }
  if (failure !== undefined) throw failure.error;
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
  process.stderr.write(`Baseline acceptance failed: ${message(cause)}\n`);
  if (process.exitCode === undefined) process.exitCode = 1;
});
