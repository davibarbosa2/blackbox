import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

it("passes the public repository readiness gate", async () => {
  const { stdout } = await execFileAsync(
    "pnpm",
    ["submission:check"],
    { cwd: process.cwd() },
  );

  expect(stdout).toContain("Required submission artifacts: passed");
  expect(stdout).toContain("Tracked and untracked paths: passed");
  expect(stdout).toContain("Current repository contents: passed");
  expect(stdout).toContain("Published Git history: passed");
  expect(stdout).toContain("Publication readiness: passed");
}, 15_000);

it("rejects an untracked Daytona-shaped credential", async () => {
  const probePath = join(process.cwd(), "submission-secret-probe.txt");
  const syntheticCredential = ["dtn", "_", "A".repeat(40)].join("");
  await writeFile(probePath, syntheticCredential, { flag: "wx" });

  try {
    await expect(
      execFileAsync("pnpm", ["submission:check"], { cwd: process.cwd() }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "submission-secret-probe.txt contains credential-like content",
      ),
    });
  } finally {
    await rm(probePath, { force: true });
  }
}, 15_000);
