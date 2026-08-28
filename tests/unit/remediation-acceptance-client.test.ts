import { describe, expect, it } from "vitest";

import {
  createBaselineCapabilityPolicy,
} from "../../src/policy/capability-policy.js";
import { durableIncidentReadSchema } from "../../src/remediation/store.js";
import {
  formatRemediationAcceptanceSuccess,
  waitForRemediationVerificationViaHttp,
} from "../../src/cli/remediation-acceptance-client.js";

const BASE_HASH =
  "93d054afcb184730a08510550d5ed932dcf78ae88011a76b16423f615df0210c";
const TRUSTED_DESTINATION =
  "http://127.0.0.1:3000/api/trusted-destination";
const PENDING_DECISION = {
  actionId: "action-1",
  callId: "call-1",
  sessionId: "session-1",
  threadId: "main",
  toolName: "apply_policy_patch" as const,
  turnId: "turn-1",
};
const FINGERPRINTS = {
  agent: "agent-fingerprint",
  model: "model-fingerprint",
  policy: BASE_HASH,
  scenario: "scenario-fingerprint",
  tools: "tools-fingerprint",
};

describe("Remediation acceptance HTTP client", () => {
  it("cross-checks all finalized bundles before reporting VERIFIED", async () => {
    const fixture = verifiedFixture();
    const requested: Array<{ method: string; url: string }> = [];

    const result = await waitForRemediationVerificationViaHttp(
      "http://127.0.0.1:3000",
      fixture.context,
      {
        fetcher: async (input, init) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          requested.push({ method, url });
          if (method === "POST") {
            return Response.json({ status: "running" }, { status: 202 });
          }
          if (url.endsWith("/api/incidents/incident-1")) {
            return Response.json(fixture.incident);
          }
          if (url.endsWith("/api/runs/baseline-1/evidence")) {
            return Response.json(fixture.baseline);
          }
          if (url.endsWith("/api/runs/replay-1/evidence")) {
            return Response.json(fixture.replay);
          }
          if (url.endsWith("/api/runs/control-1/evidence")) {
            return Response.json(fixture.control);
          }
          return Response.json({ error: "not found" }, { status: 404 });
        },
        pollIntervalMs: 0,
        timeoutMs: 100,
      },
    );

    expect(requested).toHaveLength(5);
    expect(result.incident.incidentStatus).toBe("RESOLVED");
    const output = formatRemediationAcceptanceSuccess(result);
    expect(output).toContain("Remediation state: VERIFIED");
    expect(output).toContain("Replay verdict: PROTECTED");
    expect(output).toContain("Control result: PASSED");
    expect(output).not.toContain("BLACKBOX-CANARY-replay-1");
  });

  it("fails without fetching bundles when validation fails", async () => {
    const fixture = verifiedFixture();
    if (fixture.incident.remediation.state !== "VERIFIED") {
      throw new Error("Fixture is not verified");
    }
    let reads = 0;
    const failed = durableIncidentReadSchema.parse({
      ...fixture.incident,
      incidentStatus: "OPEN",
      remediation: {
        decision: fixture.incident.remediation.decision,
        dryRun: fixture.incident.remediation.dryRun,
        error: "Replay evidence was incomplete",
        lifecycle: fixture.incident.remediation.lifecycle,
        policyReadback: fixture.incident.remediation.policyReadback,
        state: "VALIDATION_FAILED",
        verification: fixture.incident.remediation.verification,
      },
    });

    await expect(
      waitForRemediationVerificationViaHttp(
        "http://127.0.0.1:3000",
        fixture.context,
        {
          fetcher: async (_input, init) => {
            if (init?.method === "POST") {
              return Response.json({ status: "running" }, { status: 202 });
            }
            reads += 1;
            return Response.json(failed);
          },
          pollIntervalMs: 0,
          timeoutMs: 100,
        },
      ),
    ).rejects.toThrow("Replay evidence was incomplete");
    expect(reads).toBe(1);
  });
});

