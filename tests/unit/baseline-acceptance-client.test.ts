import { describe, expect, it } from "vitest";

import {
  formatBaselineAcceptanceSuccess,
  runBaselineAcceptanceViaHttp,
} from "../../src/cli/baseline-acceptance-client.js";
import type { EvidenceBundle } from "../../src/evidence/ledger.js";

const BUNDLE = {
  bundleHash: "0".repeat(64),
  completeness: { complete: true, missing: [] },
  finalizedAt: "2026-08-26T12:00:08.000Z",
  manifest: {
    canarySecret: "BLACKBOX-CANARY-run-1",
    createdAt: "2026-08-26T12:00:00.000Z",
    fingerprints: {
      agent: "agent-fingerprint",
      model: "model-fingerprint",
      policy: "policy-fingerprint",
      scenario: "scenario-fingerprint",
      tools: "tools-fingerprint",
    },
    incidentId: "incident-1",
    kind: "baseline",
    runId: "run-1",
  },
  schemaVersion: 1,
  timeline: [
    {
      id: "run-1:state:COMPLETED",
      occurredAt: "2026-08-26T12:00:08.000Z",
      runId: "run-1",
      source: "blackbox",
      state: "COMPLETED",
      type: "run.state_changed",
    },
  ],
  verdict: "VULNERABLE",
} satisfies EvidenceBundle;

describe("Baseline acceptance HTTP client", () => {
  it("starts an Incident and polls its Evidence Bundle through product HTTP", async () => {
    const requests: string[] = [];
    let reads = 0;
    const fetcher = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input.toString();
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/healthz")) return Response.json({ status: "ok" });
      if (url.endsWith("/api/incidents")) {
        return Response.json(
          {
            evidenceUrl: "/api/runs/run-1/evidence",
            incidentId: "incident-1",
            runId: "run-1",
            status: "running",
          },
          { status: 202 },
        );
      }
      reads += 1;
      return reads === 1
        ? Response.json({ runId: "run-1", status: "running" }, { status: 202 })
        : Response.json(BUNDLE);
    };

    await expect(
      runBaselineAcceptanceViaHttp("http://127.0.0.1:3000", {
        fetcher,
        pollIntervalMs: 0,
      }),
    ).resolves.toEqual(BUNDLE);
    expect(requests).toEqual([
      "GET http://127.0.0.1:3000/healthz",
      "POST http://127.0.0.1:3000/api/incidents",
      "GET http://127.0.0.1:3000/api/runs/run-1/evidence",
      "GET http://127.0.0.1:3000/api/runs/run-1/evidence",
    ]);
  });

  it("prints the verdict, fingerprints, and stable bundle hash without the canary", () => {
    const output = formatBaselineAcceptanceSuccess(BUNDLE);

    expect(output).toContain("Baseline verdict: VULNERABLE");
    expect(output).toContain(`Evidence Bundle hash: ${"0".repeat(64)}`);
    expect(output).toContain("model=model-fingerprint");
    expect(output).not.toContain("BLACKBOX-CANARY-run-1");
  });
});
