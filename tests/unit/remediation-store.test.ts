import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createBaselineCapabilityPolicy } from "../../src/policy/capability-policy.js";
import {
  type AwaitingApprovalRemediation,
  SqliteRemediationStore,
} from "../../src/remediation/store.js";

describe("durable remediation failures", () => {
  it("records sanitized investigation milestones idempotently and resets a retried session", () => {
    const store = new SqliteRemediationStore(":memory:");
    store.start("incident-1", "run-1", "a".repeat(64));
    const first = {
      kind: "TURN_STARTED" as const,
      occurredAt: "2026-08-28T12:00:00.000Z",
      sessionId: "session-1",
      sourceEventId: "event-turn-1",
    };
    store.recordInvestigationMilestone("incident-1", first);
    store.recordInvestigationMilestone("incident-1", first);
    store.recordInvestigationMilestone("incident-1", {
      kind: "INVESTIGATOR_MCP_INITIALIZED",
      occurredAt: "2026-08-28T12:00:01.000Z",
      sessionId: "session-1",
      sourceEventId: "event-mcp-1",
    });

    expect(store.read("incident-1")?.remediation).toMatchObject({
      investigationProgress: {
        milestones: [first, { sourceEventId: "event-mcp-1" }],
        sessionId: "session-1",
      },
      state: "INVESTIGATING",
    });

    const retry = {
      ...first,
      sessionId: "session-2",
      sourceEventId: "event-turn-2",
    };
    store.recordInvestigationMilestone("incident-1", retry);
    store.drafted("incident-1");

    expect(store.read("incident-1")?.remediation).toMatchObject({
      investigationProgress: {
        milestones: [retry],
        sessionId: "session-2",
      },
      state: "DRAFTED",
    });
    store.close();
  });

  it("preserves the dry-run and observed pending identifiers", () => {
    const trustedDestination = "https://trusted.example/messages";
    const policy = createBaselineCapabilityPolicy([trustedDestination]);
    const snapshot = policy.read();
    const dryRun = policy.dryRunPatch({
      destinationAllowlist: [trustedDestination],
      expectedBaseHash: snapshot.hash,
      expectedBaseVersion: snapshot.version,
    });
    const store = new SqliteRemediationStore(":memory:");
    store.start("incident-1", "run-1", "a".repeat(64));
    store.drafted("incident-1");
    store.dryRunPassed("incident-1", dryRun);

    store.validationFailed("incident-1", "approval persistence failed", {
      actionId: "action-1",
      callId: "call-1",
      sessionId: "session-1",
      threadId: "main",
      toolName: "apply_policy_patch",
      turnId: "turn-1",
    });

    expect(store.read("incident-1")?.remediation).toMatchObject({
      dryRun,
      lifecycle: [
        { state: "DRAFTED" },
        { state: "DRY_RUN_PASSED" },
        { state: "VALIDATION_FAILED" },
      ],
      pendingDecision: {
        actionId: "action-1",
        callId: "call-1",
        sessionId: "session-1",
        turnId: "turn-1",
      },
      state: "VALIDATION_FAILED",
    });
    store.close();
  });

  it("records denial without resolving the Incident or changing policy readback", () => {
    const policy = createBaselineCapabilityPolicy(["https://trusted.example"]);
    const snapshot = policy.read();
    const dryRun = policy.dryRunPatch({
      destinationAllowlist: ["https://trusted.example"],
      expectedBaseHash: snapshot.hash,
      expectedBaseVersion: snapshot.version,
    });
    const store = new SqliteRemediationStore(":memory:");
    store.start("incident-1", "run-1", "a".repeat(64), "run-capability");
    store.drafted("incident-1");
    store.dryRunPassed("incident-1", dryRun);
    store.awaitingApproval("incident-1", {
      ...awaitingApprovalEvidence(),
      dryRun,
    });

    store.denied("incident-1", {
      ...awaitingApprovalEvidence().pendingDecision,
      decidedAt: "2026-08-28T12:00:00.000Z",
      decision: "deny",
    }, snapshot);

    expect(store.read("incident-1")).toMatchObject({
      incidentStatus: "OPEN",
      remediation: {
        decision: { decision: "deny" },
        policyReadback: snapshot,
        state: "DENIED",
      },
    });
    expect(store.readMcpAuthorization("incident-1")).toBe("run-capability");
    store.close();
  });

  it("migrates a legacy pending action without thread identity to a non-resumable failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "blackbox-remediation-"));
    const databasePath = join(directory, "blackbox.sqlite");
    try {
      const trustedDestination = "https://trusted.example/messages";
      const policy = createBaselineCapabilityPolicy([trustedDestination]);
      const base = policy.read();
      const dryRun = policy.dryRunPatch({
        destinationAllowlist: [trustedDestination],
        expectedBaseHash: base.hash,
        expectedBaseVersion: base.version,
      });
      const evidence = awaitingApprovalEvidence();
      const { threadId: _threadId, ...legacyPendingDecision } =
        evidence.pendingDecision;
      const database = new DatabaseSync(databasePath);
      database.exec(`
        CREATE TABLE incidents (
          incident_id TEXT PRIMARY KEY,
          record_json TEXT NOT NULL
        );
      `);
      database
        .prepare(
          "INSERT INTO incidents (incident_id, record_json) VALUES (?, ?)",
        )
        .run(
          "incident-legacy",
          JSON.stringify({
            baseline: {
              evidenceBundleHash: "a".repeat(64),
              runId: "run-legacy",
              verdict: "VULNERABLE",
            },
            incidentId: "incident-legacy",
            remediation: {
              ...evidence,
              dryRun,
              pendingDecision: legacyPendingDecision,
              state: "AWAITING_APPROVAL",
            },
          }),
        );
      database.close();

      const store = new SqliteRemediationStore(databasePath);
      expect(store.read("incident-legacy")).toMatchObject({
        incidentStatus: "OPEN",
        remediation: {
          error:
            "Persisted pending action predates required thread identity and cannot be safely resumed",
          lifecycle: [{ state: "VALIDATION_FAILED" }],
          state: "VALIDATION_FAILED",
        },
      });
      store.close();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function awaitingApprovalEvidence(): Omit<
  AwaitingApprovalRemediation,
  "dryRun" | "lifecycle" | "state"
> {
  return {
    analysis: {
      artifact: {
        commandHash: "b".repeat(64),
        path: "/tmp/blackbox-investigation-analysis.py" as const,
      },
      execution: {
        exitCode: 0 as const,
        stdout: "BLACKBOX_INVESTIGATION_ANALYSIS_OK",
        toolCallId: "call-exec",
      },
      result: {
        bundleHash: "a".repeat(64),
        canarySha256: "c".repeat(64),
        canonicalCause:
          "missing_destination_allowlist_in_send_external_message" as const,
        policyHash: "d".repeat(64),
        runId: "run-1",
      },
      sandbox: { event: "sandbox.created" as const, id: "sandbox-1" },
    },
    diagnosis: {
      canonicalCause:
        "missing_destination_allowlist_in_send_external_message" as const,
      summary: "Missing destination allowlist",
    },
    evidenceJustification: {
      bundleHash: "a".repeat(64),
      runId: "run-1",
      summary: "Evidence-backed proposal",
    },
    pendingDecision: {
      actionId: "action-1",
      callId: "call-1",
      sessionId: "session-1",
      threadId: "main",
      toolName: "apply_policy_patch" as const,
      turnId: "turn-1",
    },
    subagents: [
      {
        createdEventId: "created-policy",
        doneEventId: "done-policy",
        inputHash: "e".repeat(64),
        output: {
          marker: "POLICY_PATCH_REVIEWED" as const,
          policyHash: "d".repeat(64),
          policyVersion: 1,
          protectedDocumentAccess: "unchanged" as const,
          trustedDestination: "https://trusted.example",
        },
        outputHash: "f".repeat(64),
        role: "PolicyPatchReviewer" as const,
        status: "done" as const,
        threadId: "thread-policy",
        title: "PolicyPatchReviewer",
      },
      {
        createdEventId: "created-evidence",
        doneEventId: "done-evidence",
        inputHash: "1".repeat(64),
        output: {
          bundleHash: "a".repeat(64),
          canonicalCause:
            "missing_destination_allowlist_in_send_external_message" as const,
          marker: "EVIDENCE_PROVENANCE_VERIFIED" as const,
          runId: "run-1",
        },
        outputHash: "2".repeat(64),
        role: "EvidenceProvenanceVerifier" as const,
        status: "done" as const,
        threadId: "thread-evidence",
        title: "EvidenceProvenanceVerifier",
      },
    ],
  };
}
