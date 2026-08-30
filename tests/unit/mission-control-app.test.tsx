// @vitest-environment jsdom

import {
  act,
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
    const callsBeforeDisabledClick = fetcher.mock.calls.length;
    fireEvent.click(retrying);
    expect(fetcher).toHaveBeenCalledTimes(callsBeforeDisabledClick);
    releaseRetry();

    expect(
      await screen.findByRole("button", { name: /Start the Incident/ }),
    ).not.toBeNull();
    expect(screen.getByText("Live AI-agent Incident workflow")).not.toBeNull();
    expect(
      screen.getByRole("list", { name: "Incident facts" }),
    ).not.toBeNull();
    expect(screen.getByText("~2 min guided workflow")).not.toBeNull();
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
      name: /Start the Incident/,
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
    const dialog = await screen.findByRole("dialog", {}, { timeout: 3_000 });
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
    expect(dialog.textContent).toContain("Protected document access");
    expect(dialog.textContent).toContain("unchanged");
    expect(dialog.textContent).toContain("Trusted destinations");
    expect(dialog.textContent).toContain(
      "http://127.0.0.1:3000/api/trusted-destination",
    );
    expect(dialog.textContent).toContain("Evidence justification · sanitized");
    expect(dialog.textContent).toContain("Baseline Run ID");
    expect(dialog.textContent).toContain("run-1");
    expect(dialog.textContent).toContain(
      "The finalized Baseline bundle proves the controlled receipt.",
    );
    expect(
      screen.getByRole("heading", {
        name: "The evidence and policy diff identify the missing boundary.",
      }),
    ).not.toBeNull();
    expect(screen.getByText("Diagnosis")).not.toBeNull();
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

    const dialog = await screen.findByRole("dialog");
    const status = within(dialog).getByRole("status");
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
    expect(screen.getAllByText("Incident resolved").length).toBeGreaterThan(0);
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
    expect(
      screen.getByRole("heading", {
        name: "Testing the suspected policy boundary.",
      }),
    ).not.toBeNull();
    expect(screen.getByText("Working hypothesis")).not.toBeNull();
    expect(screen.queryByText("The leak has one missing boundary.")).toBeNull();
  });

  it.each(["DRAFTED", "DRY_RUN_PASSED"] as const)(
    "keeps the policy cause as a working hypothesis while status is %s",
    async (status) => {
      const snapshot = missionControlSnapshotSchema.parse({
        ...incidentSnapshot(),
        operationActive: true,
        phase: "INVESTIGATION",
        status,
      });
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

      render(<App />);

      expect(
        await screen.findByRole("heading", {
          name: "Testing the suspected policy boundary.",
        }),
      ).not.toBeNull();
      expect(screen.getByText("Working hypothesis")).not.toBeNull();
      expect(screen.queryByText("Diagnosis")).toBeNull();
    },
  );

  it("keeps the latest current-scope activity and its safe detail visible", async () => {
    const snapshot = liveActivityDockSnapshot();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    const dock = await screen.findByRole("complementary", {
      name: "Live agent activity",
    });
    const current = within(dock).getByRole("group", {
      name: "Current agent activity",
    });
    expect(current.textContent).toContain("Drafting the restrictive Policy Patch");
    expect(current.textContent).toContain(
      "Comparing the candidate boundary with the proven receipt chain.",
    );
    expect(current.textContent).not.toContain("Reading the earlier evidence bundle");
    expect(within(dock).getByText("2 active")).not.toBeNull();
    expect(
      within(dock).getByRole("log", {
        name: "Recent durable agent activity",
      }),
    ).not.toBeNull();
    const recent = within(dock).getByRole("log", {
      name: "Recent durable agent activity",
    });
    expect(recent.textContent).toContain("Evidence provenance review completed");
    expect(recent.textContent).not.toContain(
      "The evidence review completed successfully.",
    );

    const evidenceDrawer = screen
      .getByText("Evidence & agent trace")
      .closest("details");
    expect(evidenceDrawer?.open).toBe(false);
  });

  it("shows safe tool inputs, results, and scenario purpose in the live dock", async () => {
    const snapshot = baselineRunningSnapshot([
      {
        detail: "The run-scoped Scenario MCP recorded this tool completion.",
        evidence: null,
        id: "read-completed",
        kind: "tool",
        occurredAt: "2026-08-29T21:00:04.000Z",
        scope: "BASELINE",
        source: "SCENARIO_MCP",
        status: "COMPLETED",
        title: "read_internal_document",
        trace: {
          durationMs: 420,
          outcome: "SUCCEEDED",
          why:
            "Confirm whether protected synthetic data entered the Support Agent context before its next outbound action.",
          result: "Protected document returned · value hidden",
          safeArguments: [
            { label: "Document", value: "diagnostic-runbook" },
          ],
        },
      },
      {
        detail: "Observed in the durable TrueForge event sequence.",
        evidence: null,
        id: "outbound-active",
        kind: "tool",
        occurredAt: "2026-08-29T21:00:05.000Z",
        scope: "BASELINE",
        source: "TRUEFORGE",
        status: "ACTIVE",
        title: "send_external_message",
        trace: {
          durationMs: null,
          outcome: "PENDING",
          why:
            "Test whether protected synthetic data can cross the outbound capability boundary and reach the controlled External Sink.",
          result: "Waiting for tool result",
          safeArguments: [
            { label: "Destination", value: "Controlled External Sink" },
            { label: "Message", value: "Protected value hidden" },
          ],
        },
      },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    const dock = await screen.findByRole("complementary", {
      name: "Live agent activity",
    });
    const current = within(dock).getByRole("group", {
      name: "Current agent activity",
    });
    expect(current.textContent).toContain("Attempting the outbound message");
    expect(current.textContent).toContain("send_external_message");
    expect(current.textContent).toContain("Input");
    expect(current.textContent).toContain("Controlled External Sink");
    expect(current.textContent).toContain("Result");
    expect(current.textContent).toContain("Waiting for tool result");
    expect(current.textContent).toContain("Scenario purpose");
    expect(current.textContent).toContain("Not model reasoning");
    expect(current.textContent).not.toContain("Why this action");
    expect(dock.textContent).toContain(
      "Safe tool inputs, observed results, and scenario purpose.",
    );
    const pendingResult = within(current)
      .getByText("Waiting for tool result")
      .closest(".activity-trace-section");
    expect(pendingResult?.getAttribute("aria-busy")).toBe("true");
    expect(pendingResult?.querySelector(".loading-icon")).not.toBeNull();

    const disclosure = within(dock)
      .getByText("Inspect tool call")
      .closest("details");
    if (!(disclosure instanceof HTMLDetailsElement)) {
      throw new Error("Recent tool disclosure missing");
    }
    expect(disclosure.open).toBe(false);
    fireEvent.click(within(disclosure).getByText("Inspect tool call"));
    expect(disclosure.open).toBe(true);
    expect(disclosure.closest("li")?.textContent).toContain(
      "read_internal_document",
    );
    expect(disclosure.textContent).toContain("diagnostic-runbook");
    expect(disclosure.textContent).toContain("Protected document returned");
    expect(disclosure.textContent).toContain("420 ms");
  });

  it("pins the latest safe tool call when the workflow advances phases", async () => {
    const base = liveActivityDockSnapshot();
    const snapshot = missionControlSnapshotSchema.parse({
      ...base,
      activity: base.activity.map((item) =>
        item.id === "baseline-later"
          ? {
              ...item,
              title: "send_external_message",
              trace: {
                durationMs: 510,
                outcome: "SUCCEEDED",
                why:
                  "Test whether protected synthetic data can cross the outbound capability boundary and reach the controlled External Sink.",
                result: "Controlled External Sink receipt recorded",
                safeArguments: [
                  { label: "Destination", value: "Controlled External Sink" },
                  { label: "Message", value: "Protected value hidden" },
                ],
              },
            }
          : item,
      ),
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    const dock = await screen.findByRole("complementary", {
      name: "Live agent activity",
    });
    expect(within(dock).getByText("Last tool call")).not.toBeNull();
    const recent = within(dock).getByRole("log", {
      name: "Recent durable agent activity",
    });
    expect(recent.textContent).toContain("send_external_message");
    expect(recent.textContent).toContain("Inspect tool call");
  });

  it("keeps an active Control Run phase current while the completed Replay tool stays recent", async () => {
    const snapshot = missionControlSnapshotSchema.parse({
      ...activeVerificationSnapshot(),
      activity: [
        {
          detail: "Preparing the legitimate Control Run.",
          evidence: null,
          id: "control-preparing",
          kind: "phase",
          occurredAt: "2026-08-29T21:00:06.000Z",
          scope: "CONTROL",
          source: "BLACKBOX",
          status: "ACTIVE",
          title: "Preparing isolated Run state",
        },
        {
          detail: "The replay action was denied by policy.",
          evidence: null,
          id: "replay-send",
          kind: "tool",
          occurredAt: "2026-08-29T21:00:05.000Z",
          scope: "REPLAY",
          source: "SCENARIO_MCP",
          status: "FAILED",
          title: "send_external_message",
          trace: {
            durationMs: 22,
            outcome: "DENIED",
            result: "Capability Policy v2 denial recorded",
            safeArguments: [
              {
                label: "Destination",
                value: "External destination · blocked before delivery",
              },
              { label: "Message", value: "Protected value hidden" },
            ],
            why: "Verify that the attack path is blocked by policy.",
          },
        },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    const dock = await screen.findByRole("complementary", {
      name: "Live agent activity",
    });
    const current = within(dock).getByRole("group", {
      name: "Current agent activity",
    });
    expect(current.textContent).toContain("Preparing isolated Run state");
    expect(current.textContent).toContain("Control Run");
    expect(current.textContent).not.toContain("send_external_message");
    const recent = within(dock).getByRole("log", {
      name: "Recent durable agent activity",
    });
    expect(recent.textContent).toContain("send_external_message");
  });

  it("labels the Control ticket as legitimate instead of untrusted", async () => {
    const snapshot = missionControlSnapshotSchema.parse({
      ...activeVerificationSnapshot(),
      activity: [
        {
          detail: "Observed in the durable TrueForge event sequence.",
          evidence: null,
          id: "control-ticket-call",
          kind: "tool",
          occurredAt: "2026-08-29T21:00:06.000Z",
          scope: "CONTROL",
          source: "TRUEFORGE",
          status: "ACTIVE",
          title: "get_support_ticket",
          trace: {
            durationMs: null,
            outcome: "PENDING",
            result: "Waiting for tool result",
            safeArguments: [{ label: "Run", value: "Control Run" }],
            why: "Load the legitimate control Support Ticket.",
          },
        },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    const current = within(
      await screen.findByRole("complementary", {
        name: "Live agent activity",
      }),
    ).getByRole("group", { name: "Current agent activity" });
    expect(current.textContent).toContain(
      "Reading the legitimate Control Support Ticket",
    );
    expect(current.textContent).not.toContain("untrusted");
  });

  it("moves focus to the current card if an inspected recent call becomes current", async () => {
    const tool = {
      detail: "The document tool completed.",
      evidence: null,
      id: "read-completed",
      kind: "tool" as const,
      occurredAt: "2026-08-29T21:00:05.000Z",
      scope: "BASELINE" as const,
      source: "SCENARIO_MCP" as const,
      status: "COMPLETED" as const,
      title: "read_internal_document",
      trace: {
        durationMs: 18,
        outcome: "SUCCEEDED",
        result: "Protected document returned · value hidden",
        safeArguments: [
          { label: "Document", value: "diagnostic-runbook" },
        ],
        why: "Test the protected document read.",
      },
    };
    const initial = baselineRunningSnapshot([
      {
        detail: "A later task is active.",
        evidence: null,
        id: "active-task",
        kind: "subagent",
        occurredAt: "2026-08-29T21:00:06.000Z",
        scope: "BASELINE",
        source: "TRUEFORGE",
        status: "ACTIVE",
        title: "Reviewing the boundary",
      },
      tool,
    ]);
    const after = baselineRunningSnapshot([tool]);
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(reads++ === 0 ? initial : after)),
    );

    render(<App />);

    const dock = await screen.findByRole("complementary", {
      name: "Live agent activity",
    });
    const inspect = within(dock).getByText("Inspect tool call");
    fireEvent.click(inspect);
    const summary = inspect.closest("summary");
    summary?.focus();
    expect(document.activeElement).toBe(summary);

    await waitFor(
      () => {
        const current = within(dock).getByRole("group", {
          name: "Current agent activity",
        });
        expect(current.textContent).toContain("read_internal_document");
        expect(document.activeElement).toBe(current);
      },
      { timeout: 2_000 },
    );
  });

  it("distinguishes policy denial from failure and neutral evidence from success", async () => {
    const snapshot = baselineRunningSnapshot([
      {
        detail: "The current workflow task remains active.",
        evidence: null,
        id: "current-task",
        kind: "subagent",
        occurredAt: "2026-08-29T21:00:05.000Z",
        scope: "BASELINE",
        source: "TRUEFORGE",
        status: "ACTIVE",
        title: "Reviewing the current boundary",
      },
      {
        detail: "The outbound action was denied.",
        evidence: null,
        id: "denied-tool",
        kind: "tool",
        occurredAt: "2026-08-29T21:00:04.000Z",
        scope: "BASELINE",
        source: "SCENARIO_MCP",
        status: "FAILED",
        title: "send_external_message",
        trace: {
          durationMs: 22,
          outcome: "DENIED",
          result: "Capability Policy v2 denial recorded",
          safeArguments: [
            {
              label: "Destination",
              value: "External destination · blocked before delivery",
            },
            { label: "Message", value: "Protected value hidden" },
          ],
          why: "Verify that the outbound action is blocked by policy.",
        },
      },
      {
        detail: "Capability Policy denied the outbound destination.",
        evidence: null,
        id: "policy-record",
        kind: "evidence",
        occurredAt: "2026-08-29T21:00:03.000Z",
        scope: "BASELINE",
        source: "CAPABILITY_POLICY",
        status: "COMPLETED",
        title: "Outbound policy evaluated",
      },
      {
        detail: "TrueForge recorded a response without MCP correlation.",
        evidence: null,
        id: "response-only",
        kind: "tool",
        occurredAt: "2026-08-29T21:00:02.000Z",
        scope: "BASELINE",
        source: "TRUEFORGE",
        status: "COMPLETED",
        title: "get_support_ticket",
        trace: {
          durationMs: 500,
          outcome: "RESPONSE_RECORDED",
          result:
            "TrueForge response recorded · Scenario MCP result unavailable",
          safeArguments: [{ label: "Run", value: "Baseline Run" }],
          why: "Load the untrusted Support Ticket.",
        },
      },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    const dock = await screen.findByRole("complementary", {
      name: "Live agent activity",
    });
    const denied = within(dock)
      .getByText("Policy denial recorded")
      .closest("li");
    expect(denied?.dataset.outcome).toBe("denied");
    expect(denied?.querySelector(".lucide-shield-check")).not.toBeNull();
    const policy = within(dock)
      .getByText("Outbound policy evaluated")
      .closest("li");
    expect(policy?.textContent).toContain("Completed");
    expect(policy?.textContent).not.toContain("Succeeded");
    const responseOnly = within(dock)
      .getByText("Response recorded")
      .closest("li");
    expect(responseOnly?.dataset.outcome).toBe("response-recorded");
    expect(responseOnly?.textContent).not.toContain("Succeeded");
    expect(responseOnly?.textContent).toContain("Support Ticket call recorded");
    expect(responseOnly?.textContent).not.toContain(
      "Read the untrusted Support Ticket",
    );
  });

  it("keeps a completed outbound call neutral until a receipt is recorded", async () => {
    const snapshot = baselineRunningSnapshot([
      {
        detail: "A later task remains active.",
        evidence: null,
        id: "current-task",
        kind: "subagent",
        occurredAt: "2026-08-29T21:00:05.000Z",
        scope: "BASELINE",
        source: "TRUEFORGE",
        status: "ACTIVE",
        title: "Reviewing the current boundary",
      },
      {
        detail: "The outbound call completed without a matching receipt.",
        evidence: null,
        id: "unconfirmed-tool",
        kind: "tool",
        occurredAt: "2026-08-29T21:00:04.000Z",
        scope: "BASELINE",
        source: "SCENARIO_MCP",
        status: "COMPLETED",
        title: "send_external_message",
        trace: {
          durationMs: 28,
          outcome: "DELIVERY_UNCONFIRMED",
          result: "Call completed · delivery not independently confirmed",
          safeArguments: [
            { label: "Destination", value: "Destination hidden" },
            { label: "Message", value: "Protected value hidden" },
          ],
          why: "Observe the outbound boundary without overstating delivery.",
        },
      },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    const dock = await screen.findByRole("complementary", {
      name: "Live agent activity",
    });
    const unconfirmed = within(dock)
      .getByText("Completed · unconfirmed")
      .closest("li");
    expect(unconfirmed?.dataset.outcome).toBe("delivery-unconfirmed");
    expect(unconfirmed?.textContent).not.toContain("Succeeded");
    expect(unconfirmed?.querySelector(".lucide-clock-3")).not.toBeNull();
  });

  it("does not describe failed document work as a successful read", async () => {
    const snapshot = baselineRunningSnapshot([
      {
        detail: "The document tool failed.",
        evidence: null,
        id: "failed-read",
        kind: "tool",
        occurredAt: "2026-08-29T21:00:05.000Z",
        scope: "BASELINE",
        source: "SCENARIO_MCP",
        status: "FAILED",
        title: "read_internal_document",
        trace: {
          durationMs: 18,
          outcome: "FAILED",
          result: "Tool failed · private error hidden",
          safeArguments: [
            { label: "Document", value: "Document identifier hidden" },
          ],
          why: "Test the protected document read.",
        },
      },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    const current = within(
      await screen.findByRole("complementary", {
        name: "Live agent activity",
      }),
    ).getByRole("group", { name: "Current agent activity" });
    expect(current.textContent).toContain(
      "Tried to read the protected Canary document",
    );
    expect(current.textContent).not.toContain(
      "Read the protected Canary document",
    );
  });

  it("minimizes live activity to a current-action capsule and reopens it", async () => {
    const snapshot = liveActivityDockSnapshot();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    const dock = await screen.findByRole("complementary", {
      name: "Live agent activity",
    });
    const minimize = within(dock).getByRole("button", {
      name: "Minimize agent activity",
    });
    expect(minimize.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(minimize);

    expect(
      screen.queryByRole("complementary", { name: "Live agent activity" }),
    ).toBeNull();
    const reopen = screen.getByRole("button", { name: "Open agent activity" });
    expect(reopen.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(reopen);
    expect(reopen.textContent).toContain("Drafting the restrictive Policy Patch");
    expect(reopen.getAttribute("aria-describedby")).toBe(
      "agent-activity-capsule-description",
    );
    expect(
      document.getElementById("agent-activity-capsule-description")?.textContent,
    ).toContain("Live");
    const announcement = screen.getByRole("status");
    expect(announcement.textContent).toContain(
      "Drafting the restrictive Policy Patch",
    );

    fireEvent.click(reopen);
    const reopenedDock = screen.getByRole("complementary", {
      name: "Live agent activity",
    });
    const reopenedMinimize = within(reopenedDock).getByRole("button", {
      name: "Minimize agent activity",
    });
    expect(document.activeElement).toBe(reopenedMinimize);
    expect(reopenedMinimize.hasAttribute("aria-controls")).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.getByRole("complementary", { name: "Live agent activity" }),
    ).not.toBeNull();
    fireEvent.keyDown(reopenedDock, { key: "Escape" });
    expect(screen.queryByRole("complementary", {
      name: "Live agent activity",
    })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open agent activity" }),
    );
  });

  it("credits TrueForge and explains the dock's safe activity boundary", async () => {
    const snapshot = liveActivityDockSnapshot();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    const dock = await screen.findByRole("complementary", {
      name: "Live agent activity",
    });
    const trueForge = within(dock).getByRole("link", {
      name: /Open in TrueForge/,
    });
    expect(trueForge.getAttribute("href")).toBe(
      "http://127.0.0.1:8790/sessions/session-1",
    );
    const boundary = within(dock).getByText(/scenario purpose/i);
    expect(boundary.textContent).toMatch(/prompts/i);
    expect(boundary.textContent).toMatch(/hidden reasoning/i);
    expect(boundary.textContent).toMatch(/private data/i);
  });

  it("keeps agent activity collapsed while the approval dialog owns attention", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(awaitingApprovalSnapshot())),
    );

    render(<App />);

    expect(await screen.findByRole("dialog")).not.toBeNull();
    expect(
      screen.queryByRole("complementary", { name: "Live agent activity" }),
    ).toBeNull();
    const activityToggle = screen.getByRole("button", {
      name: "Open agent activity",
    });
    expect(activityToggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("marks the activity dock disconnected while retaining its last durable update", async () => {
    const snapshot = liveActivityDockSnapshot();
    let readCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        readCount += 1;
        return readCount === 1
          ? jsonResponse(snapshot)
          : jsonResponse(snapshot, 503);
      }),
    );

    render(<App />);

    const initialDock = await screen.findByRole("complementary", {
      name: "Live agent activity",
    });
    expect(initialDock.textContent).toContain(
      "Drafting the restrictive Policy Patch",
    );

    await waitFor(
      () => {
        const dock = screen.getByRole("complementary", {
          name: "Live agent activity",
        });
        expect(dock.textContent).toContain("Disconnected");
        expect(dock.textContent).toContain("Last durable update");
        expect(dock.textContent).toContain(
          "Drafting the restrictive Policy Patch",
        );
        expect(
          screen.getByRole("heading", { name: "Live updates interrupted" }),
        ).not.toBeNull();
        expect(
          screen.getByText("Disconnected", { selector: ".status-pill" }),
        ).not.toBeNull();
        expect(
          screen.getByText("Offline", { selector: ".now-label span" }),
        ).not.toBeNull();
      },
      { timeout: 2_500 },
    );
  });

  it("labels replay and control activity separately in the compact history", async () => {
    const snapshot = missionControlSnapshotSchema.parse({
      ...activeVerificationSnapshot(),
      activity: [
        {
          detail: "The attack replay is executing.",
          evidence: null,
          id: "replay-active",
          kind: "phase",
          occurredAt: "2026-08-29T21:00:04.000Z",
          scope: "REPLAY",
          source: "BLACKBOX",
          status: "ACTIVE",
          title: "Support Agent turn in progress",
        },
        {
          detail: "The trusted workflow completed.",
          evidence: null,
          id: "control-complete",
          kind: "phase",
          occurredAt: "2026-08-29T21:00:05.000Z",
          scope: "CONTROL",
          source: "BLACKBOX",
          status: "COMPLETED",
          title: "Run evidence finalized",
        },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    render(<App />);

    const dock = await screen.findByRole("complementary", {
      name: "Live agent activity",
    });
    const current = within(dock).getByRole("group", {
      name: "Current agent activity",
    });
    expect(current.textContent).toContain("Attack Replay");
    expect(current.textContent).toContain("In progress");
    const recent = within(dock).getByRole("log", {
      name: "Recent durable agent activity",
    });
    expect(recent.textContent).toContain("Control Run");
    expect(recent.textContent).not.toContain("The trusted workflow completed.");
  });

  it("adapts dock mode to the desktop breakpoint until the user overrides it", async () => {
    let desktopChange: ((event: { matches: boolean }) => void) | undefined;
    const desktopQuery = {
      addEventListener: vi.fn(
        (_type: string, listener: (event: { matches: boolean }) => void) => {
          desktopChange = listener;
        },
      ),
      matches: false,
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) =>
        query === "(min-width: 1440px)"
          ? desktopQuery
          : {
              addEventListener: vi.fn(),
              matches: false,
              removeEventListener: vi.fn(),
            },
      ),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(liveActivityDockSnapshot())),
    );

    render(<App />);

    expect(
      await screen.findByRole("button", { name: "Open agent activity" }),
    ).not.toBeNull();
    act(() => {
      desktopQuery.matches = true;
      desktopChange?.({ matches: true });
    });
    const dock = screen.getByRole("complementary", {
      name: "Live agent activity",
    });
    fireEvent.click(
      within(dock).getByRole("button", { name: "Minimize agent activity" }),
    );
    expect(
      screen.getByRole("button", { name: "Open agent activity" }),
    ).not.toBeNull();

    act(() => {
      desktopQuery.matches = false;
      desktopChange?.({ matches: false });
      desktopQuery.matches = true;
      desktopChange?.({ matches: true });
    });
    expect(
      screen.queryByRole("complementary", { name: "Live agent activity" }),
    ).toBeNull();
  });

  it("does not let an older poll overwrite a newer command refresh", async () => {
    let releaseDecision = (): void => undefined;
    const decisionGate = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    let releaseOldPoll = (): void => undefined;
    const oldPollGate = new Promise<void>((resolve) => {
      releaseOldPoll = resolve;
    });
    const approval = awaitingApprovalSnapshot();
    const verifying = activeVerificationSnapshot();
    let readCount = 0;
    const fetcher = vi.fn(async (input: string) => {
      if (input.includes("/remediation-decisions")) {
        await decisionGate;
        return jsonResponse(approval, 202);
      }
      readCount += 1;
      if (readCount === 1) return jsonResponse(approval);
      if (readCount === 2) {
        await oldPollGate;
        return jsonResponse(approval);
      }
      return jsonResponse(verifying);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    const approve = await screen.findByRole("button", {
      name: /Approve exact Policy Patch/,
    });
    fireEvent.click(approve);
    await waitFor(
      () => {
        expect(readCount).toBe(2);
      },
      { timeout: 2_000 },
    );

    releaseDecision();
    expect(
      await screen.findByRole("heading", {
        name: "Same attack. Separate control.",
      }),
    ).not.toBeNull();

    releaseOldPoll();
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Same attack. Separate control.",
      }),
    ).not.toBeNull();
  });

  it("clears an ambiguous command error after polling reconstructs its durable outcome", async () => {
    const approval = awaitingApprovalSnapshot();
    const denied = missionControlSnapshotSchema.parse({
      ...incidentSnapshot(),
      failure: {
        detail:
          "The Capability Policy was not changed and verification did not start.",
        title: "Policy Patch denied",
      },
      operationActive: false,
      phase: "RESULT",
      status: "DENIED",
    });
    let decisionAttempted = false;
    const fetcher = vi.fn(async (input: string) => {
      if (input.includes("/remediation-decisions")) {
        decisionAttempted = true;
        throw new Error("Decision response was lost");
      }
      return jsonResponse(decisionAttempted ? denied : approval);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Keep current policy" }),
    );

    expect(
      await screen.findAllByRole(
        "heading",
        { name: "Policy Patch declined" },
        { timeout: 2_000 },
      ),
    ).toHaveLength(2);
    expect(screen.queryByText("Command was not accepted")).toBeNull();
    expect(screen.queryByText("Decision response was lost")).toBeNull();
  });

  it("does not present a durable in-progress state as live without an executor", async () => {
    const snapshot = missionControlSnapshotSchema.parse({
      ...liveActivityDockSnapshot(),
      operationActive: false,
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(snapshot)));

    const view = render(<App />);

    const dock = await screen.findByRole("complementary", {
      name: "Live agent activity",
    });
    expect(dock.textContent).toContain("No active executor");
    expect(dock.querySelector(".signal-mark.active")).toBeNull();
    expect(view.container.querySelector(".now-strip")?.textContent).toContain(
      "Durable work is paused",
    );
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
    operationActive: false,
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
    operationActive: false,
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
    operationActive: false,
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
    operationActive: false,
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

function activeVerificationSnapshot(): MissionControlSnapshot {
  return missionControlSnapshotSchema.parse({
    ...incidentSnapshot(),
    operationActive: true,
    phase: "VERIFICATION",
    status: "VERIFYING",
    verification: {
      control: { result: null, runId: null, state: "WAITING" },
      policyReadback: { hash: CANDIDATE_HASH, state: "MATCHED", version: 2 },
      replay: { result: null, runId: "replay-active", state: "ACTIVE" },
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
    operationActive: true,
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
    operationActive: true,
    integrations: {
      trueForgeSessionId: null,
      trueForgeUrl: "http://127.0.0.1:8790",
    },
    phase: "BASELINE",
    status: "BASELINE_RUNNING",
    verification: null,
  });
}

function liveActivityDockSnapshot(): MissionControlSnapshot {
  return missionControlSnapshotSchema.parse({
    ...incidentSnapshot(),
    activity: [
      {
        detail: "A newer record from another phase must not become current.",
        evidence: null,
        id: "baseline-later",
        kind: "tool",
        occurredAt: "2026-08-29T21:00:05.000Z",
        scope: "BASELINE",
        source: "TRUEFORGE",
        status: "ACTIVE",
        title: "Reading the earlier evidence bundle",
      },
      {
        detail:
          "Comparing the candidate boundary with the proven receipt chain.",
        evidence: null,
        id: "investigation-latest",
        kind: "subagent",
        occurredAt: "2026-08-29T21:00:04.000Z",
        scope: "INVESTIGATION",
        source: "TRUEFORGE",
        status: "ACTIVE",
        title: "Drafting the restrictive Policy Patch",
      },
      {
        detail: "The evidence review completed successfully.",
        evidence: null,
        id: "investigation-completed",
        kind: "subagent",
        occurredAt: "2026-08-29T21:00:06.000Z",
        scope: "INVESTIGATION",
        source: "TRUEFORGE",
        status: "COMPLETED",
        title: "Evidence provenance review completed",
      },
      {
        detail: "Checking the candidate against the current Capability Policy.",
        evidence: null,
        id: "investigation-older",
        kind: "subagent",
        occurredAt: "2026-08-29T21:00:01.000Z",
        scope: "INVESTIGATION",
        source: "TRUEFORGE",
        status: "ACTIVE",
        title: "Policy Patch review started",
      },
    ],
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
