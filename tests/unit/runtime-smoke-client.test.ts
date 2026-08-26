import { describe, expect, it } from "vitest";

import {
  formatRuntimeSmokeSuccess,
  runRuntimeSmokeViaHttp,
} from "../../src/cli/runtime-smoke-client.js";
import type { RuntimeSmokeEvidence } from "../../src/trueforge/runtime.js";

const EVIDENCE: RuntimeSmokeEvidence = {
  agent: { id: "agent-1", name: "blackbox-runtime-smoke" },
  execution: {
    exitCode: 0,
    stdout: "BLACKBOX_DAYTONA_OK\n",
    toolCallId: "call-exec",
  },
  health: { body: "OK!", status: 200 },
  preflight: {
    finishReason: "tool_calls",
    responseModel: "vendor/tool-model:exact",
    toolCallId: "call-preflight",
    toolName: "blackbox_preflight",
  },
  provider: {
    modelAlias: "tool-model",
    name: "openrouter",
    trueForgeModel: "openrouter/tool-model",
    upstreamModelId: "vendor/tool-model",
  },
  reconciliation: {
    complete: true,
    liveEventIds: ["event-created", "event-done"],
    persistedEventIds: ["event-created", "event-done"],
  },
  sandbox: {
    event: "sandbox.created",
    id: "v1:daytona:default.sandbox-1",
  },
  turn: { sessionId: "session-1", status: "done", turnId: "turn-1" },
  versions: {
    node: "v22.23.2",
    pnpm: "11.16.0",
    trueForge: "0.1.4",
    trueForgeSdk: "0.1.3",
  },
};

describe("runtime smoke command HTTP client", () => {
  it("starts once and polls the status URL until succeeded", async () => {
    const requests: string[] = [];
    let statusReads = 0;
    const fetcher = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input.toString();
      requests.push(`${init?.method ?? "GET"} ${url}`);

      if (url.endsWith("/healthz")) {
        return Response.json({ status: "ok" });
      }
      if (url.endsWith("/api/runtime-smokes")) {
        return Response.json(
          {
            smokeId: "smoke-1",
            status: "running",
            statusUrl: "/api/runtime-smokes/smoke-1",
          },
          { status: 202 },
        );
      }

      statusReads += 1;
      if (statusReads === 1) {
        return Response.json({ smokeId: "smoke-1", status: "running" });
      }
      return Response.json({
        result: { turn: { status: "done" } },
        smokeId: "smoke-1",
        status: "succeeded",
      });
    };

    await expect(
      runRuntimeSmokeViaHttp("http://127.0.0.1:3000", {
        fetcher,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({
      result: { turn: { status: "done" } },
      smokeId: "smoke-1",
      status: "succeeded",
    });
    expect(requests).toEqual([
      "GET http://127.0.0.1:3000/healthz",
      "POST http://127.0.0.1:3000/api/runtime-smokes",
      "GET http://127.0.0.1:3000/api/runtime-smokes/smoke-1",
      "GET http://127.0.0.1:3000/api/runtime-smokes/smoke-1",
    ]);
  });

  it("formats every acceptance fingerprint without credentials", () => {
    expect(
      formatRuntimeSmokeSuccess(
        { result: EVIDENCE, smokeId: "smoke-1", status: "succeeded" },
        "/runtime",
      ),
    ).toBe(
      [
        "Runtime smoke succeeded: smoke-1",
        "Provider/model: openrouter / vendor/tool-model -> openrouter/tool-model",
        "Preflight: response_model=vendor/tool-model:exact finish_reason=tool_calls tool=blackbox_preflight",
        "sandbox.created: v1:daytona:default.sandbox-1",
        "sandbox.exec: exit_code=0 stdout=BLACKBOX_DAYTONA_OK",
        "turn.done.status: done (session=session-1 turn=turn-1)",
        "Event reconciliation: 2 live = 2 persisted",
        "Result: /runtime/smokes/smoke-1/result.json",
      ].join("\n"),
    );
  });
});
