import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();

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

it("rejects a credential removed only from the candidate tree", async () => {
  const fixtureDirectory = await mkdtemp(
    join(tmpdir(), "blackbox-submission-history-"),
  );
  const originDirectory = join(fixtureDirectory, "origin.git");
  const repositoryDirectory = join(fixtureDirectory, "repository");

  try {
    await execFileAsync("git", ["init", "--bare", originDirectory]);
    await mkdir(join(repositoryDirectory, "docs"), { recursive: true });
    await execFileAsync("git", ["init"], { cwd: repositoryDirectory });
    await execFileAsync("git", ["config", "user.name", "Readiness Test"], {
      cwd: repositoryDirectory,
    });
    await execFileAsync(
      "git",
      ["config", "user.email", "readiness@example.invalid"],
      { cwd: repositoryDirectory },
    );
    for (const path of [
      ".env.example",
      "AI_ASSISTANCE.md",
      "LICENSE",
      "README.md",
      "docs/demo-runbook.md",
      "docs/trueforge.md",
    ]) {
      await writeFile(join(repositoryDirectory, path), `${path}\n`);
    }
    await execFileAsync("git", ["add", "."], { cwd: repositoryDirectory });
    await execFileAsync("git", ["commit", "-m", "initial"], {
      cwd: repositoryDirectory,
    });
    await execFileAsync("git", ["branch", "-M", "main"], {
      cwd: repositoryDirectory,
    });
    await execFileAsync("git", ["remote", "add", "origin", originDirectory], {
      cwd: repositoryDirectory,
    });
    await execFileAsync("git", ["push", "-u", "origin", "main"], {
      cwd: repositoryDirectory,
    });

    const leakedPath = join(repositoryDirectory, "removed-secret.txt");
    await writeFile(leakedPath, ["dtn", "_", "B".repeat(40)].join(""));
    await execFileAsync("git", ["add", "removed-secret.txt"], {
      cwd: repositoryDirectory,
    });
    await execFileAsync("git", ["commit", "-m", "add secret"], {
      cwd: repositoryDirectory,
    });
    await rm(leakedPath);
    await execFileAsync("git", ["add", "-u"], { cwd: repositoryDirectory });
    await execFileAsync("git", ["commit", "-m", "remove secret"], {
      cwd: repositoryDirectory,
    });

    await expect(
      execFileAsync(
        join(projectRoot, "node_modules", ".bin", "tsx"),
        [join(projectRoot, "src", "cli", "submission-readiness.ts")],
        { cwd: repositoryDirectory },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Published Git history contains credential-like content",
      ),
    });
  } finally {
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
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
