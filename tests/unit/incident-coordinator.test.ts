import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  BaselineEvidenceBundle,
  BaselineRunManifest,
  EvidenceLedger,
  EvidenceRecord,
  EvidenceRunRead,
  RunManifest,
} from "../../src/evidence/ledger.js";
import { SqliteEvidenceLedger } from "../../src/evidence/ledger.js";
import { IncidentCoordinator } from "../../src/incident/coordinator.js";
import type { BaselineRunObservation } from "../../src/observability/evlog.js";
import { createBaselineCapabilityPolicy } from "../../src/policy/capability-policy.js";
import { SqliteRemediationStore } from "../../src/remediation/store.js";
import {
  createBaselineRunManifest,
  createControlRunManifest,
  createReplayRunManifest,
} from "../../src/scenario/definition.js";
import { InvestigationExecutionError } from "../../src/trueforge/runtime.js";
import type {
  BaselineExecutionEvidence,
  TrueForgeRuntime,
} from "../../src/trueforge/runtime.js";
import type {
  InvestigationExecutionEvidence,
  InvestigationExecutionRequest,
} from "../../src/trueforge/runtime.js";

describe("Incident coordinator observability", () => {
  it("projects a live canonical tool invocation and terminates it on Run failure", async () => {
    const privateCanary = "BLACKBOX-CANARY-live-tool-call";
    let failExecution = (_error: Error): void => undefined;
    const execution = new Promise<BaselineExecutionEvidence>((_resolve, reject) => {
      failExecution = reject;
    });
    const harness = createFinalizingHarness("INCONCLUSIVE");
    const runtime: TrueForgeRuntime = {
      async executeBaseline(request) {
        request.onToolCall?.({
          arguments: JSON.stringify({
            destination: `http://127.0.0.1:3000/api/external-sink/${request.runId}`,
            message: privateCanary,
            runId: request.runId,
          }),
          eventId: `${request.runId}:live-send-call`,
          occurredAt: "2026-08-30T12:00:01.000Z",
          toolCallId: "live-send-call",
          toolName: "send_external_message",
        });
        return execution;
      },
      executeSmoke: () => new Promise(() => undefined),
    };
    const remediations = new SqliteRemediationStore(":memory:");
    const coordinator = new IncidentCoordinator({
      baseUrl: "http://127.0.0.1:3000",
      ledger: harness.ledger,
      model: { alias: "tool-model", id: "vendor/tool-model" },
      policy: createBaselineCapabilityPolicy(),
      remediations,
      runtime,
      trustedDestination:
        "http://127.0.0.1:3000/api/trusted-destination",
    });

    const started = coordinator.start();
    if (!started.started) throw new Error("Incident did not start");
    const activeSnapshot = coordinator.readMissionControl();
    expect(activeSnapshot.activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `${started.runId}:live-send-call`,
          source: "TRUEFORGE",
          status: "ACTIVE",
          trace: expect.objectContaining({ result: "Waiting for tool result" }),
        }),
      ]),
    );
    expect(JSON.stringify(activeSnapshot)).not.toContain(privateCanary);

    failExecution(new Error("Request failed (503): TrueForge unavailable"));
    await vi.waitFor(() => {
      expect(harness.finalized).toHaveBeenCalledOnce();
    });
    expect(coordinator.readMissionControl().activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `${started.runId}:live-send-call`,
          status: "FAILED",
          trace: expect.objectContaining({
            result: "Tool result missing from durable evidence",
          }),
        }),
      ]),
    );
    remediations.close();
  });

  it("keeps one durable invocation when final evidence repeats the live call", async () => {
    let finishExecution = (): void => undefined;
    const executionGate = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    const ledger = new SqliteEvidenceLedger(":memory:");
    const runtime: TrueForgeRuntime = {
      async executeBaseline(request) {
        const occurredAt = new Date().toISOString();
        const call = {
          arguments: JSON.stringify({ runId: request.runId }),
          eventId: `${request.runId}:live-ticket-call`,
          occurredAt,
          toolCallId: "live-ticket-call",
          toolName: "get_support_ticket" as const,
        };
        request.onToolCall?.(call);
        await executionGate;
        return {
          mcpInitialization: {
            eventId: `${request.runId}:mcp-initialized`,
            occurredAt,
            serverName: "blackbox-scenario",
          },
          sessionId: "session-live-dedupe",
          toolCalls: [call],
          toolResponses: [],
          turn: {
            eventId: `${request.runId}:turn-done`,
            occurredAt,
            status: "done",
            turnId: "turn-live-dedupe",
          },
        };
      },
      executeSmoke: () => new Promise(() => undefined),
    };
    const remediations = new SqliteRemediationStore(":memory:");
    const coordinator = new IncidentCoordinator({
      baseUrl: "http://127.0.0.1:3000",
      ledger,
      model: { alias: "tool-model", id: "vendor/tool-model" },
      policy: createBaselineCapabilityPolicy(),
      remediations,
      runtime,
      trustedDestination:
        "http://127.0.0.1:3000/api/trusted-destination",
    });

    const started = coordinator.start();
    if (!started.started) throw new Error("Incident did not start");
    expect(coordinator.readMissionControl().activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `${started.runId}:live-ticket-call`,
          status: "ACTIVE",
        }),
      ]),
    );

    finishExecution();
    await vi.waitFor(() => {
      expect(coordinator.read(started.runId)?.status).toBe("completed");
    });
    expect(
      ledger
        .readBundle(started.runId)
        ?.timeline.filter(
          (record) =>
            record.type === "tool.called" &&
            record.id === `${started.runId}:live-ticket-call`,
        ),
    ).toHaveLength(1);
    await coordinator.shutdown();
    ledger.close();
    remediations.close();
  });

  it("records an incomplete canonical workflow as Victim Agent noncompliance", async () => {
    const harness = createFinalizingHarness("INCONCLUSIVE");
    const runtime: TrueForgeRuntime = {
      async executeBaseline(): Promise<never> {
        throw new Error(
          "TrueForge canonical tool sequence was incomplete: get_support_ticket, search_internal_documents, read_internal_document",
        );
      },
      executeSmoke: () => new Promise(() => undefined),
    };
    const observation: BaselineRunObservation = {
      completed: vi.fn(),
      failed: vi.fn(),
      finalizationFailed: vi.fn(),
    };
    const remediations = new SqliteRemediationStore(":memory:");
    const coordinator = new IncidentCoordinator({
      baseUrl: "http://127.0.0.1:3000",
      ledger: harness.ledger,
      model: { alias: "glm-5.3-flash", id: "z-ai/glm-5.3-flash" },
      observeBaselineRun: () => observation,
      policy: createBaselineCapabilityPolicy(),
      remediations,
      runtime,
      trustedDestination:
        "http://127.0.0.1:3000/api/trusted-destination",
    });

    coordinator.start();

    await vi.waitFor(() => {
      expect(harness.finalized).toHaveBeenCalledOnce();
    });
    expect(observation.failed).toHaveBeenCalledWith(
      {
        message:
          "Victim Agent ended before completing the canonical tool workflow",
        retryable: false,
      },
      "victim-agent",
    );
    expect(
      harness.records.find((record) => record.type === "run.failed"),
    ).toMatchObject({
      message:
        "Victim Agent ended before completing the canonical tool workflow",
      stage: "victim-agent",
    });
    remediations.close();
  });

  it("emits a terminal observation when evidence finalization fails", async () => {
    const records: EvidenceRecord[] = [];
    let manifest: RunManifest | undefined;
    const ledger: EvidenceLedger = {
      append(sourceRecords): void {
        records.push(...sourceRecords);
      },
      createRun(sourceManifest): void {
        manifest = sourceManifest;
      },
      finalizeBaseline(): never {
        throw new Error("SQLite finalization failed with private details");
      },
      finalizeControl(): never {
        throw new Error("Control finalization is not used by this test");
      },
      finalizeReplay(): never {
        throw new Error("Replay finalization is not used by this test");
      },
      readBundle: () => undefined,
      readLatestRun(kind) {
        return manifest?.kind === kind
          ? { manifest, timeline: records }
          : undefined;
      },
      readManifest(): RunManifest {
        if (manifest === undefined) throw new Error("Run manifest unavailable");
        return manifest;
      },
      readRun(runId) {
        return manifest?.runId === runId
          ? { manifest, timeline: records }
          : undefined;
      },
    };
    const runtime: TrueForgeRuntime = {
      async executeBaseline(): Promise<never> {
        throw new Error(
          "Request failed (429): raw customer ticket and secret evidence",
        );
      },
      executeSmoke: () => new Promise(() => undefined),
    };
    const observation: BaselineRunObservation = {
      completed: vi.fn(),
      failed: vi.fn(),
      finalizationFailed: vi.fn(),
    };
    const remediations = new SqliteRemediationStore(":memory:");
    const coordinator = new IncidentCoordinator({
      baseUrl: "http://127.0.0.1:3000",
      ledger,
      model: { alias: "glm-5.2", id: "z-ai/glm-5.2:free" },
      observeBaselineRun: () => observation,
      policy: createBaselineCapabilityPolicy(),
      remediations,
      runtime,
      trustedDestination:
        "http://127.0.0.1:3000/api/trusted-destination",
    });

    coordinator.start();

    await vi.waitFor(() => {
      expect(observation.finalizationFailed).toHaveBeenCalledOnce();
    });
    expect(observation.failed).toHaveBeenCalledWith(
      {
        message: "TrueForge upstream request failed with HTTP 429",
        retryable: true,
        statusCode: 429,
      },
      "trueforge",
    );
    expect(observation.completed).not.toHaveBeenCalled();
    expect(
      records.find((record) => record.type === "run.failed"),
    ).toMatchObject({
      message: "TrueForge upstream request failed with HTTP 429",
      stage: "trueforge",
    });
    expect(JSON.stringify(records)).not.toContain("raw customer ticket");
    expect(JSON.stringify(records)).not.toContain("secret evidence");
    remediations.close();
  });

  it("does not retry after observing a non-canonical pending action", async () => {
    const harness = createFinalizingHarness("VULNERABLE");
    const executeInvestigation = vi.fn(
      async (
        request: InvestigationExecutionRequest,
      ): Promise<InvestigationExecutionEvidence> => {
        request.onMilestone?.({
          kind: "EVIDENCE_REVIEW_STARTED",
          occurredAt: "2026-08-28T12:00:01.000Z",
          sessionId: "session-investigation",
          sourceEventId: "event-evidence-started-before-failure",
        });
        return investigationEvidence(request, [
          request.trustedDestination,
          "https://untrusted.example/messages",
        ]);
      },
    );
    const runtime: TrueForgeRuntime = {
      executeBaseline: async ({ runId }) => baselineEvidence(runId),
      executeInvestigation,
      executeSmoke: () => new Promise(() => undefined),
    };
    const trustedDestination =
      "http://127.0.0.1:3000/api/trusted-destination";
    const policy = createBaselineCapabilityPolicy([trustedDestination]);
    const remediations = new SqliteRemediationStore(":memory:");
    const coordinator = new IncidentCoordinator({
      baseUrl: "http://127.0.0.1:3000",
      ledger: harness.ledger,
      model: { alias: "tool-model", id: "vendor/tool-model" },
      policy,
      remediations,
      runtime,
      trustedDestination,
    });

    const started = coordinator.start();
    if (!started.started) throw new Error("Incident did not start");
    await vi.waitFor(() => {
      expect(remediations.read(started.incidentId)).toMatchObject({
        remediation: { state: "VALIDATION_FAILED" },
      });
    });

    expect(executeInvestigation).toHaveBeenCalledOnce();
    expect(remediations.read(started.incidentId)?.remediation).toMatchObject({
      lifecycle: [{ state: "DRAFTED" }, { state: "VALIDATION_FAILED" }],
      pendingDecision: {
        actionId: "action-1",
        callId: "call-apply",
        sessionId: "session-investigation",
        turnId: "turn-investigation",
      },
      state: "VALIDATION_FAILED",
    });
    expect(policy.fingerprint()).toBe(
      "93d054afcb184730a08510550d5ed932dcf78ae88011a76b16423f615df0210c",
    );
    expect(coordinator.readMissionControl().activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "event-evidence-started-before-failure",
          scope: "INVESTIGATION",
          status: "FAILED",
          title: "Evidence provenance review started",
        }),
      ]),
    );
    remediations.close();
  });

  it("does not retry a transient failure after TrueForge observed an action", async () => {
    const harness = createFinalizingHarness("VULNERABLE");
    const executeInvestigation = vi.fn().mockRejectedValue(
      new InvestigationExecutionError(
        "Request failed (503) after pending action",
        true,
      ),
    );
    const runtime: TrueForgeRuntime = {
      executeBaseline: async ({ runId }) => baselineEvidence(runId),
      executeInvestigation,
      executeSmoke: () => new Promise(() => undefined),
    };
    const remediations = new SqliteRemediationStore(":memory:");
    const coordinator = new IncidentCoordinator({
      baseUrl: "http://127.0.0.1:3000",
      ledger: harness.ledger,
      model: { alias: "tool-model", id: "vendor/tool-model" },
      policy: createBaselineCapabilityPolicy(),
      remediations,
      runtime,
      trustedDestination:
        "http://127.0.0.1:3000/api/trusted-destination",
    });

    const started = coordinator.start();
    if (!started.started) throw new Error("Incident did not start");
    await vi.waitFor(() => {
      expect(remediations.read(started.incidentId)).toMatchObject({
        remediation: { state: "VALIDATION_FAILED" },
      });
    });

    expect(executeInvestigation).toHaveBeenCalledOnce();
    remediations.close();
  });

  it("projects sanitized durable TrueForge milestones while investigation is active", async () => {
    const harness = createFinalizingHarness("VULNERABLE");
    const trustedDestination =
      "http://127.0.0.1:3000/api/trusted-destination";
    let finishInvestigation: (() => void) | undefined;
    const investigationGate = new Promise<void>((resolve) => {
      finishInvestigation = resolve;
    });
    const runtime: TrueForgeRuntime = {
      executeBaseline: async ({ runId }) => baselineEvidence(runId),
      async executeInvestigation(request) {
        request.onMilestone?.({
          kind: "TURN_STARTED",
          occurredAt: "2026-08-28T12:00:00.000Z",
          sessionId: "session-investigation",
          sourceEventId: "event-turn-live",
        });
        request.onMilestone?.({
          kind: "EVIDENCE_REVIEW_STARTED",
          occurredAt: "2026-08-28T12:00:01.000Z",
          sessionId: "session-investigation",
          sourceEventId: "event-evidence-live",
        });
        await investigationGate;
        return investigationEvidence(request, [trustedDestination]);
      },
      executeSmoke: () => new Promise(() => undefined),
    };
    const remediations = new SqliteRemediationStore(":memory:");
    const coordinator = new IncidentCoordinator({
      baseUrl: "http://127.0.0.1:3000",
      ledger: harness.ledger,
      model: { alias: "tool-model", id: "vendor/tool-model" },
      policy: createBaselineCapabilityPolicy([trustedDestination]),
      remediations,
      runtime,
      trustedDestination,
      trueForgeUrl: "http://127.0.0.1:8790",
    });

    const started = coordinator.start();
    if (!started.started) throw new Error("Incident did not start");
    await vi.waitFor(() => {
      expect(coordinator.readMissionControl()).toMatchObject({
        activity: expect.arrayContaining([
          expect.objectContaining({
            id: "event-turn-live",
            status: "ACTIVE",
            title: "TrueForge investigation started",
          }),
          expect.objectContaining({
            id: "event-evidence-live",
            status: "ACTIVE",
            title: "Evidence provenance review started",
          }),
        ]),
        integrations: {
          trueForgeSessionId: "session-investigation",
          trueForgeUrl: "http://127.0.0.1:8790",
        },
        operationActive: true,
        status: "INVESTIGATING",
      });
    });
    expect(
      JSON.stringify(
        remediations.read(started.incidentId)?.remediation
          .investigationProgress,
      ),
    ).not.toContain("BLACKBOX-CANARY");

    finishInvestigation?.();
    await vi.waitFor(() => {
      expect(remediations.read(started.incidentId)).toMatchObject({
        remediation: {
          investigationProgress: { sessionId: "session-investigation" },
          state: "AWAITING_APPROVAL",
        },
      });
    });
    expect(coordinator.readMissionControl().activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "event-turn-live",
          scope: "INVESTIGATION",
          status: "COMPLETED",
        }),
        expect.objectContaining({
          id: "event-evidence-live",
          scope: "INVESTIGATION",
          status: "COMPLETED",
        }),
      ]),
    );
    expect(coordinator.readMissionControl().operationActive).toBe(false);
    await coordinator.shutdown();
    remediations.close();
  });

  it("discovers only matching active verification Runs before references are recorded", () => {
    const incidentId = "incident-live-verification";
    const baselineRunId = "run-live-baseline";
    const trustedDestination = "https://trusted.example/messages";
    const policy = createBaselineCapabilityPolicy([trustedDestination]);
    const basePolicy = policy.read();
    const dryRun = policy.dryRunPatch({
      destinationAllowlist: [trustedDestination],
      expectedBaseHash: basePolicy.hash,
      expectedBaseVersion: basePolicy.version,
    });
    const baselineManifest = createBaselineRunManifest(
      incidentId,
      baselineRunId,
      "BLACKBOX-CANARY-live-baseline",
      "2026-08-28T12:00:00.000Z",
      "tool-model",
      "vendor/tool-model",
      policy,
      "http://127.0.0.1:3000",
    );
    const baselineBundle: BaselineEvidenceBundle = {
      bundleHash: "a".repeat(64),
      completeness: { complete: true, missing: [] },
      finalizedAt: "2026-08-28T12:00:01.000Z",
      manifest: baselineManifest,
      schemaVersion: 1,
      timeline: [],
      verdict: "VULNERABLE",
    };
    const replayManifest = createReplayRunManifest(
      baselineManifest,
      "run-live-replay",
      "BLACKBOX-CANARY-live-replay",
      "2026-08-28T12:00:02.000Z",
      policy,
    );
    const controlManifest = createControlRunManifest(
      baselineManifest,
      "run-live-control",
      "BLACKBOX-CANARY-live-control",
      "BLACKBOX-CONTROL-live",
      "2026-08-28T12:00:03.000Z",
      policy,
      trustedDestination,
    );
    const activeRun = (manifest: RunManifest): EvidenceRunRead => ({
      manifest,
      timeline: [
        {
          id: `${manifest.runId}:executing`,
          occurredAt: manifest.createdAt,
          runId: manifest.runId,
          source: "blackbox",
          state: "EXECUTING",
          type: "run.state_changed",
        },
      ],
    });
    const latestRuns = new Map<RunManifest["kind"], EvidenceRunRead>([
      [
        "baseline",
        { bundle: baselineBundle, manifest: baselineManifest, timeline: [] },
      ],
      ["replay", activeRun(replayManifest)],
      ["control", activeRun(controlManifest)],
    ]);
    const ledger: EvidenceLedger = {
      append: vi.fn(),
      createRun: vi.fn(),
      finalizeBaseline: vi.fn(),
      finalizeControl: vi.fn(),
      finalizeReplay: vi.fn(),
      readBundle: vi.fn(),
      readLatestRun: (kind) => latestRuns.get(kind),
      readManifest: vi.fn(),
      readRun: vi.fn(),
    };
    const investigation = investigationEvidence(
      {
        bundle: baselineBundle,
        mcpAuthorization: "run-capability",
        policy: basePolicy,
        signal: new AbortController().signal,
        trustedDestination,
      },
      [trustedDestination],
    );
    const pendingDecision = {
      actionId: investigation.pendingAction.actionId,
      callId: investigation.pendingAction.callId,
      sessionId: investigation.pendingAction.sessionId,
      threadId: investigation.pendingAction.threadId,
      toolName: investigation.pendingAction.toolName,
      turnId: investigation.pendingAction.turnId,
    };
    const remediations = new SqliteRemediationStore(":memory:");
    remediations.start(
      incidentId,
      baselineRunId,
      baselineBundle.bundleHash,
      "run-capability",
    );
    remediations.drafted(incidentId);
    remediations.dryRunPassed(incidentId, dryRun);
    remediations.awaitingApproval(incidentId, {
      analysis: investigation.analysis,
      diagnosis: investigation.diagnosis,
      dryRun,
      evidenceJustification:
        investigation.pendingAction.proposal.evidenceJustification,
      pendingDecision,
      subagents: investigation.subagents,
    });
    remediations.applied(
      incidentId,
      {
        ...pendingDecision,
        decidedAt: "2026-08-28T12:00:01.500Z",
        decision: "allow",
      },
      { ...dryRun.candidate, hash: dryRun.candidateHash },
    );
    remediations.verifying(incidentId);
    const coordinator = new IncidentCoordinator({
      baseUrl: "http://127.0.0.1:3000",
      ledger,
      model: { alias: "tool-model", id: "vendor/tool-model" },
      policy,
      remediations,
      runtime: {
        executeBaseline: () => new Promise(() => undefined),
        executeSmoke: () => new Promise(() => undefined),
      },
      trustedDestination,
    });

    expect(coordinator.readMissionControl().activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "run-live-replay:executing",
          scope: "REPLAY",
          status: "ACTIVE",
        }),
        expect.objectContaining({
          id: "run-live-control:executing",
          scope: "CONTROL",
          status: "ACTIVE",
        }),
      ]),
    );

    const otherIncidentBaseline = {
      ...baselineManifest,
      incidentId: "incident-stale",
    };
    const otherBaseline = {
      ...baselineManifest,
      runId: "run-stale-baseline",
    };
    latestRuns.set(
      "replay",
      activeRun(
        createReplayRunManifest(
          otherIncidentBaseline,
          "run-stale-replay",
          "BLACKBOX-CANARY-stale-replay",
          "2026-08-28T12:00:04.000Z",
          policy,
        ),
      ),
    );
    latestRuns.set(
      "control",
      activeRun(
        createControlRunManifest(
          otherBaseline,
          "run-stale-control",
          "BLACKBOX-CANARY-stale-control",
          "BLACKBOX-CONTROL-stale",
          "2026-08-28T12:00:05.000Z",
          policy,
          trustedDestination,
        ),
      ),
    );

    expect(
      coordinator
        .readMissionControl()
        .activity.filter(
          (item) => item.scope === "REPLAY" || item.scope === "CONTROL",
        ),
    ).toEqual([]);
    remediations.close();
  });

  it("does not investigate an inconclusive finalized Baseline Run", async () => {
    const harness = createFinalizingHarness("INCONCLUSIVE");
    const executeInvestigation = vi.fn();
    const runtime: TrueForgeRuntime = {
      executeBaseline: async ({ runId }) => baselineEvidence(runId),
      executeInvestigation,
      executeSmoke: () => new Promise(() => undefined),
    };
    const remediations = new SqliteRemediationStore(":memory:");
    const coordinator = new IncidentCoordinator({
      baseUrl: "http://127.0.0.1:3000",
      ledger: harness.ledger,
      model: { alias: "tool-model", id: "vendor/tool-model" },
      policy: createBaselineCapabilityPolicy(),
      remediations,
      runtime,
      trustedDestination:
        "http://127.0.0.1:3000/api/trusted-destination",
    });

    const started = coordinator.start();
    if (!started.started) throw new Error("Incident did not start");
    await vi.waitFor(() => {
      expect(harness.finalized).toHaveBeenCalledOnce();
    });

    expect(executeInvestigation).not.toHaveBeenCalled();
    expect(remediations.read(started.incidentId)).toBeUndefined();
    remediations.close();
  });

  it("resumes an unmatched finalized Vulnerable Baseline without starting a duplicate", async () => {
    const harness = createFinalizingHarness("VULNERABLE");
    const trustedDestination =
      "http://127.0.0.1:3000/api/trusted-destination";
    const policy = createBaselineCapabilityPolicy([trustedDestination]);
    const manifest = createBaselineRunManifest(
      "incident-recovery",
      "run-recovery",
      "BLACKBOX-CANARY-recovery",
      "2026-08-27T20:00:00.000Z",
      "tool-model",
      "vendor/tool-model",
      policy,
      "http://127.0.0.1:3000",
    );
    harness.ledger.createRun(manifest);
    harness.ledger.finalizeBaseline(manifest.runId);
    const executeInvestigation = vi.fn(async (request) =>
      investigationEvidence(request, [trustedDestination]),
    );
    const remediations = new SqliteRemediationStore(":memory:");
    const coordinator = new IncidentCoordinator({
      baseUrl: "http://127.0.0.1:3000",
      ledger: harness.ledger,
      model: { alias: "tool-model", id: "vendor/tool-model" },
      policy,
      remediations,
      runtime: {
        executeBaseline: vi.fn(),
        executeInvestigation,
        executeSmoke: () => new Promise(() => undefined),
      },
      trustedDestination,
    });

    expect(executeInvestigation).not.toHaveBeenCalled();
    expect(remediations.read(manifest.incidentId)).toBeUndefined();
    coordinator.recover();
    await vi.waitFor(() => {
      expect(remediations.read(manifest.incidentId)).toMatchObject({
        baseline: { runId: manifest.runId },
        remediation: { state: "AWAITING_APPROVAL" },
      });
    });
    expect(coordinator.start()).toEqual({
      activeRunId: manifest.runId,
      started: false,
    });
    expect(executeInvestigation).toHaveBeenCalledOnce();
    coordinator.recover();
    expect(remediations.read(manifest.incidentId)?.remediation.state).toBe(
      "AWAITING_APPROVAL",
    );
    expect(executeInvestigation).toHaveBeenCalledOnce();
    await coordinator.shutdown();
    remediations.close();
  });

  it("finalizes a stranded Baseline on process recovery without replaying the Victim Agent", () => {
    const ledger = new SqliteEvidenceLedger(":memory:");
    const policy = createBaselineCapabilityPolicy();
    const manifest = createBaselineRunManifest(
      "incident-stranded-baseline",
      "run-stranded-baseline",
      "BLACKBOX-CANARY-stranded-baseline",
      "2026-08-27T20:00:00.000Z",
      "tool-model",
      "vendor/tool-model",
      policy,
      "http://127.0.0.1:3000",
    );
    ledger.createRun(manifest);
    ledger.append([
      {
        id: `${manifest.runId}:state:PREPARING`,
        occurredAt: manifest.createdAt,
        runId: manifest.runId,
        source: "blackbox",
        state: "PREPARING",
        type: "run.state_changed",
      },
      {
        id: `${manifest.runId}:state:EXECUTING`,
        occurredAt: "2026-08-27T20:00:00.001Z",
        runId: manifest.runId,
        source: "blackbox",
        state: "EXECUTING",
        type: "run.state_changed",
      },
    ]);
    const executeBaseline = vi.fn();
    const remediations = new SqliteRemediationStore(":memory:");
    const coordinator = new IncidentCoordinator({
      baseUrl: "http://127.0.0.1:3000",
      ledger,
      model: { alias: "tool-model", id: "vendor/tool-model" },
      policy,
      remediations,
      runtime: {
        executeBaseline,
        executeSmoke: () => new Promise(() => undefined),
      },
      trustedDestination:
        "http://127.0.0.1:3000/api/trusted-destination",
    });

    coordinator.recover();

    const recovered = ledger.readBundle(manifest.runId);
    expect(recovered).toMatchObject({
      completeness: {
        complete: false,
        missing: expect.arrayContaining(["infrastructure.failure"]),
      },
      verdict: "INCONCLUSIVE",
    });
    expect(recovered?.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "BLACKBOX restarted before the Baseline Run completed; the Victim Agent turn was not replayed",
          stage: "blackbox-recovery",
          type: "run.failed",
        }),
      ]),
    );
    expect(coordinator.readMissionControl().status).toBe(
      "BASELINE_INCONCLUSIVE",
    );
    expect(executeBaseline).not.toHaveBeenCalled();
    coordinator.recover();
    expect(
      ledger
        .readBundle(manifest.runId)
        ?.timeline.filter((record) => record.type === "run.failed"),
    ).toHaveLength(1);
    ledger.close();
    remediations.close();
  });

  it("fails a stranded investigation on process recovery without replaying its side effects", () => {
    const harness = createFinalizingHarness("VULNERABLE");
    const trustedDestination =
      "http://127.0.0.1:3000/api/trusted-destination";
    const policy = createBaselineCapabilityPolicy([trustedDestination]);
    const manifest = createBaselineRunManifest(
      "incident-stranded-investigation",
      "run-stranded-investigation",
      "BLACKBOX-CANARY-stranded-investigation",
      "2026-08-27T20:00:00.000Z",
      "tool-model",
      "vendor/tool-model",
      policy,
      "http://127.0.0.1:3000",
    );
    harness.ledger.createRun(manifest);
    const bundle = harness.ledger.finalizeBaseline(manifest.runId);
    const remediations = new SqliteRemediationStore(":memory:");
    remediations.start(
      manifest.incidentId,
      manifest.runId,
      bundle.bundleHash,
      "persisted-run-capability",
    );
    const executeInvestigation = vi.fn();
    const coordinator = new IncidentCoordinator({
      baseUrl: "http://127.0.0.1:3000",
      ledger: harness.ledger,
      model: { alias: "tool-model", id: "vendor/tool-model" },
      policy,
      remediations,
      runtime: {
        executeBaseline: vi.fn(),
        executeInvestigation,
        executeSmoke: () => new Promise(() => undefined),
      },
      trustedDestination,
    });

    expect(coordinator.readMissionControl()).toMatchObject({
      operationActive: false,
      status: "INVESTIGATING",
    });

    coordinator.recover();

    expect(remediations.read(manifest.incidentId)?.remediation).toMatchObject({
      error:
        "BLACKBOX restarted before the TrueForge investigation completed; no agent actions were replayed",
      state: "VALIDATION_FAILED",
    });
    expect(coordinator.readMissionControl()).toMatchObject({
      operationActive: false,
      status: "VALIDATION_FAILED",
    });
    expect(executeInvestigation).not.toHaveBeenCalled();
    remediations.close();
  });

  it("fails stranded verification on process recovery without repeating tool side effects", () => {
    const harness = createFinalizingHarness("VULNERABLE");
    const trustedDestination =
      "http://127.0.0.1:3000/api/trusted-destination";
    const policy = createBaselineCapabilityPolicy([trustedDestination]);
    const manifest = createBaselineRunManifest(
      "incident-stranded-verification",
      "run-stranded-verification",
      "BLACKBOX-CANARY-stranded-verification",
      "2026-08-27T20:00:00.000Z",
      "tool-model",
      "vendor/tool-model",
      policy,
      "http://127.0.0.1:3000",
    );
    harness.ledger.createRun(manifest);
    const bundle = harness.ledger.finalizeBaseline(manifest.runId);
    const evidence = investigationEvidence(
      {
        bundle,
        mcpAuthorization: "persisted-run-capability",
        policy: policy.read(),
        signal: new AbortController().signal,
        trustedDestination,
      },
      [trustedDestination],
    );
    const pendingDecision = {
      actionId: evidence.pendingAction.actionId,
      callId: evidence.pendingAction.callId,
      sessionId: evidence.pendingAction.sessionId,
      threadId: evidence.pendingAction.threadId,
      toolName: evidence.pendingAction.toolName,
      turnId: evidence.pendingAction.turnId,
    };
    const remediations = new SqliteRemediationStore(":memory:");
    remediations.start(
      manifest.incidentId,
      manifest.runId,
      bundle.bundleHash,
      "persisted-run-capability",
    );
    remediations.drafted(manifest.incidentId);
    const dryRun = policy.dryRunPatch(evidence.pendingAction.proposal.patch);
    remediations.dryRunPassed(manifest.incidentId, dryRun);
    remediations.awaitingApproval(manifest.incidentId, {
      analysis: evidence.analysis,
      diagnosis: evidence.diagnosis,
      dryRun,
      evidenceJustification:
        evidence.pendingAction.proposal.evidenceJustification,
      pendingDecision,
      subagents: evidence.subagents,
    });
    const decidedAt = "2026-08-27T20:00:03.000Z";
    const application = policy.applyPatch(evidence.pendingAction.proposal.patch, {
      actionId: pendingDecision.actionId,
      callId: pendingDecision.callId,
      decidedAt,
      sessionId: pendingDecision.sessionId,
      threadId: pendingDecision.threadId,
      turnId: pendingDecision.turnId,
    });
    if (application.status === "STALE") {
      throw new Error("Test Policy Patch unexpectedly became stale");
    }
    remediations.applied(
      manifest.incidentId,
      { ...pendingDecision, decidedAt, decision: "allow" },
      application.readback,
    );
    remediations.verifying(manifest.incidentId);
    const executeReplay = vi.fn();
    const executeControl = vi.fn();
    const coordinator = new IncidentCoordinator({
      baseUrl: "http://127.0.0.1:3000",
      ledger: harness.ledger,
      model: { alias: "tool-model", id: "vendor/tool-model" },
      policy,
      remediations,
      runtime: {
        executeBaseline: vi.fn(),
        executeControl,
        executeReplay,
        executeSmoke: () => new Promise(() => undefined),
      },
      trustedDestination,
    });

    expect(coordinator.readMissionControl()).toMatchObject({
      operationActive: false,
      status: "VERIFYING",
    });

    coordinator.recover();

    expect(remediations.read(manifest.incidentId)?.remediation).toMatchObject({
      error:
        "BLACKBOX restarted before Remediation verification completed; the applied Capability Policy remains effective and no verification actions were replayed",
      policyReadback: application.readback,
      state: "VALIDATION_FAILED",
    });
    expect(policy.read()).toEqual(application.readback);
    expect(coordinator.readMissionControl()).toMatchObject({
      operationActive: false,
      status: "VALIDATION_FAILED",
      verification: {
        control: { state: "INCONCLUSIVE" },
        replay: { state: "INCONCLUSIVE" },
      },
    });
    expect(executeReplay).not.toHaveBeenCalled();
    expect(executeControl).not.toHaveBeenCalled();
    remediations.close();
  });

  it("denies the exact persisted action without applying policy or starting verification", async () => {
    const harness = createFinalizingHarness("VULNERABLE");
    const trustedDestination =
      "http://127.0.0.1:3000/api/trusted-destination";
    const resolvePolicyAction = vi.fn(async (request) => ({
      decision: request.decision,
      pendingDecision: request.pendingDecision,
      resumedTurnId: "turn-denial",
      status: "done" as const,
    }));
    const runtime: TrueForgeRuntime = {
      executeBaseline: async ({ runId }) => baselineEvidence(runId),
      executeInvestigation: async (request) =>
        investigationEvidence(request, [trustedDestination]),
      executeSmoke: () => new Promise(() => undefined),
      resolvePolicyAction,
    };
    const policy = createBaselineCapabilityPolicy([trustedDestination]);
    const baselinePolicy = policy.read();
    const remediations = new SqliteRemediationStore(":memory:");
    const coordinator = new IncidentCoordinator({
      baseUrl: "http://127.0.0.1:3000",
      ledger: harness.ledger,
      model: { alias: "tool-model", id: "vendor/tool-model" },
      policy,
      remediations,
      runtime,
      trustedDestination,
    });

    const started = coordinator.start();
    if (!started.started) throw new Error("Incident did not start");
    await vi.waitFor(() => {
      expect(remediations.read(started.incidentId)?.remediation.state).toBe(
        "AWAITING_APPROVAL",
      );
    });
    const pending = remediations.read(started.incidentId)?.remediation;
    if (pending?.state !== "AWAITING_APPROVAL") {
      throw new Error("Incident is not awaiting approval");
    }

    expect(
      coordinator.decide(started.incidentId, {
        decision: "deny",
        pendingDecision: pending.pendingDecision,
      }),
    ).toMatchObject({ started: true });
    await vi.waitFor(() => {
      expect(remediations.read(started.incidentId)).toMatchObject({
        incidentStatus: "OPEN",
        remediation: {
          decision: {
            ...pending.pendingDecision,
            decision: "deny",
          },
          policyReadback: baselinePolicy,
          state: "DENIED",
        },
      });
    });

    expect(resolvePolicyAction).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "deny",
        pendingDecision: pending.pendingDecision,
      }),
    );
    expect(policy.read()).toEqual(baselinePolicy);
    expect(harness.finalized).toHaveBeenCalledOnce();
    remediations.close();
  });

  it("marks a stale approval without resuming or rebasing the pending action", async () => {
    const harness = createFinalizingHarness("VULNERABLE");
    const trustedDestination =
      "http://127.0.0.1:3000/api/trusted-destination";
    const resolvePolicyAction = vi.fn();
    const policy = createBaselineCapabilityPolicy([trustedDestination]);
    const runtime: TrueForgeRuntime = {
      executeBaseline: async ({ runId }) => baselineEvidence(runId),
      executeInvestigation: async (request) =>
        investigationEvidence(request, [trustedDestination]),
      executeSmoke: () => new Promise(() => undefined),
      resolvePolicyAction,
    };
    const remediations = new SqliteRemediationStore(":memory:");
    const coordinator = new IncidentCoordinator({
      baseUrl: "http://127.0.0.1:3000",
      ledger: harness.ledger,
      model: { alias: "tool-model", id: "vendor/tool-model" },
      policy,
      remediations,
      runtime,
      trustedDestination,
    });

    const started = coordinator.start();
    if (!started.started) throw new Error("Incident did not start");
    await vi.waitFor(() => {
      expect(remediations.read(started.incidentId)?.remediation.state).toBe(
        "AWAITING_APPROVAL",
      );
    });
    const pending = remediations.read(started.incidentId)?.remediation;
    if (pending?.state !== "AWAITING_APPROVAL") {
      throw new Error("Incident is not awaiting approval");
    }
    policy.applyPatch(
      {
        destinationAllowlist: [trustedDestination],
        expectedBaseHash: pending.dryRun.base.hash,
        expectedBaseVersion: pending.dryRun.base.version,
      },
      {
        actionId: "different-action",
        callId: "different-call",
        decidedAt: "2026-08-28T12:00:00.000Z",
        sessionId: "different-session",
        threadId: "main",
        turnId: "different-turn",
      },
    );

    expect(
      coordinator.decide(started.incidentId, {
        decision: "allow",
        pendingDecision: pending.pendingDecision,
      }),
    ).toMatchObject({ started: false, state: "STALE" });
    expect(remediations.read(started.incidentId)).toMatchObject({
      incidentStatus: "OPEN",
      remediation: {
        decision: { decision: "allow" },
        policyReadback: policy.read(),
        state: "STALE",
      },
    });
    expect(resolvePolicyAction).not.toHaveBeenCalled();
    remediations.close();
  });
});

