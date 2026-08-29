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
    let releaseRetry = (): void => undefined;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let readCount = 0;
    const fetcher = vi.fn(async () => {
      readCount += 1;
      if (readCount === 1) return jsonResponse(readySnapshot(), 503);
      await retryGate;
      return jsonResponse(readySnapshot());
    });
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Mission Control read failed with HTTP 503",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));

    const retrying = screen.getByRole("button", { name: "Retrying connection" });
    expect(retrying.getAttribute("aria-busy")).toBe("true");
    expect(retrying.hasAttribute("disabled")).toBe(true);
    fireEvent.click(retrying);
    expect(fetcher).toHaveBeenCalledTimes(2);
    releaseRetry();

    expect(
      await screen.findByRole("button", { name: /Run the live Incident/ }),
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
      name: /Run the live Incident/,
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

  it("frames one concise human decision and submits the exact approval action", async () => {
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
    expect(
      within(dialog).getByRole("heading", {
        name: "Allow messages only to the trusted support endpoint?",
      }),
    ).not.toBeNull();
    expect(
      within(dialog).getByText("Same attack will be blocked"),
    ).not.toBeNull();
    expect(
      within(dialog).getByRole("link", { name: /Open in TrueForge/ }),
    ).not.toBeNull();
    expect(dialog.querySelector("details")?.open).toBe(false);
    expect(dialog.textContent).toContain("Affected capability");
    expect(dialog.textContent).toContain("send_external_message");
    expect(dialog.textContent).toContain("Predicted operational impact");
    expect(dialog.textContent).toContain("Evidence justification");
    expect(
      screen.getAllByText("Evidence Provenance Verifier"),
    ).toHaveLength(2);
    const cancelEvent = new Event("cancel", { cancelable: true });
    fireEvent(dialog, cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);

    const approve = screen.getByRole("button", {
      name: /Approve exact Policy Patch/,
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

  it("shows neutral pending-decision progress when the submitted choice is unknown", async () => {
    const snapshot = missionControlSnapshotSchema.parse({
      ...awaitingApprovalSnapshot(),
      decisionPending: true,
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Decision submitted");
    expect(status.querySelector(".loading-icon")).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Policy decision is being recorded" }),
    ).not.toBeNull();
    expect(screen.queryByText("Decision required")).toBeNull();
    expect(screen.queryByRole("button", { name: /Approve exact/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep current policy" })).toBeNull();
  });

  it("renders an inconclusive replay without calling it failed and surfaces denial errors", async () => {
    const snapshot = failedVerificationSnapshot();
    let releaseDenial = (): void => undefined;
    const denialGate = new Promise<void>((resolve) => {
      releaseDenial = resolve;
    });
    const fetcher = vi.fn(async (input: string) => {
      if (input.includes("/remediation-decisions")) {
        await denialGate;
        return jsonResponse(readySnapshot(), 500);
      }
      return jsonResponse(awaitingApprovalSnapshot());
    });
    vi.stubGlobal("fetch", fetcher);

    const view = render(<App />);
    const deny = await screen.findByRole("button", {
      name: "Keep current policy",
    });
    fireEvent.click(deny);
    await waitFor(() => expect(deny.getAttribute("aria-busy")).toBe("true"));
    expect(deny.textContent).toContain("Recording decision");
    expect(deny.querySelector(".loading-icon")).not.toBeNull();
    releaseDenial();
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
    const journey = screen.getByRole("navigation", { name: "Incident journey" });
    expect(within(journey).getByText("Decide").closest("li")?.dataset.state).toBe(
      "complete",
    );
    expect(within(journey).getByText("Verify").closest("li")?.dataset.state).toBe(
      "incomplete",
    );
  });

  it("makes the verified result a distinct final act with one dominant conclusion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(verifiedSnapshot())));

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Attack blocked. Support still works.",
      }),
    ).not.toBeNull();
    const progress = screen.getByRole("navigation", {
      name: "Incident journey",
    });
    const resultStage = within(progress).getByText("Result").closest("li");
    expect(resultStage?.getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("1 exact Canary receipt")).not.toBeNull();
    expect(screen.getByText("0 matching sink receipts")).not.toBeNull();
    expect(screen.getByText("1 trusted destination receipt")).not.toBeNull();
    const trace = screen.getByText("Evidence & agent trace").closest("details");
    expect(trace?.open).toBe(false);
    expect(
      screen.queryByText("No further operator action required"),
    ).toBeNull();
  });

  it("shows real streamed TrueForge work as active instead of waiting", async () => {
    const snapshot = missionControlSnapshotSchema.parse({
      ...incidentSnapshot(),
      activity: [
        {
          detail: "Sanitized durable TrueForge stream milestone.",
          evidence: null,
          id: "event-review-started",
          kind: "subagent",
          occurredAt: "2026-08-29T21:00:00.000Z",
          scope: "INVESTIGATION",
          source: "TRUEFORGE",
          status: "ACTIVE",
          title: "Evidence provenance review started",
        },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    const task = (await screen.findByText("Evidence Provenance Verifier")).closest(
      ".agent-task",
    );
    expect(task?.getAttribute("data-state")).toBe("active");
    expect(task?.textContent).toContain("Live");
  });

  it("advances Baseline progress only from durable activity", async () => {
    const snapshot = baselineRunningSnapshot([
      {
        detail: "Observed in the durable TrueForge event sequence.",
        evidence: null,
        id: "tool-read-document",
        kind: "tool",
        occurredAt: "2026-08-29T21:00:00.000Z",
        scope: "BASELINE",
        source: "TRUEFORGE",
        status: "COMPLETED",
        title: "read_internal_document",
      },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Following the Canary" }),
    ).not.toBeNull();
    expect(screen.getByText("Canary document").closest("article")?.dataset.state).toBe(
      "active",
    );
    const drawer = screen.getByText("Evidence & agent trace").closest("details");
    if (!(drawer instanceof HTMLElement)) throw new Error("Evidence drawer missing");
    fireEvent.click(within(drawer).getByText("Evidence & agent trace"));
    expect(within(drawer).getByText("Baseline Run")).not.toBeNull();
    expect(within(drawer).queryByText("TrueForge Investigation")).toBeNull();
  });

  it("keeps verification progress at lane level until durable node evidence exists", async () => {
    const snapshot = missionControlSnapshotSchema.parse({
      ...incidentSnapshot(),
      activity: [
        {
          detail: "Reported from the durable BLACKBOX Run timeline.",
          evidence: null,
          id: "replay-state-executing",
          kind: "phase",
          occurredAt: "2026-08-29T21:00:00.000Z",
          scope: "REPLAY",
          source: "BLACKBOX",
          status: "ACTIVE",
          title: "Support Agent turn in progress",
        },
      ],
      phase: "VERIFICATION",
      status: "VERIFYING",
      verification: {
        control: { result: null, runId: null, state: "WAITING" },
        policyReadback: { hash: CANDIDATE_HASH, state: "MATCHED", version: 2 },
        replay: { result: null, runId: "replay-1", state: "ACTIVE" },
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    const view = render(<App />);
    await screen.findAllByRole("heading", { name: "Attack Replay" });

    expect(view.container.querySelector('.verification-lane.attack[data-state="active"]')).not.toBeNull();
    expect(view.container.querySelectorAll('.verification-lane.attack .lane-node[data-state="active"]')).toHaveLength(0);
    const drawer = screen.getByText("Evidence & agent trace").closest("details");
    if (!(drawer instanceof HTMLElement)) throw new Error("Evidence drawer missing");
    fireEvent.click(within(drawer).getByText("Evidence & agent trace"));
    expect(within(drawer).getByText("Attack Replay")).not.toBeNull();
    expect(within(drawer).queryByText("TrueForge Investigation")).toBeNull();
  });

  it("names an investigation failure without pretending verification started", async () => {
    const snapshot = missionControlSnapshotSchema.parse({
      ...incidentSnapshot(),
      activity: [
        {
          detail: "Sanitized durable TrueForge stream milestone.",
          evidence: null,
          id: "event-review-started",
          kind: "subagent",
          occurredAt: "2026-08-29T21:00:00.000Z",
          scope: "INVESTIGATION",
          source: "TRUEFORGE",
          status: "FAILED",
          title: "Evidence provenance review started",
        },
      ],
      failure: {
        detail: "TrueForge did not complete the investigation boundary.",
        title: "Remediation validation failed",
      },
      phase: "RESULT",
      status: "VALIDATION_FAILED",
      verification: null,
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    expect(
      await screen.findAllByRole("heading", {
        name: "TrueForge investigation did not complete",
      }),
    ).toHaveLength(2);
    const journey = screen.getByRole("navigation", { name: "Incident journey" });
    expect(within(journey).getByText("Investigate").closest("li")?.dataset.state).toBe(
      "incomplete",
    );
  });

  it("records a declined human decision without showing an approval check", async () => {
    const snapshot = missionControlSnapshotSchema.parse({
      ...incidentSnapshot(),
      activity: [
        {
          detail: "The exact pending TrueForge Policy Patch action was declined by a human.",
          evidence: null,
          id: "call-1:human-decision:deny",
          kind: "phase",
          occurredAt: "2026-08-29T21:00:00.000Z",
          scope: "DECISION",
          source: "BLACKBOX",
          status: "COMPLETED",
          title: "Policy Patch declined by human",
        },
      ],
      failure: {
        detail: "The Capability Policy was not changed and verification did not start.",
        title: "Policy Patch denied",
      },
      phase: "RESULT",
      status: "DENIED",
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    const journey = await screen.findByRole("navigation", {
      name: "Incident journey",
    });
    expect(within(journey).getByText("Decide").closest("li")?.dataset.state).toBe(
      "complete",
    );
    expect(within(journey).queryByText("Approve")).toBeNull();
    const drawer = screen.getByText("Evidence & agent trace").closest("details");
    if (!(drawer instanceof HTMLElement)) throw new Error("Evidence drawer missing");
    fireEvent.click(within(drawer).getByText("Evidence & agent trace"));
    expect(within(drawer).getByText("Human decision")).not.toBeNull();
  });

  it("explains an empty evidence drawer instead of opening a blank panel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(baselineRunningSnapshot([]))),
    );

    render(<App />);
    const drawer = (await screen.findByText("Evidence & agent trace")).closest(
      "details",
    );
    if (!(drawer instanceof HTMLElement)) throw new Error("Evidence drawer missing");
    fireEvent.click(within(drawer).getByText("Evidence & agent trace"));
    expect(
      within(drawer).getByText("Waiting for the first durable record"),
    ).not.toBeNull();
  });

  it("withholds contradictory VERIFIED state when containment evidence is absent", async () => {
    const verified = verifiedSnapshot();
    const snapshot = missionControlSnapshotSchema.parse({
      ...verified,
      comparison: { ...verified.comparison, containment: null },
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    expect(
      await screen.findAllByRole("heading", { name: "Verified evidence is unavailable" }),
    ).toHaveLength(2);
    expect(
      screen.queryByRole("heading", { name: "Attack blocked. Support still works." }),
    ).toBeNull();
    const journey = screen.getByRole("navigation", { name: "Incident journey" });
    expect(within(journey).getByText("Verify").closest("li")?.dataset.state).toBe(
      "incomplete",
    );
  });

  it("does not mark breach proof complete when the Baseline is inconclusive", async () => {
    const snapshot = missionControlSnapshotSchema.parse({
      ...incidentSnapshot(),
      baseline: {
        bundleHash: BUNDLE_HASH,
        complete: true,
        evidenceUrl: "/api/runs/run-1/evidence",
        runId: "run-1",
        verdict: "INCONCLUSIVE",
      },
      comparison: null,
      phase: "RESULT",
      status: "BASELINE_INCONCLUSIVE",
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    const journey = await screen.findByRole("navigation", {
      name: "Incident journey",
    });
    expect(within(journey).getByText("Prove breach").closest("li")?.dataset.state).toBe(
      "incomplete",
    );
  });

  it("keeps the active mobile journey step in view", async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
        matches: true,
        media: "(max-width: 680px)",
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    );
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(verifiedSnapshot())));

    render(<App />);
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());

    if (original === undefined) {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    } else {
      Object.defineProperty(HTMLElement.prototype, "scrollTo", original);
    }
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
    integrations: {
      trueForgeSessionId: null,
      trueForgeUrl: "http://127.0.0.1:8790",
    },
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

function verifiedSnapshot(): MissionControlSnapshot {
  return missionControlSnapshotSchema.parse({
    ...incidentSnapshot(),
    comparison: {
      baseline: {
        bundleHash: BUNDLE_HASH,
        complete: true,
        evidenceUrl: "/api/runs/run-1/evidence",
        exactCanaryReceipts: 1,
        result: "VULNERABLE",
        runId: "run-1",
      },
      containment: {
        claim: "VERIFIED_REMEDIATION",
        evidence: [
          { bundleHash: BUNDLE_HASH, url: "/api/runs/run-1/evidence" },
          { bundleHash: CANDIDATE_HASH, url: "/api/runs/replay-1/evidence" },
          { bundleHash: BASE_HASH, url: "/api/runs/control-1/evidence" },
        ],
      },
      control: {
        bundleHash: BASE_HASH,
        complete: true,
        evidenceUrl: "/api/runs/control-1/evidence",
        result: "PASSED",
        runId: "control-1",
        trustedDestinationReceipts: 1,
      },
      replay: {
        bundleHash: CANDIDATE_HASH,
        complete: true,
        evidenceUrl: "/api/runs/replay-1/evidence",
        explicitPolicyDenial: true,
        matchingCanaryReceipts: 0,
        result: "PROTECTED",
        runId: "replay-1",
      },
    },
    incident: { id: "incident-1", status: "RESOLVED" },
    phase: "RESULT",
    status: "VERIFIED",
    verification: {
      control: { result: "PASSED", runId: "control-1", state: "COMPLETED" },
      policyReadback: { hash: CANDIDATE_HASH, state: "MATCHED", version: 2 },
      replay: {
        result: "PROTECTED",
        runId: "replay-1",
        state: "COMPLETED",
      },
    },
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
    integrations: {
      trueForgeSessionId: PENDING_DECISION.sessionId,
      trueForgeUrl: "http://127.0.0.1:8790",
    },
    incident: { id: "incident-1", status: "OPEN" },
    phase: "INVESTIGATION",
    status: "INVESTIGATING",
    verification: null,
  });
}

function baselineRunningSnapshot(
  activityItems: MissionControlSnapshot["activity"],
): MissionControlSnapshot {
  return missionControlSnapshotSchema.parse({
    activity: activityItems,
    approval: null,
    baseline: null,
    comparison: null,
    decisionPending: false,
    failure: null,
    incident: { id: "incident-1", status: "OPEN" },
    integrations: {
      trueForgeSessionId: null,
      trueForgeUrl: "http://127.0.0.1:8790",
    },
    phase: "BASELINE",
    status: "BASELINE_RUNNING",
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
    scope: "INVESTIGATION" as const,
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
