import "dotenv/config";

import { parseRuntimeConfig } from "../config.js";
import { runOwnedBlackboxCommand } from "./run-owned-blackbox-command.js";
import {
  formatRuntimeSmokeSuccess,
  runRuntimeSmokeViaHttp,
} from "./runtime-smoke-client.js";

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env);

  await runOwnedBlackboxCommand(config, async (baseUrl, signal) => {
    const smoke = await runRuntimeSmokeViaHttp(
      baseUrl,
      { signal },
    );
    await printSuccess(smoke, config.runtimeDirectory);
  });
}

async function printSuccess(
  smoke: Awaited<ReturnType<typeof runRuntimeSmokeViaHttp>>,
  runtimeDirectory: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(
      `${formatRuntimeSmokeSuccess(smoke, runtimeDirectory)}\n`,
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

void main().catch((cause: unknown) => {
  process.stderr.write(`Runtime smoke failed: ${message(cause)}\n`);
  if (process.exitCode === undefined) process.exitCode = 1;
});
