import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  BaselineEvidenceBundle,
  ControlEvidenceBundle,
  EvidenceBundle,
  EvidenceLedger,
  EvidenceRecord,
  ReplayEvidenceBundle,
  RunManifest,
} from "../evidence/ledger.js";
import { baselineEvidenceBundleSchema } from "../evidence/ledger.js";
import { classifyTrueForgeFailure } from "../failure.js";
import type { MissionControlSnapshot } from "../mission-control/schema.js";
import { createMissionControlSnapshot } from "../mission-control/snapshot.js";
import type {
  CapabilityPolicy,
  PolicyApplicationResult,
  PolicyApprovalEvidence,
  PolicyRead,
} from "../policy/capability-policy.js";
import {
  type AwaitingApprovalRemediation,
  type DurableIncidentRead,
  type RemediationDecisionRequest,
  SqliteRemediationStore,
} from "../remediation/store.js";
import type {
  BaselineRunObservation,
  BaselineRunObservationContext,
} from "../observability/evlog.js";
import {
  createBaselineRunManifest,
  createControlRunManifest,
  createReplayRunManifest,
} from "../scenario/definition.js";
import {
  InvestigationExecutionError,
  type InvestigationProposal,
  investigationProposalSchema,
  investigationExecutionEvidenceSchema,
  policyActionResolutionSchema,
} from "../trueforge/runtime.js";
import type {
  BaselineExecutionEvidence,
  TrueForgeRuntime,
} from "../trueforge/runtime.js";

export type StartIncidentResult =
  | { incidentId: string; runId: string; started: true }
  | { activeRunId: string; started: false };

export type RunRead =
  | { status: "running" }
  | { bundle: EvidenceBundle; status: "completed" };

export type RemediationDecisionResult =
  | { started: true }
  | { started: false; state: "STALE" };

export interface IncidentCoordinatorOptions {
  baseUrl: string;
  ledger: EvidenceLedger;
  model: { alias: string; id: string };
  observeBaselineRun?: (
    context: BaselineRunObservationContext,
  ) => BaselineRunObservation;
  policy: CapabilityPolicy;
  remediations: SqliteRemediationStore;
  runtime: TrueForgeRuntime;
  trustedDestination: string;
  trueForgeUrl?: string;
}

export class IncidentCoordinator {
  readonly #ledger: EvidenceLedger;
  readonly #baseUrl: string;
  readonly #modelAlias: string;
  readonly #modelId: string;
  readonly #policy: CapabilityPolicy;
  readonly #runtime: TrueForgeRuntime;
  readonly #remediations: SqliteRemediationStore;
  readonly #trustedDestination: string;
  readonly #trueForgeUrl: string | undefined;
  readonly #observeBaselineRun:
    | ((context: BaselineRunObservationContext) => BaselineRunObservation)
    | undefined;
  #active:
    | {
        completion: Promise<void>;
        controller: AbortController;
        mcpAuthorization: string;
        runId: string;
      }
    | undefined;
  #activeDecision:
    | {
        completion: Promise<void>;
        controller: AbortController;
        incidentId: string;
        mcpAuthorization: string;
      }
    | undefined;
  #pendingApplication:
    | {
        approval: PolicyApprovalEvidence;
        incidentId: string;
        proposal: InvestigationProposal;
      }
    | undefined;
  #current:
    | {
        incidentId: string;
        runId: string;
      }
    | undefined;

  constructor(options: IncidentCoordinatorOptions) {
    this.#runtime = options.runtime;
    this.#ledger = options.ledger;
    this.#policy = options.policy;
    this.#modelAlias = options.model.alias;
    this.#modelId = options.model.id;
    this.#baseUrl = options.baseUrl;
    this.#remediations = options.remediations;
    this.#trustedDestination = options.trustedDestination;
    this.#trueForgeUrl = options.trueForgeUrl;
    this.#observeBaselineRun = options.observeBaselineRun;
  }

  recover(): void {
    this.#resumeUnmatchedBaseline();
  }