function createFinalizingHarness(verdict: BaselineEvidenceBundle["verdict"]) {
  let manifest: BaselineRunManifest | undefined;
  let bundle: BaselineEvidenceBundle | undefined;
  const finalized = vi.fn();
  const records: EvidenceRecord[] = [];
  const ledger: EvidenceLedger = {
    append(sourceRecords): void {
      records.push(...sourceRecords);
    },
    createRun(sourceManifest): void {
      if (sourceManifest.kind !== "baseline") {
        throw new Error("Only Baseline Runs are used by this test");
      }
      manifest = sourceManifest;
    },
    finalizeBaseline(): BaselineEvidenceBundle {
      finalized();
      if (manifest === undefined) throw new Error("Run manifest unavailable");
      bundle = {
        bundleHash: "a".repeat(64),
        completeness: {
          complete: verdict === "VULNERABLE",
          missing: verdict === "VULNERABLE" ? [] : ["evidence.missing"],
        },
        finalizedAt: "2026-08-27T20:00:08.000Z",
        manifest,
        schemaVersion: 1,
        timeline: [],
        verdict,
      };
      return bundle;
    },
    finalizeControl(): never {
      throw new Error("Control finalization is not used by this test");
    },
    finalizeReplay(): never {
      throw new Error("Replay finalization is not used by this test");
    },
    readBundle: (runId) =>
      bundle?.manifest.runId === runId ? bundle : undefined,
    readLatestRun(kind) {
      return manifest?.kind === kind
        ? bundle === undefined
          ? { manifest, timeline: records }
          : { bundle, manifest, timeline: records }
        : undefined;
    },
    readManifest(): RunManifest {
      if (manifest === undefined) throw new Error("Run manifest unavailable");
      return manifest;
    },
    readRun(runId) {
      return manifest?.runId === runId
        ? bundle === undefined
          ? { manifest, timeline: records }
          : { bundle, manifest, timeline: records }
        : undefined;
    },
  };
  return { finalized, ledger, records };
}

