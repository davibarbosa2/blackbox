import { describe, expect, it } from "vitest";

import type { RuntimeConfig } from "../../src/config.js";
import { createSdkTrueForgeRuntime } from "../../src/trueforge/sdk-runtime.js";
import { RuntimeSmokeStageError } from "../../src/trueforge/runtime.js";

const CONFIG: RuntimeConfig = {
  blackbox: { host: "127.0.0.1", port: 3000 },
  daytona: { apiKey: "daytona-secret" },
  openRouter: {
    apiKey: "openrouter-secret",
    baseUrl: "https://openrouter.example/api/v1",
    modelAlias: "tool-model",
    modelId: "vendor/tool-model",
  },
  runtimeDirectory: "/runtime",
  trueForge: {
    baseUrl: "http://trueforge.test",
    host: "127.0.0.1",
    port: 8790,
    sqlitePath: "/runtime/trueforge.sqlite",
  },
};

describe("SDK runtime stages", () => {
  it("identifies a TrueForge health failure before configuration", async () => {
    const controller = new AbortController();
    const runtime = createSdkTrueForgeRuntime(
      CONFIG,
      async (_input, init) => {
        expect(init?.signal).toBe(controller.signal);
        return new Response("starting openrouter-secret", { status: 503 });
      },
    );

    const error = await runtime
      .executeSmoke({ signal: controller.signal })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RuntimeSmokeStageError);
    expect(error).toMatchObject({
      message:
        'TrueForge health check expected HTTP 200 and OK!, received 503 and "starting [REDACTED]"',
      stage: "health",
    });
    expect(String(error)).not.toContain("openrouter-secret");
  });
});