  start(): StartIncidentResult {
    if (this.#active !== undefined) {
      return { activeRunId: this.#active.runId, started: false };
    }
    if (this.#activeDecision !== undefined) {
      const incident = this.#remediations.read(this.#activeDecision.incidentId);
      return {
        activeRunId:
          incident?.baseline.runId ?? this.#activeDecision.incidentId,
        started: false,
      };
    }
    const durableBaseline = this.#ledger.readLatestRun("baseline");
    if (durableBaseline !== undefined && durableBaseline.bundle === undefined) {
      return { activeRunId: durableBaseline.manifest.runId, started: false };
    }
    const durableIncident = this.#remediations.readLatest();
    if (
      durableIncident !== undefined &&
      isDurableWorkInProgress(durableIncident)
    ) {
      return { activeRunId: durableIncident.baseline.runId, started: false };
    }

    const incidentId = randomUUID();
    const runId = randomUUID();
    const mcpAuthorization = randomBytes(32).toString("base64url");
    const createdAt = new Date().toISOString();
    const manifest = createBaselineRunManifest(
      incidentId,
      runId,
      `BLACKBOX-CANARY-${randomUUID()}`,
      createdAt,
      this.#modelAlias,
      this.#modelId,
      this.#policy,
      this.#baseUrl,
    );
    this.#current = { incidentId, runId };
    this.#ledger.createRun(manifest);
    this.#ledger.append([
      stateRecord(runId, "PREPARING", createdAt),
      stateRecord(runId, "EXECUTING", nextInstant(createdAt)),
    ]);

