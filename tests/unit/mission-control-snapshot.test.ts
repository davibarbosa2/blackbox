import { describe, expect, it } from "vitest";

import type { EvidenceRunRead } from "../../src/evidence/ledger.js";
import { createMissionControlSnapshot } from "../../src/mission-control/snapshot.js";

const RUN_ID = "run-live-baseline";
const PRIVATE_CANARY = "BLACKBOX-CANARY-must-never-reach-mission-control";

describe("Mission Control activity projection", () => {
  it("shows a live Scenario tool completion once without exposing its payload", () => {
    const baselineRun: EvidenceRunRead = {
      manifest: {
        canarySecret: PRIVATE_CANARY,
        createdAt: "2026-08-29T21:00:00.000Z",
        fingerprints: {
          agent: "agent-fingerprint",
          model: "model-fingerprint",
          policy: "policy-fingerprint",
          scenario: "scenario-fingerprint",
          tools: "tools-fingerprint",
        },
        incidentId: "incident-live",
        kind: "baseline",
        runId: RUN_ID,
      },
      timeline: [
        {
          id: "tool-completed-live",
          input: JSON.stringify({ secret: PRIVATE_CANARY }),
          occurredAt: "2026-08-29T21:00:04.000Z",
          output: JSON.stringify({ secret: PRIVATE_CANARY }),
          runId: RUN_ID,
          source: "mcp",
          succeeded: true,
          toolName: "read_internal_document",
          transactionId: "transaction-live",
          type: "tool.completed",
        },
        {
          arguments: JSON.stringify({ secret: PRIVATE_CANARY }),
          id: "tool-called-reconciled",
          occurredAt: "2026-08-29T21:00:09.000Z",
          runId: RUN_ID,
          source: "trueforge",
          toolCallId: "call-live",
          toolName: "read_internal_document",
          type: "tool.called",
        },
      ],
    };

    const snapshot = createMissionControlSnapshot(
      baselineRun,
      undefined,
      undefined,
      undefined,
      true,
      false,
    );
    const toolActivity = snapshot.activity.filter(
      (item) => item.kind === "tool",
    );

    expect(toolActivity).toEqual([
      expect.objectContaining({
        id: "tool-completed-live",
        scope: "BASELINE",
        source: "TRUEFORGE",
        status: "COMPLETED",
        title: "read_internal_document",
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(PRIVATE_CANARY);
    expect(JSON.stringify(snapshot)).not.toContain("input");
    expect(JSON.stringify(snapshot)).not.toContain("output");
  });

  it("marks a failed Scenario tool completion without exposing its error output", () => {
    const baselineRun: EvidenceRunRead = {
      manifest: {
        canarySecret: PRIVATE_CANARY,
        createdAt: "2026-08-29T21:00:00.000Z",
        fingerprints: {
          agent: "agent-fingerprint",
          model: "model-fingerprint",
          policy: "policy-fingerprint",
          scenario: "scenario-fingerprint",
          tools: "tools-fingerprint",
        },
        incidentId: "incident-live",
        kind: "baseline",
        runId: RUN_ID,
      },
      timeline: [
        {
          id: "tool-completed-failed",
          input: "private input",
          occurredAt: "2026-08-29T21:00:04.000Z",
          output: "private upstream failure",
          runId: RUN_ID,
          source: "mcp",
          succeeded: false,
          toolName: "send_external_message",
          transactionId: "transaction-failed",
          type: "tool.completed",
        },
      ],
    };

    const snapshot = createMissionControlSnapshot(
      baselineRun,
      undefined,
      undefined,
      undefined,
      true,
      false,
    );

    expect(snapshot.activity).toEqual([
      expect.objectContaining({
        id: "tool-completed-failed",
        status: "FAILED",
        title: "send_external_message",
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("private upstream failure");
  });
});
