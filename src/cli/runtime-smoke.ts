import "dotenv/config";

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

import { parseRuntimeConfig } from "../config.js";
import { assertPortAvailable } from "../process/port.js";
import {
  formatRuntimeSmokeSuccess,
  runRuntimeSmokeViaHttp,
} from "./runtime-smoke-client.js";

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env);
  await assertPortAvailable(
    config.blackbox.host,
    config.blackbox.port,
    "BLACKBOX",
  );

  const controller = new AbortController();
  let receivedSignal: NodeJS.Signals | undefined;
  const abort = (signal: NodeJS.Signals): void => {
    receivedSignal = signal;
    controller.abort(new Error(`Received ${signal}`));
  };
  process.once("SIGINT", () => abort("SIGINT"));
  process.once("SIGTERM", () => abort("SIGTERM"));

  const child = startBlackboxProcess();
  const childExit = waitForExit(child);
  child.stdout?.pipe(process.stderr);
  child.stderr?.pipe(process.stderr);

  let failure: { error: unknown } | undefined;
  try {
    await waitForBlackbox(
      `http://${config.blackbox.host}:${config.blackbox.port}`,
      child,
      controller.signal,
    );
    const smoke = await runRuntimeSmokeViaHttp(
      `http://${config.blackbox.host}:${config.blackbox.port}`,
      { signal: controller.signal },
    );
    await printSuccess(smoke, config.runtimeDirectory);
  } catch (error) {
    failure = { error };
  } finally {
    await stopBlackboxProcess(child, childExit);
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

function startBlackboxProcess(): ChildProcess {
  return spawn(join(process.cwd(), "node_modules", ".bin", "tsx"), ["src/main.ts"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForBlackbox(
  baseUrl: string,
  child: ChildProcess,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `BLACKBOX exited before readiness (code ${String(child.exitCode)}, signal ${String(child.signalCode)})`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(500),
      });
      const body: unknown = await response.json();
      if (
        response.ok &&
        typeof body === "object" &&
        body !== null &&
        "status" in body &&
        body.status === "ok"
      ) {
        return;
      }
    } catch {
      // BLACKBOX owns TrueForge startup, which can take several seconds.
    }
    await delay(100, signal);
  }
  throw new Error(`BLACKBOX health check timed out at ${baseUrl}/healthz`);
}

function waitForExit(child: ChildProcess): Promise<ChildExit> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function stopBlackboxProcess(
  child: ChildProcess,
  exit: Promise<ChildExit>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await exit;
    return;
  }

  child.kill("SIGTERM");
  const stopped = await settlesWithin(exit, 45_000);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exit;
  }
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
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

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const complete = (): void => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(complete, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main().catch((error: unknown) => {
  process.stderr.write(`Runtime smoke failed: ${message(error)}\n`);
  if (process.exitCode === undefined) process.exitCode = 1;
});
