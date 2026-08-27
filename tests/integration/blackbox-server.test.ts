import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeConfig } from "../../src/config.js";
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
});