    const controller = new AbortController();
    const observation = this.#startObservation({
      incidentId,
      modelAlias: this.#modelAlias,
      modelId: this.#modelId,
      runId,
    });
    const completion = this.#execute(
      runId,
      mcpAuthorization,
      observation,
      controller.signal,
    ).finally(() => {
      if (this.#active?.runId === runId) this.#active = undefined;
    });
    this.#active = { completion, controller, mcpAuthorization, runId };
    void completion.catch(() => undefined);
    return { incidentId, runId, started: true };
  }

  read(runId: string): RunRead | undefined {
    const bundle = this.#ledger.readBundle(runId);
    if (bundle !== undefined) return { bundle, status: "completed" };
    if (this.#ledger.readRun(runId) !== undefined) return { status: "running" };
    return undefined;
  }

  readIncident(incidentId: string): DurableIncidentRead | undefined {
    return this.#remediations.read(incidentId);
  }

  readMissionControl(): MissionControlSnapshot {
    const current = this.#current;
    const baselineRun =
      current === undefined
        ? this.#ledger.readLatestRun("baseline")
        : this.#ledger.readRun(current.runId);
    const runId = baselineRun?.manifest.runId ?? current?.runId;
    const candidateIncident =
      current === undefined
        ? this.#remediations.readLatest()
        : this.#remediations.read(current.incidentId);
    const incident =
      candidateIncident?.baseline.runId === runId
        ? candidateIncident
        : undefined;
    const replayRunId = verificationRunId(incident, "replay");
    const controlRunId = verificationRunId(incident, "control");
    const replayRun =
      replayRunId === undefined
        ? undefined
        : this.#ledger.readRun(replayRunId);
    const controlRun =
      controlRunId === undefined
        ? undefined
        : this.#ledger.readRun(controlRunId);
    return createMissionControlSnapshot(
      baselineRun,
      replayRun,
      controlRun,
      incident,
      baselineRun !== undefined && baselineRun.bundle === undefined,
      incident !== undefined &&
        this.#activeDecision?.incidentId === incident.incidentId,
      this.#trueForgeUrl,
    );
  }

  decide(
    incidentId: string,
    request: RemediationDecisionRequest,
  ): RemediationDecisionResult {
    const incident = this.#remediations.read(incidentId);
    if (incident === undefined) {
      throw new Error(`Incident ${incidentId} was not found`);
    }
    if (incident.remediation.state !== "AWAITING_APPROVAL") {
      throw new Error(`Incident ${incidentId} is not awaiting approval`);
    }
    if (
      !isDeepStrictEqual(
        request.pendingDecision,
        incident.remediation.pendingDecision,
      )
    ) {
      throw new Error("Remediation decision does not match the pending action");
    }
    if (this.#activeDecision !== undefined) {
      throw new Error("A Remediation decision is already running");
    }
    if (this.#active !== undefined) {
      throw new Error("A Baseline Run is already running");
    }

    const decidedAt = new Date().toISOString();
    const decisionEvidence = {
      ...request.pendingDecision,
      decidedAt,
      decision: request.decision,
    };
    const existingApplication =
      request.decision === "allow"
        ? this.#policy.readApplication(request.pendingDecision.actionId)
        : undefined;
    if (
      request.decision === "allow" &&
      existingApplication === undefined &&
      !policyMatchesRead(
        this.#policy.read(),
        incident.remediation.dryRun.base,
      )
    ) {
      this.#remediations.stale(
        incidentId,
        { ...decisionEvidence, decision: "allow" },
        this.#policy.read(),
      );
      return { started: false, state: "STALE" };
    }

    const controller = new AbortController();
    const mcpAuthorization =
      this.#remediations.readMcpAuthorization(incidentId);
    const completion = (
      existingApplication === undefined
        ? this.#resolveDecision(
            incidentId,
            request,
            decidedAt,
            mcpAuthorization,
            controller.signal,
          )
        : this.#resumeAppliedDecision(
            incidentId,
            incident.remediation,
            request.pendingDecision,
            existingApplication,
            mcpAuthorization,
            controller.signal,
          )
    ).finally(() => {
      if (this.#activeDecision?.incidentId === incidentId) {
        this.#activeDecision = undefined;
      }
    });
    this.#activeDecision = {
      completion,
      controller,
      incidentId,
      mcpAuthorization,
    };
    void completion.catch(() => undefined);
    return { started: true };
  }

  applyApprovedPolicyPatch(
    sourceProposal: InvestigationProposal,
  ): PolicyApplicationResult {
    const proposal = investigationProposalSchema.parse(sourceProposal);
    const pending = this.#pendingApplication;
    if (pending === undefined) {
      throw new Error("No approved Policy Patch action is being resumed");
    }
    if (!isDeepStrictEqual(proposal, pending.proposal)) {
      throw new Error("Policy Patch call does not match the approved proposal");
    }
    return this.#policy.applyPatch(proposal.patch, pending.approval);
  }

  isMcpAuthorized(authorization: string | undefined): boolean {
    const capability =
      this.#active?.mcpAuthorization ??
      this.#activeDecision?.mcpAuthorization;
    if (capability === undefined || authorization === undefined) return false;
    const expected = Buffer.from(`Bearer ${capability}`);
    const received = Buffer.from(authorization);
    return (
      expected.length === received.length && timingSafeEqual(expected, received)
    );
  }

  async shutdown(): Promise<void> {
    const active = this.#active;
    const activeDecision = this.#activeDecision;
    active?.controller.abort(new Error("BLACKBOX is shutting down"));
    activeDecision?.controller.abort(new Error("BLACKBOX is shutting down"));
    await Promise.all([active?.completion, activeDecision?.completion]);
  }

  async #resolveDecision(
    incidentId: string,
    request: RemediationDecisionRequest,
    decidedAt: string,
    mcpAuthorization: string,
    signal: AbortSignal,
  ): Promise<void> {
    const resolvePolicyAction = this.#runtime.resolvePolicyAction;
    if (resolvePolicyAction === undefined) {
      this.#remediations.validationFailed(
        incidentId,
        "TrueForge policy-action runtime is unavailable",
        request.pendingDecision,
      );
      return;
    }
    const approval: PolicyApprovalEvidence = {
      actionId: request.pendingDecision.actionId,
      callId: request.pendingDecision.callId,
      decidedAt,
      sessionId: request.pendingDecision.sessionId,
      threadId: request.pendingDecision.threadId,
      turnId: request.pendingDecision.turnId,
    };
    const incident = this.#remediations.read(incidentId);
    if (incident?.remediation.state !== "AWAITING_APPROVAL") {
      throw new Error(`Incident ${incidentId} is not awaiting approval`);
    }
    const proposal = proposalFromRemediation(incident.remediation);
    if (request.decision === "allow") {
      this.#pendingApplication = { approval, incidentId, proposal };
    }
    try {
      const resolution = policyActionResolutionSchema.parse(
        await resolvePolicyAction({
          decision: request.decision,
          mcpAuthorization,
          pendingDecision: request.pendingDecision,
          signal,
        }),
      );
      if (
        resolution.decision !== request.decision ||
        !isDeepStrictEqual(
          resolution.pendingDecision,
          request.pendingDecision,
        )
      ) {
        throw new Error("TrueForge resumed a different pending action");
      }
      if (request.decision === "deny") {
        this.#remediations.denied(
          incidentId,
          {
            ...request.pendingDecision,
            decidedAt,
            decision: "deny",
          },
          this.#policy.read(),
        );
        return;
      }
      const application = this.#policy.readApplication(
        request.pendingDecision.actionId,
      );
      if (application === undefined) {
        const readback = this.#policy.read();
        if (
          !policyMatchesRead(readback, incident.remediation.dryRun.base)
        ) {
          this.#remediations.stale(
            incidentId,
            {
              ...request.pendingDecision,
              decidedAt,
              decision: "allow",
            },
            readback,
          );
          return;
        }
        throw new Error(
          "Approved apply_policy_patch produced no durable application",
        );
      }
      if (application.status === "STALE") {
        this.#remediations.stale(
          incidentId,
          {
            ...request.pendingDecision,
            decidedAt,
            decision: "allow",
          },
          application.readback,
        );
        return;
      }
      const readback = validateAppliedPolicy(
        this.#policy,
        application,
        approval,
        incident.remediation,
      );
      this.#remediations.applied(
        incidentId,
        {
          ...request.pendingDecision,
          decidedAt,
          decision: "allow",
        },
        readback,
      );
      this.#remediations.verifying(incidentId);
      await this.#verifyRemediation(incidentId, mcpAuthorization, signal);
    } catch (error) {
      const applied = this.#policy.readApplication(
        request.pendingDecision.actionId,
      );
      const current = this.#remediations.read(incidentId);
      if (
        request.decision === "allow" &&
        applied !== undefined &&
        applied.status !== "STALE" &&
        current?.remediation.state === "AWAITING_APPROVAL"
      ) {
        try {
          const readback = validateAppliedPolicy(
            this.#policy,
            applied,
            approval,
            current.remediation,
          );
          this.#remediations.applied(
            incidentId,
            {
              ...request.pendingDecision,
              decidedAt: applied.approval.decidedAt,
              decision: "allow",
            },
            readback,
          );
        } catch {
          // The original failure remains authoritative when reconciliation fails.
        }
      }
      this.#remediations.validationFailed(
        incidentId,
        error instanceof Error
          ? error.message
          : "TrueForge policy-action resolution failed",
        request.pendingDecision,
      );
    } finally {
      if (this.#pendingApplication?.incidentId === incidentId) {
        this.#pendingApplication = undefined;
      }
    }
  }

  async #resumeAppliedDecision(
    incidentId: string,
    remediation: AwaitingApprovalRemediation,
    pendingDecision: RemediationDecisionRequest["pendingDecision"],
    application: PolicyApplicationResult,
    mcpAuthorization: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      if (application.status === "STALE") {
        throw new Error("Persisted Policy application cannot be STALE");
      }
      const readback = validateAppliedPolicy(
        this.#policy,
        application,
        {
          actionId: pendingDecision.actionId,
          callId: pendingDecision.callId,
          decidedAt: application.approval.decidedAt,
          sessionId: pendingDecision.sessionId,
          threadId: pendingDecision.threadId,
          turnId: pendingDecision.turnId,
        },
        remediation,
      );
      this.#remediations.applied(
        incidentId,
        {
          ...pendingDecision,
          decidedAt: application.approval.decidedAt,
          decision: "allow",
        },
        readback,
      );
      this.#remediations.verifying(incidentId);
      await this.#verifyRemediation(incidentId, mcpAuthorization, signal);
    } catch (error) {
      this.#remediations.validationFailed(
        incidentId,
        error instanceof Error
          ? error.message
          : "Persisted Policy application recovery failed",
        pendingDecision,
      );
    }
  }

  async #verifyRemediation(
    incidentId: string,
    mcpAuthorization: string,
    signal: AbortSignal,
  ): Promise<void> {
    const incident = this.#remediations.read(incidentId);
    if (incident?.remediation.state !== "VERIFYING") {
      throw new Error(`Incident ${incidentId} is not verifying`);
    }
    const baseline = baselineEvidenceBundleSchema.parse(
      this.#ledger.readBundle(incident.baseline.runId),
    );
    const executeReplay = this.#runtime.executeReplay;
    const executeControl = this.#runtime.executeControl;
    if (executeReplay === undefined || executeControl === undefined) {
      throw new Error("TrueForge verification runtime is unavailable");
    }

    const replayManifest = createReplayRunManifest(
      baseline.manifest,
      randomUUID(),
      `BLACKBOX-CANARY-${randomUUID()}`,
      new Date().toISOString(),
      this.#policy,
    );
    await this.#executeVerificationRun(
      replayManifest,
      executeReplay,
      mcpAuthorization,
      signal,
    );
    await waitForCutoff(50, signal);
    this.#ledger.append([
      {
        id: `${replayManifest.runId}:sink-cutoff`,
        occurredAt: new Date().toISOString(),
        runId: replayManifest.runId,
        source: "blackbox",
        type: "sink.observation_cutoff",
      },
    ]);
    const replay = this.#ledger.finalizeReplay(replayManifest.runId);
    this.#remediations.recordReplay(incidentId, replayReference(replay));

    const controlManifest = createControlRunManifest(
      baseline.manifest,
      randomUUID(),
      `BLACKBOX-CANARY-${randomUUID()}`,
      `BLACKBOX-CONTROL-RESPONSE-${randomUUID()}`,
      new Date().toISOString(),
      this.#policy,
      this.#trustedDestination,
    );
    await this.#executeVerificationRun(
      controlManifest,
      executeControl,
      mcpAuthorization,
      signal,
    );
    const control = this.#ledger.finalizeControl(controlManifest.runId);
    this.#remediations.recordControl(incidentId, controlReference(control));

    if (
      replay.verdict !== "PROTECTED" ||
      !replay.completeness.complete ||
      control.controlResult !== "PASSED" ||
      !control.completeness.complete
    ) {
      throw new Error(
        `Remediation verification evidence gates did not pass: replay=${replay.completeness.missing.join(",") || "complete"}; control=${control.completeness.missing.join(",") || "complete"}`,
      );
    }
    this.#remediations.verified(incidentId);
  }

  async #executeVerificationRun(
    manifest: RunManifest,
    execute: NonNullable<TrueForgeRuntime["executeReplay"]>,
    mcpAuthorization: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.#ledger.createRun(manifest);
    this.#ledger.append([
      stateRecord(manifest.runId, "PREPARING", manifest.createdAt),
      stateRecord(manifest.runId, "EXECUTING", nextInstant(manifest.createdAt)),
    ]);
    let latestObservedAt = nextInstant(manifest.createdAt);
    try {
      const evidence = await execute({
        mcpAuthorization,
        runId: manifest.runId,
        signal,
      });
      const records = baselineEvidenceRecords(manifest.runId, evidence);
      this.#ledger.append(records);
      latestObservedAt = records.reduce(
        (latest, record) =>
          record.occurredAt > latest ? record.occurredAt : latest,
        latestObservedAt,
      );
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("TrueForge Run failed");
      const classified = classifyTrueForgeFailure(failure.message);
      latestObservedAt = new Date().toISOString();
      this.#ledger.append([
        {
          id: `${manifest.runId}:failed`,
          message: classified.failure.message,
          occurredAt: latestObservedAt,
          runId: manifest.runId,
          source: "blackbox",
          stage: classified.stage,
          type: "run.failed",
        },
      ]);
    }
    this.#ledger.append([
      stateRecord(
        manifest.runId,
        "VERIFYING",
        nextInstant(latestObservedAt),
      ),
    ]);
  }

  async #execute(
    runId: string,
    mcpAuthorization: string,
    observation: BaselineRunObservation | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      let latestObservedAt = new Date().toISOString();
      let evidence: BaselineExecutionEvidence | undefined;
      try {
        evidence = await this.#runtime.executeBaseline({
          mcpAuthorization,
          runId,
          signal,
        });
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error("TrueForge Run failed");
        const classifiedFailure = classifyTrueForgeFailure(failure.message);
        safelyObserve(() =>
          observation?.failed(
            classifiedFailure.failure,
            classifiedFailure.stage,
          ),
        );
        const failedAt = new Date().toISOString();
        this.#ledger.append([
          {
            id: `${runId}:failed`,
            message: classifiedFailure.failure.message,
            occurredAt: failedAt,
            runId,
            source: "blackbox",
            stage: classifiedFailure.stage,
            type: "run.failed",
          },
        ]);
        latestObservedAt = failedAt;
      }
      if (evidence !== undefined) {
        const records = baselineEvidenceRecords(runId, evidence);
        this.#ledger.append(records);
        latestObservedAt = records.reduce(
          (latest, record) =>
            record.occurredAt > latest ? record.occurredAt : latest,
          latestObservedAt,
        );
      }
      this.#ledger.append([
        stateRecord(runId, "VERIFYING", nextInstant(latestObservedAt)),
      ]);
      const bundle = this.#ledger.finalizeBaseline(runId);
      safelyObserve(() => observation?.completed(bundle));
      if (bundle.verdict === "VULNERABLE") {
        await this.#investigate(bundle, mcpAuthorization, signal);
      }
    } catch (error) {
      safelyObserve(() => observation?.finalizationFailed());
      throw error;
    }
  }

  #resumeUnmatchedBaseline(): void {
    const run = this.#ledger.readLatestRun("baseline");
    if (run?.bundle?.manifest.kind !== "baseline") {
      return;
    }

    const bundle = baselineEvidenceBundleSchema.parse(run.bundle);
    if (
      bundle.verdict !== "VULNERABLE" ||
      this.#remediations.read(bundle.manifest.incidentId) !== undefined
    ) {
      return;
    }
    const runId = bundle.manifest.runId;
    const mcpAuthorization = randomBytes(32).toString("base64url");
    const controller = new AbortController();
    this.#current = { incidentId: bundle.manifest.incidentId, runId };
    const completion = this.#investigate(
      bundle,
      mcpAuthorization,
      controller.signal,
    ).finally(() => {
      if (this.#active?.runId === runId) this.#active = undefined;
    });
    this.#active = { completion, controller, mcpAuthorization, runId };
    void completion.catch(() => undefined);
  }

  async #investigate(
    bundle: BaselineEvidenceBundle,
    mcpAuthorization: string,
    signal: AbortSignal,
  ): Promise<void> {
    const incidentId = bundle.manifest.incidentId;
    this.#remediations.start(
      incidentId,
      bundle.manifest.runId,
      bundle.bundleHash,
      mcpAuthorization,
    );
    const executeInvestigation = this.#runtime.executeInvestigation;
    if (executeInvestigation === undefined) {
      this.#remediations.validationFailed(
        incidentId,
        "TrueForge investigation runtime is unavailable",
      );
      return;
    }

    const policy = this.#policy.read();
    let evidence:
      | ReturnType<typeof investigationExecutionEvidenceSchema.parse>
      | undefined;
    let executionError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        evidence = investigationExecutionEvidenceSchema.parse(
          await executeInvestigation({
            bundle,
            mcpAuthorization,
            onMilestone: (milestone) => {
              this.#remediations.recordInvestigationMilestone(
                incidentId,
                milestone,
              );
            },
            policy,
            signal,
            trustedDestination: this.#trustedDestination,
          }),
        );
        break;
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error("Investigation failed");
        executionError = failure;
        if (!isRetryableInvestigationFailure(failure, signal)) break;
      }
    }
    if (evidence === undefined) {
      this.#remediations.validationFailed(
        incidentId,
        executionError instanceof Error
          ? executionError.message
          : "Investigation failed",
      );
      return;
    }

    const pendingDecision = {
      actionId: evidence.pendingAction.actionId,
      callId: evidence.pendingAction.callId,
      sessionId: evidence.pendingAction.sessionId,
      threadId: evidence.pendingAction.threadId,
      toolName: evidence.pendingAction.toolName,
      turnId: evidence.pendingAction.turnId,
    };
    try {
      validateInvestigationEvidence(
        evidence,
        bundle,
        policy,
        this.#trustedDestination,
      );
      this.#remediations.drafted(incidentId);
      const dryRun = this.#policy.dryRunPatch(
        evidence.pendingAction.proposal.patch,
      );
      this.#remediations.dryRunPassed(incidentId, dryRun);
      this.#remediations.awaitingApproval(incidentId, {
        analysis: evidence.analysis,
        diagnosis: evidence.diagnosis,
        dryRun,
        evidenceJustification:
          evidence.pendingAction.proposal.evidenceJustification,
        pendingDecision,
        subagents: evidence.subagents,
      });
    } catch (error) {
      this.#remediations.validationFailed(
        incidentId,
        error instanceof Error ? error.message : "Investigation failed",
        pendingDecision,
      );
    }
  }

  #startObservation(
    context: BaselineRunObservationContext,
  ): BaselineRunObservation | undefined {
    try {
      return this.#observeBaselineRun?.(context);
    } catch {
      return undefined;
    }
  }
}

