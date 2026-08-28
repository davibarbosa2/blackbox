import { describe, expect, it } from "vitest";

import {
  formatInvestigationAcceptanceSuccess,
  waitForInvestigationViaHttp,
} from "../../src/cli/investigation-acceptance-client.js";
import type { EvidenceBundle } from "../../src/evidence/ledger.js";
import { createBaselineCapabilityPolicy } from "../../src/policy/capability-policy.js";
import type { DurableIncidentRead } from "../../src/remediation/store.js";

const TRUSTED_DESTINATION =
  "http://127.0.0.1:3000/api/trusted-destination";
const policy = createBaselineCapabilityPolicy([TRUSTED_DESTINATION]);
const BUNDLE = {
  bundleHash: "a".repeat(64),
  completeness: { complete: true, missing: [] },
  finalizedAt: "2026-08-27T20:00:08.000Z",
  manifest: {
    canarySecret: "BLACKBOX-CANARY-secret",
    createdAt: "2026-08-27T20:00:00.000Z",
    fingerprints: {
      agent: "agent-fingerprint",
      model: "model-fingerprint",
      policy: policy.fingerprint(),
      scenario: "scenario-fingerprint",
      tools: "tools-fingerprint",
    },
    incidentId: "incident-1",
    kind: "baseline",
    runId: "run-1",
  },
  schemaVersion: 1,
  timeline: [],
  verdict: "VULNERABLE",
} satisfies EvidenceBundle;
const PENDING_INCIDENT = {
  baseline: {
    evidenceBundleHash: BUNDLE.bundleHash,
    runId: BUNDLE.manifest.runId,
    verdict: "VULNERABLE",
  },
  incidentId: BUNDLE.manifest.incidentId,
  remediation: {
    analysis: {
      execution: {
        exitCode: 0,
        stdout: "BLACKBOX_INVESTIGATION_ANALYSIS_OK\n",
        toolCallId: "call-exec",
      },
      sandbox: {
        event: "sandbox.created",
        id: "v1:daytona:default.investigation-1",
      },
    },
    diagnosis: {
      canonicalCause:
        "missing_destination_allowlist_in_send_external_message",
      summary: "Missing outbound destination allowlist",
    },
    dryRun: policy.dryRunPatch({
      destinationAllowlist: [TRUSTED_DESTINATION],
      expectedBaseHash: policy.fingerprint(),
      expectedBaseVersion: 1,
    }),
    evidenceJustification: {
      bundleHash: BUNDLE.bundleHash,
      runId: BUNDLE.manifest.runId,
      summary: "The exact Canary Secret reached the sink.",
    },
    lifecycle: [
      { occurredAt: "2026-08-27T20:00:09.000Z", state: "DRAFTED" },
      { occurredAt: "2026-08-27T20:00:10.000Z", state: "DRY_RUN_PASSED" },
      { occurredAt: "2026-08-27T20:00:11.000Z", state: "AWAITING_APPROVAL" },
    ],
    pendingDecision: {
      actionId: "action-1",
      callId: "call-1",
      sessionId: "session-1",
      toolName: "apply_policy_patch",
      turnId: "turn-1",
    },
    state: "AWAITING_APPROVAL",
    subagents: [
      {
        createdEventId: "created-1",
        doneEventId: "done-1",
        status: "done",
        threadId: "thread-evidence",
        title: "evidence-analysis",
      },
      {
        createdEventId: "created-2",
        doneEventId: "done-2",
        status: "done",
        threadId: "thread-policy",
        title: "policy-analysis",
      },
    ],
  },
} satisfies DurableIncidentRead;

describe("Investigation acceptance HTTP client", () => {
  it("waits for the durable pending action and prints no Canary Secret", async () => {
    let reads = 0;
    const incident = await waitForInvestigationViaHttp(
      "http://127.0.0.1:3000",
      BUNDLE,
      {
        fetcher: async () => {
          reads += 1;
          return Response.json(
            reads === 3
              ? PENDING_INCIDENT
              : {
                  baseline: PENDING_INCIDENT.baseline,
                  incidentId: PENDING_INCIDENT.incidentId,
                  remediation:
                    reads === 1
                      ? { lifecycle: [], state: "INVESTIGATING" }
                      : {
                          lifecycle: [
                            {
                              occurredAt: "2026-08-27T20:00:09.000Z",
                              state: "DRAFTED",
                            },
                          ],
                          state: "DRAFTED",
                        },
                },
          );
        },
        pollIntervalMs: 0,
      },
    );

    expect(reads).toBe(3);
    expect(incident).toEqual(PENDING_INCIDENT);
    const output = formatInvestigationAcceptanceSuccess(incident);
    expect(output).toContain("Investigation state: AWAITING_APPROVAL");
    expect(output).toContain("action=action-1 call=call-1");
    expect(output).not.toContain("BLACKBOX-CANARY-secret");
  });
});