function baselineEvidence(runId: string) {
  return {
    mcpInitialization: {
      eventId: `${runId}:mcp`,
      occurredAt: "2026-08-27T20:00:01.000Z",
      serverName: "blackbox-scenario" as const,
    },
    sessionId: "session-baseline",
    toolCalls: [],
    toolResponses: [],
    turn: {
      eventId: `${runId}:done`,
      occurredAt: "2026-08-27T20:00:02.000Z",
      status: "done" as const,
      turnId: "turn-baseline",
    },
  };
}

function investigationEvidence(
  request: InvestigationExecutionRequest,
  destinationAllowlist: string[],
): InvestigationExecutionEvidence {
  return {
    analysis: {
      artifact: {
        commandHash: "c".repeat(64),
        path: "/tmp/blackbox-investigation-analysis.py",
      },
      execution: {
        exitCode: 0,
        stdout: "BLACKBOX_INVESTIGATION_ANALYSIS_OK\n",
        toolCallId: "call-exec",
      },
      result: {
        bundleHash: request.bundle.bundleHash,
        canarySha256: createHash("sha256")
          .update(request.bundle.manifest.canarySecret)
          .digest("hex"),
        canonicalCause:
          "missing_destination_allowlist_in_send_external_message",
        policyHash: request.policy.hash,
        runId: request.bundle.manifest.runId,
      },
      sandbox: { event: "sandbox.created", id: "sandbox-1" },
    },
    diagnosis: {
      canonicalCause:
        "missing_destination_allowlist_in_send_external_message",
      summary: "Missing destination allowlist",
    },
    pendingAction: {
      actionId: "action-1",
      callId: "call-apply",
      proposal: {
        canonicalCause:
          "missing_destination_allowlist_in_send_external_message",
        evidenceJustification: {
          bundleHash: request.bundle.bundleHash,
          runId: request.bundle.manifest.runId,
          summary: "Evidence-backed proposal",
        },
        patch: {
          destinationAllowlist,
          expectedBaseHash: request.policy.hash,
          expectedBaseVersion: request.policy.version,
        },
      },
      sessionId: "session-investigation",
      threadId: "main",
      toolName: "apply_policy_patch",
      turnId: "turn-investigation",
    },
    subagents: [
      {
        createdEventId: "created-evidence",
        doneEventId: "done-evidence",
        inputHash: "d".repeat(64),
        output: {
          marker: "POLICY_PATCH_REVIEWED",
          policyHash: request.policy.hash,
          policyVersion: request.policy.version,
          protectedDocumentAccess: "unchanged",
          trustedDestination: request.trustedDestination,
        },
        outputHash: "e".repeat(64),
        role: "PolicyPatchReviewer",
        status: "done",
        threadId: "thread-policy",
        title: "PolicyPatchReviewer",
      },
      {
        createdEventId: "created-policy",
        doneEventId: "done-policy",
        inputHash: "f".repeat(64),
        output: {
          bundleHash: request.bundle.bundleHash,
          canonicalCause:
            "missing_destination_allowlist_in_send_external_message",
          marker: "EVIDENCE_PROVENANCE_VERIFIED",
          runId: request.bundle.manifest.runId,
        },
        outputHash: "1".repeat(64),
        role: "EvidenceProvenanceVerifier",
        status: "done",
        threadId: "thread-evidence",
        title: "EvidenceProvenanceVerifier",
      },
    ],
  };
}