function isDurableWorkInProgress(incident: DurableIncidentRead): boolean {
  return (
    incident.remediation.state === "INVESTIGATING" ||
    incident.remediation.state === "DRAFTED" ||
    incident.remediation.state === "DRY_RUN_PASSED" ||
    incident.remediation.state === "AWAITING_APPROVAL" ||
    incident.remediation.state === "APPLIED" ||
    incident.remediation.state === "VERIFYING"
  );
}

function verificationRunId(
  incident: DurableIncidentRead | undefined,
  kind: "replay" | "control",
): string | undefined {
  const remediation = incident?.remediation;
  if (
    remediation?.state !== "VERIFYING" &&
    remediation?.state !== "VERIFIED" &&
    remediation?.state !== "VALIDATION_FAILED"
  ) {
    return undefined;
  }
  return remediation.verification?.[kind]?.runId;
}

function validateInvestigationEvidence(
  evidence: ReturnType<typeof investigationExecutionEvidenceSchema.parse>,
  bundle: BaselineEvidenceBundle,
  policy: ReturnType<CapabilityPolicy["read"]>,
  trustedDestination: string,
): void {
  const proposal = evidence.pendingAction.proposal;
  const [policyReview, provenanceReview] = evidence.subagents;
  const analysis = evidence.analysis.result;
  if (
    proposal.evidenceJustification.bundleHash !== bundle.bundleHash ||
    proposal.evidenceJustification.runId !== bundle.manifest.runId ||
    analysis.bundleHash !== bundle.bundleHash ||
    analysis.runId !== bundle.manifest.runId ||
    analysis.canarySha256 !== sha256(bundle.manifest.canarySecret) ||
    analysis.policyHash !== policy.hash
  ) {
    throw new Error("Policy Patch justification does not match Baseline evidence");
  }
  if (
    evidence.diagnosis.canonicalCause !== proposal.canonicalCause ||
    analysis.canonicalCause !== proposal.canonicalCause ||
    provenanceReview.output.bundleHash !== bundle.bundleHash ||
    provenanceReview.output.runId !== bundle.manifest.runId ||
    provenanceReview.output.canonicalCause !== proposal.canonicalCause ||
    policyReview.output.policyHash !== policy.hash ||
    policyReview.output.policyVersion !== policy.version ||
    policyReview.output.trustedDestination !== trustedDestination ||
    new Set(evidence.subagents.map((subagent) => subagent.threadId)).size !== 2
  ) {
    throw new Error("Investigation evidence does not prove two focused subagents");
  }
  if (
    !evidence.analysis.execution.stdout
      .split(/\r?\n/)
      .includes("BLACKBOX_INVESTIGATION_ANALYSIS_OK")
  ) {
    throw new Error("Daytona analysis artifact did not prove the diagnosis");
  }
}

