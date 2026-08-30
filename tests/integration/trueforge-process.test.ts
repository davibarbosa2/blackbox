import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTrueForgeProcess } from "../../src/trueforge/process.js";
import { findAvailablePort } from "../support/network.js";

describe("pinned TrueForge process", () => {
  const directories: string[] = [];
  const processes: Array<{ stop(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(processes.splice(0).map((process) => process.stop()));
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  it("starts with the explicit SQLite path and stops its owned server", async () => {
    const runtimeDirectory = await mkdtemp(
      join(tmpdir(), "blackbox-trueforge-process-"),
    );
    directories.push(runtimeDirectory);
    const port = await findAvailablePort();
    const sqlitePath = join(runtimeDirectory, "trueforge.sqlite");
    const trueForge = createTrueForgeProcess(
      {
        baseUrl: `http://127.0.0.1:${port}`,
        host: "127.0.0.1",
        port,
        sqlitePath,
      },
      process.cwd(),
    );
    processes.push(trueForge);

    await trueForge.start();

    await expect(
      fetch(`http://127.0.0.1:${port}/healthz`).then((response) =>
        response.text(),
      ),
    ).resolves.toBe("OK!");
    await expect(stat(sqlitePath)).resolves.toMatchObject({ isFile: expect.any(Function) });

    await trueForge.stop();
    await expect(findAvailablePort(port)).resolves.toBe(port);
  }, 40_000);

  it("stops the owned service when SQLite permission hardening fails", async () => {
    const runtimeDirectory = await mkdtemp(
      join(tmpdir(), "blackbox-trueforge-permissions-"),
    );
    directories.push(runtimeDirectory);
    const port = await findAvailablePort();
    const sqlitePath = join(runtimeDirectory, "trueforge.sqlite");
    const permissionError = new Error("chmod failed");
    const lifecycle: string[] = [];
    const trueForge = createTrueForgeProcess(
      {
        baseUrl: `http://127.0.0.1:${port}`,
        host: "127.0.0.1",
        port,
        sqlitePath,
      },
      process.cwd(),
      {
        async changeMode(path) {
          if (String(path) === sqlitePath) throw permissionError;
        },
        service: {
          async start() {
            lifecycle.push("start");
          },
          async stop() {
            lifecycle.push("stop");
          },
        },
      },
    );

    await expect(trueForge.start()).rejects.toBe(permissionError);
    expect(lifecycle).toEqual(["start", "stop"]);
  });
});
