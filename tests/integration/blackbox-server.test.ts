import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RuntimeConfig } from "../../src/config.js";
import { SqliteEvidenceLedger } from "../../src/evidence/ledger.js";
import { createSqliteCapabilityPolicy } from "../../src/policy/capability-policy.js";
import { createBaselineRunManifest } from "../../src/scenario/definition.js";
import { startBlackboxServer } from "../../src/server.js";
import type { OwnedTrueForgeProcess } from "../../src/trueforge/process.js";
import type { TrueForgeRuntime } from "../../src/trueforge/runtime.js";
import { findAvailablePort } from "../support/network.js";

describe("BLACKBOX server lifecycle", () => {
  it("serves HTTP while owning the TrueForge process", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "blackbox-server-"));
    const blackboxPort = await findAvailablePort();
    const trueForgePort = await findAvailablePort();
    const lifecycle: string[] = [];
    const trueForgeProcess: OwnedTrueForgeProcess = {
      async start() {
        lifecycle.push("trueforge:start");
      },
      async stop() {
        lifecycle.push("trueforge:stop");
      },
    };
    const trueForgeRuntime: TrueForgeRuntime = {
      executeBaseline: () => new Promise(() => undefined),
      executeSmoke: () => new Promise(() => undefined),
    };
    const config: RuntimeConfig = {
      blackbox: { host: "127.0.0.1", port: blackboxPort },
      daytona: { apiKey: "daytona-secret" },
      openRouter: {
        apiKey: "openrouter-secret",
        baseUrl: "https://openrouter.example/api/v1",
        modelAlias: "tool-model",
        modelId: "vendor/tool-model",
      },
      runtimeDirectory,
      trueForge: {
        baseUrl: `http://127.0.0.1:${trueForgePort}`,
        host: "127.0.0.1",
        port: trueForgePort,
        sqlitePath: join(runtimeDirectory, "trueforge.sqlite"),
      },
    };

    const server = await startBlackboxServer(config, {
      trueForgeProcess,
      trueForgeRuntime,
    });

    await expect(
      fetch(`http://127.0.0.1:${blackboxPort}/healthz`).then((response) =>
        response.json(),
      ),
    ).resolves.toEqual({ status: "ok" });
    expect(lifecycle).toEqual(["trueforge:start"]);

    await server.stop();

    expect(lifecycle).toEqual(["trueforge:start", "trueforge:stop"]);
    await expect(findAvailablePort(blackboxPort)).resolves.toBe(blackboxPort);
    await rm(runtimeDirectory, { force: true, recursive: true });
  });

  it("defensively stops a partially started TrueForge process", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "blackbox-server-"));
    const blackboxPort = await findAvailablePort();
    const trueForgePort = await findAvailablePort();
    const lifecycle: string[] = [];
    const startupError = new Error("TrueForge post-start failure");
    const trueForgeProcess: OwnedTrueForgeProcess = {
      async start() {
        lifecycle.push("trueforge:start");
        throw startupError;
      },
      async stop() {
        lifecycle.push("trueforge:stop");
      },
    };
    const trueForgeRuntime: TrueForgeRuntime = {
      executeBaseline: () => new Promise(() => undefined),
      executeSmoke: () => new Promise(() => undefined),
    };
    const config: RuntimeConfig = {
      blackbox: { host: "127.0.0.1", port: blackboxPort },
      daytona: { apiKey: "daytona-secret" },
      openRouter: {
        apiKey: "openrouter-secret",
        baseUrl: "https://openrouter.example/api/v1",
        modelAlias: "tool-model",
        modelId: "vendor/tool-model",
      },
      runtimeDirectory,
      trueForge: {
        baseUrl: `http://127.0.0.1:${trueForgePort}`,
        host: "127.0.0.1",
        port: trueForgePort,
        sqlitePath: join(runtimeDirectory, "trueforge.sqlite"),
      },
    };

    await expect(
      startBlackboxServer(config, { trueForgeProcess, trueForgeRuntime }),
    ).rejects.toBe(startupError);
    expect(lifecycle).toEqual(["trueforge:start", "trueforge:stop"]);
    await expect(findAvailablePort(blackboxPort)).resolves.toBe(blackboxPort);
    await rm(runtimeDirectory, { force: true, recursive: true });
  });

  it("starts recovery only after its HTTP boundary is listening", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "blackbox-recovery-"));
    const blackboxPort = await findAvailablePort();
    const trueForgePort = await findAvailablePort();
    const baseUrl = `http://127.0.0.1:${blackboxPort}`;
    seedUnmatchedVulnerableBaseline(runtimeDirectory, baseUrl);
    const lifecycle: string[] = [];
    const trueForgeProcess: OwnedTrueForgeProcess = {
      async start() {
        lifecycle.push("trueforge:start");
      },
      async stop() {
        lifecycle.push("trueforge:stop");
      },
    };
    const trueForgeRuntime: TrueForgeRuntime = {
      executeBaseline: () => new Promise(() => undefined),
      async executeInvestigation() {
        try {
          const response = await fetch(`${baseUrl}/healthz`);
          lifecycle.push(`investigation:http-${response.status}`);
        } catch {
          lifecycle.push("investigation:http-unavailable");
        }
        throw new Error("Stop after proving recovery startup order");
      },
      executeSmoke: () => new Promise(() => undefined),
    };
    const config: RuntimeConfig = {
      blackbox: { host: "127.0.0.1", port: blackboxPort },
      daytona: { apiKey: "daytona-secret" },
      openRouter: {
        apiKey: "openrouter-secret",
        baseUrl: "https://openrouter.example/api/v1",
        modelAlias: "tool-model",
        modelId: "vendor/tool-model",
      },
      runtimeDirectory,
      trueForge: {
        baseUrl: `http://127.0.0.1:${trueForgePort}`,
        host: "127.0.0.1",
        port: trueForgePort,
        sqlitePath: join(runtimeDirectory, "trueforge.sqlite"),
      },
    };

    const server = await startBlackboxServer(config, {
      trueForgeProcess,
      trueForgeRuntime,
    });
    await vi.waitFor(() => {
      expect(lifecycle).toContain("investigation:http-200");
    });
    expect(lifecycle).not.toContain("investigation:http-unavailable");

    await server.stop();
    await rm(runtimeDirectory, { force: true, recursive: true });
  });
});

