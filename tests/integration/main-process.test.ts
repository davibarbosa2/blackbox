import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findAvailablePort } from "../support/network.js";

describe("BLACKBOX entrypoint", () => {
  it("exits promptly after gracefully stopping its owned services", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "blackbox-main-"));
    const blackboxPort = await findAvailablePort();
    const trueForgePort = await findAvailablePort();
    const child = spawn(
      join(process.cwd(), "node_modules", ".bin", "tsx"),
      ["src/main.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BLACKBOX_PORT: String(blackboxPort),
          BLACKBOX_RUNTIME_DIR: runtimeDirectory,
          DAYTONA_API_KEY: "unused-daytona-secret",
          OPENROUTER_API_KEY: "unused-openrouter-secret",
          OPENROUTER_MODEL_ID: "vendor/tool-model",
          TRUEFORGE_PORT: String(trueForgePort),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exit = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await waitUntil(() => stdout.includes('"event":"blackbox.ready"'));
      child.kill("SIGTERM");

      const result = await Promise.race([
        exit,
        delay(5_000).then(() => undefined),
      ]);

      expect(result, `stdout:\n${stdout}\nstderr:\n${stderr}`).toEqual({
        code: 0,
        signal: null,
      });
      expect(stdout).toContain('"event":"blackbox.stopped"');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exit;
      }
      await rm(runtimeDirectory, { force: true, recursive: true });
    }
  }, 25_000);
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate() && Date.now() < deadline) {
    await delay(25);
  }
  if (!predicate()) {
    throw new Error("BLACKBOX did not become ready");
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
