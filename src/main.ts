import "dotenv/config";

import { parseRuntimeConfig } from "./config.js";
import { startBlackboxServer } from "./server.js";

async function main(): Promise<void> {
  const shutdown = observeShutdownSignals();
  let server: Awaited<ReturnType<typeof startBlackboxServer>> | undefined;
  try {
    const config = parseRuntimeConfig(process.env);
    try {
      server = await startBlackboxServer(config, {}, shutdown.signal);
    } catch (error) {
      if (!shutdown.signal.aborted || error !== shutdown.signal.reason) {
        throw error;
      }
    }

    if (server === undefined) return;
    if (!shutdown.signal.aborted) {
      await writeOutput(
        `${JSON.stringify({ event: "blackbox.ready", url: server.url })}\n`,
      );
      await shutdown.wait;
    }
  } finally {
    try {
      await server?.stop();
    } finally {
      shutdown.dispose();
    }
  }

  await writeOutput(`${JSON.stringify({ event: "blackbox.stopped" })}\n`);
}

interface ShutdownObservation {
  dispose(): void;
  signal: AbortSignal;
  wait: Promise<void>;
}

function observeShutdownSignals(): ShutdownObservation {
  const controller = new AbortController();
  let resolveWait!: () => void;
  const wait = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });
  const request = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) return;
    controller.abort(new Error(`Received ${signal}`));
    resolveWait();
  };
  const interrupt = (): void => request("SIGINT");
  const terminate = (): void => request("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);

  return {
    dispose(): void {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    },
    signal: controller.signal,
    wait,
  };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function writeOutput(output: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(output, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

void main().catch((cause: unknown) => {
  process.stderr.write(`BLACKBOX failed: ${message(cause)}\n`);
  process.exitCode = 1;
});
