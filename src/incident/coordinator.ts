import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  EvidenceBundle,
  EvidenceLedger,
  EvidenceRecord,
} from "../evidence/ledger.js";
import { classifyTrueForgeFailure } from "../failure.js";
import type { CapabilityPolicy } from "../policy/capability-policy.js";
import {
  type DurableIncidentRead,
  SqliteRemediationStore,
} from "../remediation/store.js";
import type {
  BaselineRunObservation,
  BaselineRunObservationContext,
} from "../observability/evlog.js";
import { createBaselineRunManifest } from "../scenario/definition.js";
import {
  InvestigationExecutionError,
  investigationExecutionEvidenceSchema,
} from "../trueforge/runtime.js";
import type {
  BaselineExecutionEvidence,
  TrueForgeRuntime,
} from "../trueforge/runtime.js";

export type StartIncidentResult =
  | { incidentId: string; runId: string; started: true }
  | { activeRunId: string; started: false };

export type BaselineRunRead =
  | { status: "running" }
  | { bundle: EvidenceBundle; status: "completed" };

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

  constructor(options: IncidentCoordinatorOptions) {
    this.#runtime = options.runtime;
    this.#ledger = options.ledger;
    this.#policy = options.policy;
    this.#modelAlias = options.model.alias;
    this.#modelId = options.model.id;
    this.#baseUrl = options.baseUrl;
    this.#remediations = options.remediations;
    this.#trustedDestination = options.trustedDestination;
    this.#observeBaselineRun = options.observeBaselineRun;
  }

  start(): StartIncidentResult {
    if (this.#active !== undefined) {
      return { activeRunId: this.#active.runId, started: false };
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

  read(runId: string): BaselineRunRead | undefined {
    const bundle = this.#ledger.readBundle(runId);
    if (bundle !== undefined) return { bundle, status: "completed" };
    if (this.#active?.runId === runId) return { status: "running" };
    return undefined;
  }

  readIncident(incidentId: string): DurableIncidentRead | undefined {
    return this.#remediations.read(incidentId);
  }

  isMcpAuthorized(authorization: string | undefined): boolean {
    const capability = this.#active?.mcpAuthorization;
    if (capability === undefined || authorization === undefined) return false;
    const expected = Buffer.from(`Bearer ${capability}`);
    const received = Buffer.from(authorization);
    return (
      expected.length === received.length && timingSafeEqual(expected, received)
    );
  }

  async shutdown(): Promise<void> {
    const active = this.#active;
    if (active === undefined) return;
    active.controller.abort(new Error("BLACKBOX is shutting down"));
    await active.completion;
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

  async #investigate(
    bundle: EvidenceBundle,
    mcpAuthorization: string,
    signal: AbortSignal,
  ): Promise<void> {
    const incidentId = bundle.manifest.incidentId;
    this.#remediations.start(
      incidentId,
      bundle.manifest.runId,
      bundle.bundleHash,
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

function validateInvestigationEvidence(
  evidence: ReturnType<typeof investigationExecutionEvidenceSchema.parse>,
  bundle: EvidenceBundle,
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
