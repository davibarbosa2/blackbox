import "dotenv/config";

import { parseRuntimeConfig } from "./config.js";
import { startBlackboxServer } from "./server.js";

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env);
  const server = await startBlackboxServer(config);
  await writeOutput(
    `${JSON.stringify({ event: "blackbox.ready", url: server.url })}\n`,
  );

  await waitForShutdownSignal();
  await server.stop();
  await writeOutput(`${JSON.stringify({ event: "blackbox.stopped" })}\n`);
}

async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeOutput(output: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(output, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(`BLACKBOX failed: ${message(error)}\n`);
  process.exitCode = 1;
});