function seedUnmatchedVulnerableBaseline(
  runtimeDirectory: string,
  baseUrl: string,
): void {
  const databasePath = join(runtimeDirectory, "blackbox.sqlite");
  const trustedDestination = `${baseUrl}/api/trusted-destination`;
  const policy = createSqliteCapabilityPolicy(databasePath, [trustedDestination]);
  const manifest = createBaselineRunManifest(
    "0c9c0d55-ee7a-4e17-ac58-ef9e206e9824",
    "cc8e0eb1-75b4-42bd-83f8-9141633750e5",
    "BLACKBOX-CANARY-recovery",
    "2026-08-29T12:00:00.000Z",
    "tool-model",
    "vendor/tool-model",
    policy,
    baseUrl,
  );
  policy.close();
  const ledger = new SqliteEvidenceLedger(databasePath);
  ledger.createRun(manifest);
  const storedManifest = ledger.readManifest(manifest.runId);
  ledger.close();

  const withoutHash = {
    completeness: { complete: true, missing: [] },
    finalizedAt: "2026-08-29T12:00:10.000Z",
    schemaVersion: 1 as const,
    timeline: [],
    manifest: storedManifest,
    verdict: "VULNERABLE" as const,
  };
  const bundle = {
    ...withoutHash,
    bundleHash: createHash("sha256")
      .update(JSON.stringify(withoutHash))
      .digest("hex"),
  };
  const database = new DatabaseSync(databasePath);
  database
    .prepare(
      "INSERT INTO evidence_bundles (run_id, bundle_json) VALUES (?, ?)",
    )
    .run(storedManifest.runId, JSON.stringify(bundle));
  database.close();
}