function proposalFromRemediation(
  remediation: AwaitingApprovalRemediation,
): InvestigationProposal {
  return investigationProposalSchema.parse({
    canonicalCause: remediation.diagnosis.canonicalCause,
    evidenceJustification: remediation.evidenceJustification,
    patch: {
      destinationAllowlist:
        remediation.dryRun.candidate.rules.send_external_message.destinations,
      expectedBaseHash: remediation.dryRun.base.hash,
      expectedBaseVersion: remediation.dryRun.base.version,
    },
  });
}

function validateAppliedPolicy(
  policy: CapabilityPolicy,
  application: Exclude<PolicyApplicationResult, { status: "STALE" }>,
  approval: PolicyApprovalEvidence,
  remediation: AwaitingApprovalRemediation,
): PolicyRead {
  if (!isDeepStrictEqual(application.approval, approval)) {
    throw new Error("Persisted Policy application approval evidence mismatched");
  }
  const readback = policy.read();
  if (
    !isDeepStrictEqual(readback, application.readback) ||
    readback.hash !== remediation.dryRun.candidateHash ||
    readback.version !== remediation.dryRun.candidate.version
  ) {
    throw new Error("Applied Capability Policy readback did not match dry-run");
  }
  return readback;
}

function policyMatchesRead(
  policy: PolicyRead,
  expected: { hash: string; version: number },
): boolean {
  return policy.hash === expected.hash && policy.version === expected.version;
}

