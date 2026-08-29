// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { App } from "../../mission-control/App.js";
import {
  type MissionControlSnapshot,
  missionControlSnapshotSchema,
} from "../../src/mission-control/schema.js";

const BASE_HASH = "a".repeat(64);
const BUNDLE_HASH = "b".repeat(64);
const CANDIDATE_HASH = "c".repeat(64);
const PENDING_DECISION = {
  actionId: "action-1",
  callId: "call-1",
  sessionId: "session-1",
  threadId: "main",
  toolName: "apply_policy_patch" as const,
  turnId: "turn-1",
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(): void {
    this.open = false;
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Mission Control browser workflow", () => {
  it("surfaces a connection failure and retries the durable read", async () => {
    let readCount = 0;
    const fetcher = vi.fn(async () => {
      readCount += 1;
      return readCount === 1
        ? jsonResponse(readySnapshot(), 503)
        : jsonResponse(readySnapshot());
    });
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Mission Control read failed with HTTP 503",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));

    expect(
      await screen.findByRole("button", { name: /Start live Incident/ }),
    ).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("starts the real Incident once and aborts polling on unmount", async () => {
    let releaseStart = (): void => undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let pollingSignal: AbortSignal | null = null;
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/incidents") {
        await startGate;
        return jsonResponse(readySnapshot(), 202);
      }
      if (pollingSignal === null && init?.signal !== undefined) {
        pollingSignal = init.signal;
      }
      return jsonResponse(readySnapshot());
    });
    vi.stubGlobal("fetch", fetcher);

    const view = render(<App />);
    const start = await screen.findByRole("button", {
      name: /Start live Incident/,
    });
    fireEvent.click(start);
    fireEvent.click(start);

    await waitFor(() => {
      expect(
        fetcher.mock.calls.filter(([input]) => input === "/api/incidents"),
      ).toHaveLength(1);
    });
    expect(start.getAttribute("aria-busy")).toBe("true");

    releaseStart();
    await waitFor(() => {
      expect(start.getAttribute("aria-busy")).toBe("false");
    });
    view.unmount();
    expect(pollingSignal?.aborted).toBe(true);
  });

  it("shows investigation proof and submits the exact approval action", async () => {
    let releaseDecision = (): void => undefined;
    const decisionGate = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    const snapshot = awaitingApprovalSnapshot();
    const fetcher = vi.fn(async (input: string) => {
      if (input.includes("/remediation-decisions")) {
        await decisionGate;
        return jsonResponse(readySnapshot(), 202);
      }
      return jsonResponse(snapshot);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Policy Patch Reviewer")).not.toBeNull();
    expect(
      within(dialog).getByText("Evidence Provenance Verifier"),
    ).not.toBeNull();
    expect(
      within(dialog).getByText("Sandbox analysis completed"),
    ).not.toBeNull();

    const approve = screen.getByRole("button", {
      name: /Approve & verify automatically/,
    });
    fireEvent.click(approve);
    await waitFor(() => {
      expect(approve.getAttribute("aria-busy")).toBe("true");
    });

    const decisionCall = fetcher.mock.calls.find(([input]) =>
      input.includes("/remediation-decisions"),
    );
    expect(decisionCall?.[0]).toBe(
      "/api/incidents/incident-1/remediation-decisions",
    );
    expect(JSON.parse(String(decisionCall?.[1]?.body))).toEqual({
      decision: "allow",
      pendingDecision: PENDING_DECISION,
    });

    releaseDecision();
  });

  it("renders an inconclusive replay without calling it failed and surfaces denial errors", async () => {
    const snapshot = failedVerificationSnapshot();
    const fetcher = vi.fn(async (input: string) => {
      if (input.includes("/remediation-decisions")) {
        return jsonResponse(readySnapshot(), 500);
      }
      return jsonResponse(awaitingApprovalSnapshot());
    });
    vi.stubGlobal("fetch", fetcher);

    const view = render(<App />);
    const deny = await screen.findByRole("button", { name: "Deny patch" });
    fireEvent.click(deny);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Remediation decision failed with HTTP 500",
    );
    const denialCall = fetcher.mock.calls.find(([input]) =>
      input.includes("/remediation-decisions"),
    );
    expect(JSON.parse(String(denialCall?.[1]?.body))).toEqual({
      decision: "deny",
      pendingDecision: PENDING_DECISION,
    });

    view.unmount();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));
    render(<App />);
    const replayHeading = await screen.findByRole("heading", {
      name: "Attack Replay",
    });
    const replayStep = replayHeading.closest("article");
    expect(replayStep?.getAttribute("data-state")).toBe("inconclusive");
    expect(replayStep?.textContent).toContain("Inconclusive");
    expect(replayStep?.textContent).toContain("!");
  });
});

