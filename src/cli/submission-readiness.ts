import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const requiredArtifacts = [
  ".env.example",
  "AI_ASSISTANCE.md",
  "LICENSE",
  "README.md",
  "docs/demo-runbook.md",
  "docs/trueforge.md",
];

const forbiddenDirectoryNames = new Set([
  ".blackbox",
  ".evlog",
  "coverage",
  "dist",
  "node_modules",
]);

const forbiddenExtensions = [
  ".db",
  ".key",
  ".log",
  ".p12",
  ".pem",
  ".pfx",
  ".sqlite",
  ".sqlite-shm",
  ".sqlite-wal",
];

const credentialPatterns = [
  /dtn_[A-Za-z0-9_-]{20,}/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /gh[pousr]_[A-Za-z0-9]{20,}/u,
  /sk-or-v1-[A-Za-z0-9_-]{20,}/u,
  /sk-[A-Za-z0-9_-]{20,}/u,
  new RegExp(["-----BEGIN", "PRIVATE KEY-----"].join(" "), "u"),
];

function git(...arguments_: string[]): string {
  return execFileSync("git", arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function lines(value: string): string[] {
  return value.split("\n").filter((line) => line.length > 0);
}

function isForbiddenPath(path: string): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => forbiddenDirectoryNames.has(segment))) {
    return true;
  }
  if (
    segments.some(
      (segment) =>
        segment === ".env" ||
        (segment.startsWith(".env.") && segment !== ".env.example"),
    )
  ) {
    return true;
  }
  return forbiddenExtensions.some((extension) => path.endsWith(extension));
}

function assertNoForbiddenPaths(paths: string[], scope: string): void {
  const forbidden = paths.filter(isForbiddenPath);
  if (forbidden.length > 0) {
    throw new Error(`${scope} contains forbidden paths:\n${forbidden.join("\n")}`);
  }
}

function assertNoCredentials(value: string, scope: string): void {
  const matched = credentialPatterns.find((pattern) => pattern.test(value));
  if (matched !== undefined) {
    throw new Error(`${scope} contains credential-like content (${matched.source})`);
  }
}

function checkRequiredArtifacts(): void {
  for (const path of requiredArtifacts) {
    readFileSync(join(process.cwd(), path));
  }
  process.stdout.write("Required submission artifacts: passed\n");
}

function currentPaths(): string[] {
  return lines(
    git("ls-files", "--cached", "--others", "--exclude-standard"),
  );
}

function checkCurrentPaths(paths: string[]): void {
  assertNoForbiddenPaths(paths, "Repository");
  process.stdout.write("Tracked and untracked paths: passed\n");
}

function checkCurrentContents(paths: string[]): void {
  for (const path of paths) {
    const absolutePath = join(process.cwd(), path);
    if (!lstatSync(absolutePath).isFile()) continue;
    assertNoCredentials(readFileSync(absolutePath, "utf8"), path);
  }
  process.stdout.write("Current repository contents: passed\n");
}

function checkPublishedHistory(): void {
  const objects = lines(
    git("rev-list", "--objects", "--remotes=origin", "HEAD"),
  );
  const paths = objects.flatMap((object) => {
    const separator = object.indexOf(" ");
    return separator === -1 ? [] : [object.slice(separator + 1)];
  });
  assertNoForbiddenPaths(paths, "Published Git history");
  assertNoCredentials(
    git(
      "log",
      "-p",
      "--format=",
      "--no-ext-diff",
      "--remotes=origin",
      "HEAD",
    ),
    "Published Git history",
  );
  process.stdout.write("Published Git history: passed\n");
}

function main(): void {
  const paths = currentPaths();
  checkRequiredArtifacts();
  checkCurrentPaths(paths);
  checkCurrentContents(paths);
  checkPublishedHistory();
  process.stdout.write("Publication readiness: passed\n");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Publication readiness failed: ${message}\n`);
  process.exitCode = 1;
}
