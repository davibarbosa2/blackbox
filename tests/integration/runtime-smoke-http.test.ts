import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startRuntimeSmokeResponseSchema } from "../../src/cli/runtime-smoke-client.js";
import {
  createBlackboxApp,
  createBlackboxApplication,
} from "../../src/http/app.js";
import type {
  RuntimeSmokeEvidence,
  TrueForgeRuntime,
} from "../../src/trueforge/runtime.js";
import { RuntimeSmokeStageError } from "../../src/trueforge/runtime.js";

const EVIDENCE: RuntimeSmokeEvidence = {
  agent: {
    id: "agent-1",
    name: "blackbox-runtime-smoke",
  },
  health: {
    body: "OK!",
    status: 200,
  },
  provider: {
    name: "openrouter",
    upstreamModelId: "stealth/ox-alpha",
    modelAlias: "ox-alpha",
    trueForgeModel: "openrouter/ox-alpha",
  },
  preflight: {
    finishReason: "tool_calls",
    responseModel: "stealth/ox-alpha",
    toolCallId: "call-preflight",
    toolName: "blackbox_preflight",
  },
  sandbox: {
    event: "sandbox.created",
    id: "v1:daytona:default.sandbox-1",
  },
  execution: {
    exitCode: 0,
    stdout: "BLACKBOX_DAYTONA_OK\n",
    toolCallId: "call-success",
  },
  turn: {
    sessionId: "session-1",
    turnId: "turn-1",
    status: "done",
  },
  reconciliation: {
    complete: true,
    liveEventIds: ["event-created", "event-done"],
    persistedEventIds: ["event-created", "event-done"],
  },
  versions: {
    node: "v22.23.2",
    pnpm: "11.16.0",
    trueForge: "0.1.4",
    trueForgeSdk: "0.1.3",
  },
};

describe("runtime smoke HTTP API", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("starts a smoke and exposes its terminal evidence by id", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "blackbox-http-"));
    directories.push(runtimeDirectory);

    let completeSmoke: ((evidence: RuntimeSmokeEvidence) => void) | undefined;
    const trueForgeRuntime: TrueForgeRuntime = {
      executeBaseline: () => new Promise(() => undefined),
      executeSmoke: () =>
        new Promise((resolve) => {
          completeSmoke = resolve;
        }),
    };
    const app = createBlackboxApp({ runtimeDirectory, trueForgeRuntime });

    const startResponse = await app.request("/api/runtime-smokes", {
      method: "POST",
    });
    const started = startRuntimeSmokeResponseSchema.parse(
      await startResponse.json(),
    );

    expect(startResponse.status).toBe(202);
    expect(started).toMatchObject({
      status: "running",
      statusUrl: `/api/runtime-smokes/${started.smokeId}`,
    });

    completeSmoke?.(EVIDENCE);

    await vi.waitFor(async () => {
      const statusResponse = await app.request(started.statusUrl);
      expect(statusResponse.status).toBe(200);
      await expect(statusResponse.json()).resolves.toMatchObject({
        smokeId: started.smokeId,
        status: "succeeded",
        result: EVIDENCE,
      });
    });
  });

  it("rejects a second smoke while one is running", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "blackbox-http-"));
    directories.push(runtimeDirectory);

    const trueForgeRuntime: TrueForgeRuntime = {
      executeBaseline: () => new Promise(() => undefined),
      executeSmoke: () => new Promise(() => undefined),
    };
    const app = createBlackboxApp({ runtimeDirectory, trueForgeRuntime });

    const firstResponse = await app.request("/api/runtime-smokes", {
      method: "POST",
    });
    const first = startRuntimeSmokeResponseSchema.parse(
      await firstResponse.json(),
    );
    const secondResponse = await app.request("/api/runtime-smokes", {
      method: "POST",
    });

    expect(secondResponse.status).toBe(409);
    await expect(secondResponse.json()).resolves.toEqual({
      activeSmokeId: first.smokeId,
      error: "A runtime smoke is already running",
    });
  });

  it("rejects an invalid smoke id before accessing the file store", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "blackbox-http-"));
    directories.push(runtimeDirectory);
    const app = createBlackboxApp({
      runtimeDirectory,
      trueForgeRuntime: {
        executeBaseline: () => new Promise(() => undefined),
        executeSmoke: () => new Promise(() => undefined),
      },
    });

    const response = await app.request("/api/runtime-smokes/not-a-uuid");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid runtime smoke id",
    });
  });

  it("persists the stage and safe cause of a failed smoke", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "blackbox-http-"));
    directories.push(runtimeDirectory);

    const trueForgeRuntime: TrueForgeRuntime = {
      executeBaseline: () => new Promise(() => undefined),
      executeSmoke: async () => {
        throw new RuntimeSmokeStageError(
          "preflight",
          new Error("configured model did not call the required tool"),
        );
      },
    };
    const app = createBlackboxApp({ runtimeDirectory, trueForgeRuntime });

    const startResponse = await app.request("/api/runtime-smokes", {
      method: "POST",
    });
    const started = startRuntimeSmokeResponseSchema.parse(
      await startResponse.json(),
    );

    await vi.waitFor(async () => {
      const statusResponse = await app.request(
        `/api/runtime-smokes/${started.smokeId}`,
      );
      await expect(statusResponse.json()).resolves.toMatchObject({
        error: {
          message: "configured model did not call the required tool",
        },
        smokeId: started.smokeId,
        stage: "preflight",
        status: "failed",
      });
    });
  });

  it("persists cancellation when the application shuts down", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "blackbox-http-"));
    directories.push(runtimeDirectory);

    const trueForgeRuntime: TrueForgeRuntime = {
      executeBaseline: () => new Promise(() => undefined),
      executeSmoke: ({ signal } = {}) =>
        new Promise((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        }),
    };
    const application = createBlackboxApplication({
      runtimeDirectory,
      trueForgeRuntime,
    });

    const startResponse = await application.app.request(
      "/api/runtime-smokes",
      { method: "POST" },
    );
    const started = startRuntimeSmokeResponseSchema.parse(
      await startResponse.json(),
    );

    await application.shutdown();

    const statusResponse = await application.app.request(
      `/api/runtime-smokes/${started.smokeId}`,
    );
    await expect(statusResponse.json()).resolves.toMatchObject({
      smokeId: started.smokeId,
      status: "cancelled",
    });
  });
});
