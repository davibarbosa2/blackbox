import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

import type { RuntimeConfig } from "../config.js";
import { assertPortAvailable } from "../process/port.js";

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface OwnedBlackbox {
  baseUrl: string;
  stop(): Promise<void>;
}

export async function startOwnedBlackbox(
  config: RuntimeConfig,
  signal: AbortSignal,
): Promise<OwnedBlackbox> {
  await assertPortAvailable(
    config.blackbox.host,
    config.blackbox.port,
    "BLACKBOX",
  );
  const child = spawn(
    join(process.cwd(), "node_modules", ".bin", "tsx"),
    ["src/main.ts"],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exit = waitForExit(child);
  child.stdout?.pipe(process.stderr);
  child.stderr?.pipe(process.stderr);
  const baseUrl = `http://${config.blackbox.host}:${config.blackbox.port}`;
  try {
    await waitForBlackbox(baseUrl, child, signal);
  } catch (error) {
    await stopBlackboxProcess(child, exit);
    throw error;
  }
  return {
    baseUrl,
    stop: () => stopBlackboxProcess(child, exit),
  };
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
      const body = await response.json();
      if (
        response.ok &&
        body !== null &&
        body instanceof Object &&
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
  promise: Promise<ChildExit>,
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
