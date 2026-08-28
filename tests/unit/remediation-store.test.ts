import { describe, expect, it } from "vitest";

import { createBaselineCapabilityPolicy } from "../../src/policy/capability-policy.js";
import { SqliteRemediationStore } from "../../src/remediation/store.js";

describe("durable remediation failures", () => {
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
      toolName: "apply_policy_patch",
      turnId: "turn-1",
    });

    expect(store.read("incident-1")?.remediation).toMatchObject({
      dryRun,
      lifecycle: [{ state: "DRAFTED" }, { state: "DRY_RUN_PASSED" }],
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
});