function replayReference(replay: ReplayEvidenceBundle) {
  return {
    bundleHash: replay.bundleHash,
    complete: replay.completeness.complete,
    runId: replay.manifest.runId,
    verdict: replay.verdict,
  };
}

function controlReference(control: ControlEvidenceBundle) {
  return {
    bundleHash: control.bundleHash,
    complete: control.completeness.complete,
    controlResult: control.controlResult,
    runId: control.manifest.runId,
  };
}

async function waitForCutoff(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const complete = (): void => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(complete, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRetryableInvestigationFailure(
  error: Error,
  signal: AbortSignal,
): boolean {
  if (signal.aborted) return false;
  if (
    error instanceof InvestigationExecutionError &&
    error.pendingActionObserved
  ) {
    return false;
  }
  return classifyTrueForgeFailure(error.message).failure.retryable;
}

function baselineEvidenceRecords(
  runId: string,
  evidence: BaselineExecutionEvidence,
): EvidenceRecord[] {
  return [
    {
      id: evidence.mcpInitialization.eventId,
      occurredAt: evidence.mcpInitialization.occurredAt,
      runId,
      serverName: evidence.mcpInitialization.serverName,
      source: "trueforge",
      type: "mcp.initialized",
    },
    ...evidence.toolCalls.map(
      (call): EvidenceRecord => ({
        arguments: call.arguments,
        id: call.eventId,
        occurredAt: call.occurredAt,
        runId,
        source: "trueforge",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        type: "tool.called",
      }),
    ),
    ...evidence.toolResponses.map(
      (response): EvidenceRecord => ({
        content: response.content,
        id: response.eventId,
        occurredAt: response.occurredAt,
        runId,
        source: "trueforge",
        toolCallId: response.toolCallId,
        type: "tool.responded",
      }),
    ),
    {
      id: evidence.turn.eventId,
      occurredAt: evidence.turn.occurredAt,
      runId,
      sessionId: evidence.sessionId,
      source: "trueforge",
      status: evidence.turn.status,
      turnId: evidence.turn.turnId,
      type: "turn.completed",
    },
  ];
}

function safelyObserve(operation: () => void): void {
  try {
    operation();
  } catch {
    // Operational telemetry must never affect forensic evidence or verdicts.
  }
}

function nextInstant(timestamp: string): string {
  return new Date(Date.parse(timestamp) + 1).toISOString();
}

function stateRecord(
  runId: string,
  state: "PREPARING" | "EXECUTING" | "VERIFYING",
  occurredAt: string,
): EvidenceRecord {
  return {
    id: `${runId}:state:${state}`,
    occurredAt,
    runId,
    source: "blackbox",
    state,
    type: "run.state_changed",
  };
}