function readySnapshot(): MissionControlSnapshot {
  return missionControlSnapshotSchema.parse({
    activity: [],
    approval: null,
    baseline: null,
    comparison: null,
    decisionPending: false,
    failure: null,
    incident: null,
    phase: "READY",
    status: "READY",
    verification: null,
  });
}

function awaitingApprovalSnapshot(): MissionControlSnapshot {
  return missionControlSnapshotSchema.parse({
    ...incidentSnapshot(),
    activity: [
      activity(
        "subagent-policy",
        "subagent",
        "TRUEFORGE",
        "Policy Patch Reviewer",
      ),
      activity(
        "subagent-evidence",
        "subagent",
        "TRUEFORGE",
        "Evidence Provenance Verifier",
      ),
      activity("sandbox", "sandbox", "DAYTONA", "Sandbox analysis completed"),
    ],
    approval: {
      affectedCapability: "send_external_message",
      base: { hash: BASE_HASH, version: 1 },
      candidate: {
        rules: {
          read_internal_document: "allow",
          send_external_message: {
            destinations: ["http://127.0.0.1:3000/api/trusted-destination"],
          },
        },
        version: 2,
      },
      candidateHash: CANDIDATE_HASH,
      diff: [
        {
          after: ["http://127.0.0.1:3000/api/trusted-destination"],
          before: "*",
          operation: "replace",
          path: "/rules/send_external_message/destinations",
        },
      ],
      evidenceJustification: {
        bundleHash: BUNDLE_HASH,
        runId: "run-1",
        summary: "The finalized Baseline bundle proves the controlled receipt.",
      },
      expectedReplayBehavior: {
        blockedAt: "send_external_message",
        matchingSinkReceipt: false,
        policyDecision: "deny",
        verdict: "PROTECTED",
      },
      pendingDecision: PENDING_DECISION,
      predictedOperationalImpact: {
        deniedDestinations: "all destinations outside the allowlist",
        protectedDocumentAccess: "unchanged",
        trustedDestinations: [
          "http://127.0.0.1:3000/api/trusted-destination",
        ],
      },
    },
    phase: "APPROVAL",
    status: "AWAITING_APPROVAL",
  });
}

function failedVerificationSnapshot(): MissionControlSnapshot {
  return missionControlSnapshotSchema.parse({
    ...incidentSnapshot(),
    failure: {
      detail: "The replay did not complete its evidence gates.",
      title: "Remediation validation failed",
    },
    phase: "RESULT",
    status: "VALIDATION_FAILED",
    verification: {
      control: { result: "PASSED", runId: "control-1", state: "COMPLETED" },
      policyReadback: { hash: CANDIDATE_HASH, state: "MATCHED", version: 2 },
      replay: {
        result: "INCONCLUSIVE",
        runId: "replay-1",
        state: "INCONCLUSIVE",
      },
    },
  });
}

function incidentSnapshot(): MissionControlSnapshot {
  return missionControlSnapshotSchema.parse({
    activity: [],
    approval: null,
    baseline: {
      bundleHash: BUNDLE_HASH,
      complete: true,
      evidenceUrl: "/api/runs/run-1/evidence",
      runId: "run-1",
      verdict: "VULNERABLE",
    },
    comparison: {
      baseline: {
        bundleHash: BUNDLE_HASH,
        complete: true,
        evidenceUrl: "/api/runs/run-1/evidence",
        exactCanaryReceipts: 1,
        result: "VULNERABLE",
        runId: "run-1",
      },
      containment: null,
      control: null,
      replay: null,
    },
    decisionPending: false,
    failure: null,
    incident: { id: "incident-1", status: "OPEN" },
    phase: "INVESTIGATION",
    status: "INVESTIGATING",
    verification: null,
  });
}

function activity(
  id: string,
  kind: "sandbox" | "subagent",
  source: "DAYTONA" | "TRUEFORGE",
  title: string,
) {
  return {
    detail: "Recorded in durable Incident state.",
    evidence: null,
    id,
    kind,
    occurredAt: null,
    source,
    status: "COMPLETED" as const,
    title,
  };
}

function jsonResponse(body: MissionControlSnapshot, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}
