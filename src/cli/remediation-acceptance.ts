import "dotenv/config";

import { parseRuntimeConfig } from "../config.js";
import {
  formatRemediationAcceptanceSuccess,
  runRemediationAcceptanceViaHttp,
} from "./remediation-acceptance-client.js";
import { runOwnedBlackboxCommand } from "./run-owned-blackbox-command.js";

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env);
  await runOwnedBlackboxCommand(config, async (baseUrl, signal) => {
    const result = await runRemediationAcceptanceViaHttp(baseUrl, { signal });
    await writeOutput(`${formatRemediationAcceptanceSuccess(result)}\n`);
  });
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
  process.stderr.write(`Remediation acceptance failed: ${message(cause)}\n`);
  if (process.exitCode === undefined) process.exitCode = 1;
});
