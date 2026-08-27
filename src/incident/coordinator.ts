import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  EvidenceBundle,
  EvidenceLedger,
  EvidenceRecord,
} from "../evidence/ledger.js";
import type { CapabilityPolicy } from "../policy/capability-policy.js";
import type {
  BaselineRunObservation,
  BaselineRunObservationContext,
} from "../observability/evlog.js";
import { createBaselineRunManifest } from "../scenario/definition.js";
import type { TrueForgeRuntime } from "../trueforge/runtime.js";

export type StartIncidentResult =
  | { incidentId: string; runId: string; started: true }
  | { activeRunId: string; started: false };

export type BaselineRunRead =
  | { status: "running" }
  | { bundle: EvidenceBundle; status: "completed" };

export class IncidentCoordinator {
  readonly #ledger: EvidenceLedger;
  readonly #baseUrl: string;
  readonly #modelAlias: string;
  readonly #modelId: string;
  readonly #policy: CapabilityPolicy;
  readonly #runtime: TrueForgeRuntime;
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

  constructor(
    runtime: TrueForgeRuntime,
    ledger: EvidenceLedger,
    policy: CapabilityPolicy,
    modelAlias: string,
    modelId: string,
    baseUrl: string,
    observeBaselineRun?: (
      context: BaselineRunObservationContext,
    ) => BaselineRunObservation,
  ) {
    this.#runtime = runtime;
    this.#ledger = ledger;
    this.#policy = policy;
    this.#modelAlias = modelAlias;
    this.#modelId = modelId;
    this.#baseUrl = baseUrl;
    this.#observeBaselineRun = observeBaselineRun;
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
    let latestObservedAt = new Date().toISOString();
    try {
      const evidence = await this.#runtime.executeBaseline({
        mcpAuthorization,
        runId,
        signal,
      });
      const records: EvidenceRecord[] = [
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
      this.#ledger.append(records);
      latestObservedAt = records.reduce(
        (latest, record) =>
          record.occurredAt > latest ? record.occurredAt : latest,
        latestObservedAt,
      );
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("TrueForge Run failed");
      safelyObserve(() => observation?.failed(failure, "trueforge"));
      const failedAt = new Date().toISOString();
      this.#ledger.append([
        {
          id: `${runId}:failed`,
          message:
            error instanceof Error ? error.message : "TrueForge Run failed",
          occurredAt: failedAt,
          runId,
          source: "blackbox",
          stage: "trueforge",
          type: "run.failed",
        },
      ]);
      latestObservedAt = failedAt;
    }
    this.#ledger.append([
      stateRecord(runId, "VERIFYING", nextInstant(latestObservedAt)),
    ]);
    const bundle = this.#ledger.finalizeBaseline(runId);
    safelyObserve(() => observation?.completed(bundle));
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