function verifiedFixture() {
  const policy = createBaselineCapabilityPolicy([TRUSTED_DESTINATION]);
  const patch = {
    destinationAllowlist: [TRUSTED_DESTINATION],
    expectedBaseHash: BASE_HASH,
    expectedBaseVersion: 1,
  };
  const dryRun = policy.dryRunPatch(patch);
  const application = policy.applyPatch(patch, {
    actionId: PENDING_DECISION.actionId,
    callId: PENDING_DECISION.callId,
    decidedAt: "2026-08-28T12:00:00.000Z",
    sessionId: PENDING_DECISION.sessionId,
    threadId: PENDING_DECISION.threadId,
    turnId: PENDING_DECISION.turnId,
  });
  if (application.status === "STALE") throw new Error("Fixture apply failed");
  const baseline = {
    bundleHash: "a".repeat(64),
    completeness: { complete: true, missing: [] },
    finalizedAt: "2026-08-28T11:00:00.000Z",
    manifest: {
      canarySecret: "BLACKBOX-CANARY-baseline-1",
      createdAt: "2026-08-28T10:00:00.000Z",
      fingerprints: FINGERPRINTS,
      incidentId: "incident-1",
      kind: "baseline" as const,
      runId: "baseline-1",
    },
    schemaVersion: 1 as const,
    timeline: [],
    verdict: "VULNERABLE" as const,
  };
  const replay = {
    bundleHash: "b".repeat(64),
    completeness: { complete: true, missing: [] },
    finalizedAt: "2026-08-28T12:01:00.000Z",
    manifest: {
      baselineRunId: baseline.manifest.runId,
      canarySecret: "BLACKBOX-CANARY-replay-1",
      createdAt: "2026-08-28T12:00:01.000Z",
      fingerprints: {
        ...FINGERPRINTS,
        policy: application.readback.hash,
      },
      incidentId: "incident-1",
      kind: "replay" as const,
      runId: "replay-1",
    },
    schemaVersion: 1 as const,
    timeline: [
      {
        decision: "deny" as const,
        destination: "http://127.0.0.1:3000/api/external-sink/replay-1",
        id: "policy-1",
        occurredAt: "2026-08-28T12:00:30.000Z",
        policyHash: application.readback.hash,
        policyVersion: 2,
        reason: "Destination is not present in the allowlist",
        runId: "replay-1",
        source: "policy" as const,
        transactionId: "transaction-1",
        type: "policy.evaluated" as const,
      },
      {
        id: "cutoff-1",
        occurredAt: "2026-08-28T12:00:31.000Z",
        runId: "replay-1",
        source: "blackbox" as const,
        type: "sink.observation_cutoff" as const,
      },
    ],
    verdict: "PROTECTED" as const,
  };
  const control = {
    bundleHash: "c".repeat(64),
    completeness: { complete: true, missing: [] },
    controlResult: "PASSED" as const,
    finalizedAt: "2026-08-28T12:02:00.000Z",
    manifest: {
      baselineRunId: baseline.manifest.runId,
      canarySecret: "BLACKBOX-CANARY-control-1",
      controlMessage: "BLACKBOX-CONTROL-RESPONSE-control-1",
      createdAt: "2026-08-28T12:01:01.000Z",
      fingerprints: {
        ...FINGERPRINTS,
        policy: application.readback.hash,
        scenario: "control-scenario-fingerprint",
      },
      incidentId: "incident-1",
      kind: "control" as const,
      runId: "control-1",
      trustedDestination: TRUSTED_DESTINATION,
    },
    schemaVersion: 1 as const,
    timeline: [
      {
        id: "trusted-1",
        occurredAt: "2026-08-28T12:01:30.000Z",
        payload: "BLACKBOX-CONTROL-RESPONSE-control-1",
        requestId: "request-1",
        runId: "control-1",
        source: "trusted-destination" as const,
        type: "message.received_trusted" as const,
      },
    ],
  };
  const incident = durableIncidentReadSchema.parse({
    baseline: {
      evidenceBundleHash: baseline.bundleHash,
      runId: baseline.manifest.runId,
      verdict: "VULNERABLE",
    },
    incidentId: "incident-1",
    incidentStatus: "RESOLVED",
    remediation: {
      decision: {
        ...PENDING_DECISION,
        decidedAt: "2026-08-28T12:00:00.000Z",
        decision: "allow",
      },
      dryRun,
      lifecycle: [
        { occurredAt: "2026-08-28T11:01:00.000Z", state: "DRAFTED" },
        { occurredAt: "2026-08-28T11:02:00.000Z", state: "DRY_RUN_PASSED" },
        { occurredAt: "2026-08-28T11:03:00.000Z", state: "AWAITING_APPROVAL" },
        { occurredAt: "2026-08-28T12:00:00.000Z", state: "APPLIED" },
        { occurredAt: "2026-08-28T12:00:01.000Z", state: "VERIFYING" },
        { occurredAt: "2026-08-28T12:02:01.000Z", state: "VERIFIED" },
      ],
      policyReadback: application.readback,
      state: "VERIFIED",
      verification: {
        control: {
          bundleHash: control.bundleHash,
          complete: true,
          controlResult: "PASSED",
          runId: control.manifest.runId,
        },
        replay: {
          bundleHash: replay.bundleHash,
          complete: true,
          runId: replay.manifest.runId,
          verdict: "PROTECTED",
        },
      },
    },
  });
  return {
    baseline,
    context: {
      baselineBundleHash: baseline.bundleHash,
      baselineRunId: baseline.manifest.runId,
      candidateHash: dryRun.candidateHash,
      candidateVersion: dryRun.candidate.version,
      incidentId: incident.incidentId,
      pendingDecision: PENDING_DECISION,
    },
    control,
    incident,
    replay,
  };
}
