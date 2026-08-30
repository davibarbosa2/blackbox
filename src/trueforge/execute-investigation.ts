import { createHash } from "node:crypto";

import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { z } from "zod";

import {
  INVESTIGATION_ANALYSIS_ARTIFACT_PATH,
  INVESTIGATOR_MCP_NAME,
} from "../investigation/definition.js";
import {
  evidenceProvenanceSubagentSchema,
  evidenceProvenanceSubagentOutputSchema,
  investigationAnalysisResultSchema,
  InvestigationExecutionError,
  investigationExecutionEvidenceSchema,
  investigationMilestoneSchema,
  investigationProposalSchema,
  type InvestigationExecutionEvidence,
  type InvestigationMilestone,
  policyPatchSubagentSchema,
  policyPatchSubagentOutputSchema,
} from "./runtime.js";
import { reconcileTurnEvents } from "./reconcile-events.js";
import { findSuccessfulSandboxExecution } from "./sandbox-execution.js";

const ANALYSIS_MARKER = "BLACKBOX_INVESTIGATION_ANALYSIS_OK";
const execArgumentsSchema = z.strictObject({
  command: z.string().min(1),
  intent: z.string().min(1),
});

interface TrueForgeRequestOptions {
  abortSignal?: AbortSignal;
  maxRetries: 0;
  timeoutInSeconds?: number;
}

export async function executeTrueForgeInvestigation(
  client: TrueForge,
  agentName: string,
  prompt: string,
  signal?: AbortSignal,
  onMilestone?: (milestone: InvestigationMilestone) => void,
): Promise<InvestigationExecutionEvidence> {
  const state = { pendingActionObserved: false };
  try {
    return await executeInvestigation(
      client,
      agentName,
      prompt,
      state,
      signal,
      onMilestone,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "TrueForge investigation failed";
    throw new InvestigationExecutionError(message, state.pendingActionObserved);
  }
}

async function executeInvestigation(
  client: TrueForge,
  agentName: string,
  prompt: string,
  state: { pendingActionObserved: boolean },
  signal?: AbortSignal,
  onMilestone?: (milestone: InvestigationMilestone) => void,
): Promise<InvestigationExecutionEvidence> {
  const session = await client.sessions.create(
    { agent: { name: agentName } },
    requestOptions(signal),
  );
  const timeoutSignal = AbortSignal.timeout(5 * 60_000);
  const turnSignal =
    signal === undefined
      ? timeoutSignal
      : AbortSignal.any([signal, timeoutSignal]);
  const stream = await client.sessions.createTurnStream(
    session.data.id,
    {
      input: [{ content: prompt, type: "user.message" }],
      previousTurnId: "none",
    },
    requestOptions(turnSignal, 5 * 60),
  );
  const liveEvents: TrueForgeApi.TurnStreamingEvent[] = [];
  const threadRoles = new Map<
    string,
    "EvidenceProvenanceVerifier" | "PolicyPatchReviewer"
  >();
  const policyCallReferences = new Set<string>();
  const analysisCallIds = new Set<string>();
  for await (const event of stream) {
    liveEvents.push(event);
    const milestone = milestoneFromEvent(
      event,
      session.data.id,
      threadRoles,
      policyCallReferences,
      analysisCallIds,
    );
    if (milestone !== undefined && onMilestone !== undefined) {
      try {
        onMilestone(milestone);
      } catch {
        // Mission Control progress is diagnostic and must not affect evidence.
      }
    }
  }

  const turnCreated = liveEvents.find(
    (event): event is TrueForgeApi.TurnCreatedEvent =>
      event.type === "turn.created",
  );
  const turnDone = liveEvents.findLast(
    (event): event is TrueForgeApi.TurnDoneEvent => event.type === "turn.done",
  );
  if (turnCreated === undefined || turnDone?.state.status !== "done") {
    throw new Error("TrueForge investigation did not reach a terminal done turn");
  }
  const liveAction = onlyApprovalAction(turnDone.state.requiredActions);
  state.pendingActionObserved = true;

  const turn = await client.sessions.getTurn(
    session.data.id,
    turnCreated.turnId,
    requestOptions(signal),
  );
  if (turn.data.state.status !== "done") {
    throw new Error("Persisted TrueForge investigation turn is not done");
  }
  const persistedAction = onlyApprovalAction(turn.data.state.requiredActions);
  if (persistedAction.id !== liveAction.id) {
    throw new Error("TrueForge pending action changed during persistence");
  }

  const page = await client.sessions.listTurnEvents(
    session.data.id,
    turnCreated.turnId,
    { limit: 100, order: "asc" },
    requestOptions(signal),
  );
  const persistedEvents: TrueForgeApi.SessionEvent[] = [];
  for await (const event of page) persistedEvents.push(event);
  reconcileTurnEvents(liveEvents, persistedEvents);

  if (
    !persistedEvents.some(
      (event) =>
        event.type === "mcp.initialize" &&
        event.mcpServers.some((server) => server.name === INVESTIGATOR_MCP_NAME),
    )
  ) {
    throw new Error("TrueForge did not initialize the investigator MCP");
  }
  const sandbox = persistedEvents.find(
    (event): event is TrueForgeApi.SandboxCreatedEvent =>
      event.type === "sandbox.created",
  );
  if (sandbox === undefined) {
    throw new Error("TrueForge investigation did not create a Daytona sandbox");
  }
  const execution = findSuccessfulSandboxExecution(
    persistedEvents,
    ANALYSIS_MARKER,
  );
  const analysisProof = readAnalysisArtifactProof(
    persistedEvents,
    execution.toolCallId,
    execution.stdout,
  );
  const subagents = readSubagentEvidence(persistedEvents);
  const toolCallRef = persistedAction.toolCalls[0];
  if (toolCallRef === undefined || persistedAction.toolCalls.length !== 1) {
    throw new Error("TrueForge approval did not contain one tool call");
  }
  const source = persistedEvents.find(
    (event): event is TrueForgeApi.ModelMessageEvent =>
      event.type === "model.message" && event.id === toolCallRef.sourceEventId,
  );
  const applyCall = source?.toolCalls?.find(
    (call) => call.id === toolCallRef.id,
  );
  if (
    applyCall?.function.name !== "apply_policy_patch" ||
    applyCall.toolInfo.type !== "mcp" ||
    applyCall.toolInfo.serverName !== INVESTIGATOR_MCP_NAME
  ) {
    throw new Error("TrueForge did not pause the literal apply_policy_patch call");
  }
  const proposal = investigationProposalSchema.parse(
    JSON.parse(applyCall.function.arguments),
  );

  return investigationExecutionEvidenceSchema.parse({
    analysis: {
      ...analysisProof,
      execution,
      sandbox: { event: "sandbox.created", id: sandbox.sandboxId },
    },
    diagnosis: {
      canonicalCause: proposal.canonicalCause,
      summary: proposal.evidenceJustification.summary,
    },
    pendingAction: {
      actionId: persistedAction.id,
      callId: applyCall.id,
      proposal,
      sessionId: session.data.id,
      threadId: persistedAction.threadId,
      toolName: "apply_policy_patch",
      turnId: turnCreated.turnId,
    },
    subagents,
  });
}

function milestoneFromEvent(
  event: TrueForgeApi.TurnStreamingEvent,
  sessionId: string,
  threadRoles: Map<
    string,
    "EvidenceProvenanceVerifier" | "PolicyPatchReviewer"
  >,
  policyCallReferences: Set<string>,
  analysisCallIds: Set<string>,
): InvestigationMilestone | undefined {
  if (event.type === "model.message") {
    const policyCall = event.toolCalls?.find(
      (call) =>
        call.function.name === "apply_policy_patch" &&
        call.toolInfo.type === "mcp" &&
        call.toolInfo.serverName === INVESTIGATOR_MCP_NAME,
    );
    if (policyCall !== undefined) {
      policyCallReferences.add(`${event.id}:${policyCall.id}`);
      return investigationMilestoneSchema.parse({
        kind: "POLICY_PATCH_DRAFTED",
        occurredAt: event.createdAt,
        sessionId,
        sourceEventId: event.id,
      });
    }
    const analysisCall = event.toolCalls?.find(
      (call) =>
        call.function.name === "exec" &&
        call.toolInfo.type === "truefoundry-system",
    );
    if (analysisCall !== undefined) {
      analysisCallIds.add(analysisCall.id);
      return investigationMilestoneSchema.parse({
        kind: "ANALYSIS_EXECUTION_STARTED",
        occurredAt: event.createdAt,
        sessionId,
        sourceEventId: event.id,
      });
    }
    return undefined;
  }

  let kind: InvestigationMilestone["kind"] | undefined;
  if (event.type === "turn.created") {
    kind = "TURN_STARTED";
  } else if (
    event.type === "mcp.initialize" &&
    event.mcpServers.some((server) => server.name === INVESTIGATOR_MCP_NAME)
  ) {
    kind = "INVESTIGATOR_MCP_INITIALIZED";
  } else if (event.type === "thread.created") {
    if (
      event.agentInfo.name === "EvidenceProvenanceVerifier" ||
      event.agentInfo.name === "PolicyPatchReviewer"
    ) {
      threadRoles.set(event.threadId, event.agentInfo.name);
      kind =
        event.agentInfo.name === "PolicyPatchReviewer"
          ? "POLICY_REVIEW_STARTED"
          : "EVIDENCE_REVIEW_STARTED";
    }
  } else if (event.type === "thread.done" && event.state.status === "done") {
    const role = threadRoles.get(event.threadId);
    kind =
      role === "PolicyPatchReviewer"
        ? "POLICY_REVIEW_COMPLETED"
        : role === "EvidenceProvenanceVerifier"
          ? "EVIDENCE_REVIEW_COMPLETED"
          : undefined;
  } else if (
    event.type === "sandbox.created" &&
    (event.threadId === null || event.threadId === "main")
  ) {
    kind = "ANALYSIS_SANDBOX_CREATED";
  } else if (
    event.type === "tool.response" &&
    analysisCallIds.has(event.toolCallId)
  ) {
    kind = "ANALYSIS_EXECUTION_COMPLETED";
  } else if (
    event.type === "tool.approval_required" &&
    event.toolCalls.length === 1 &&
    policyCallReferences.has(
      `${event.toolCalls[0]?.sourceEventId ?? ""}:${event.toolCalls[0]?.id ?? ""}`,
    )
  ) {
    kind = "POLICY_ACTION_OBSERVED";
  }
  if (kind === undefined) return undefined;
  return investigationMilestoneSchema.parse({
    kind,
    occurredAt: event.createdAt,
    sessionId,
    sourceEventId: event.id,
  });
}

function onlyApprovalAction(
  actions: TrueForgeApi.ActionRequiredEvent[],
): TrueForgeApi.ToolApprovalRequiredEvent {
  const action = actions[0];
  if (actions.length !== 1 || action?.type !== "tool.approval_required") {
    throw new Error(
      "TrueForge investigation must stop at one tool approval required action",
    );
  }
  return action;
}

function readSubagentEvidence(
  events: readonly TrueForgeApi.SessionEvent[],
): InvestigationExecutionEvidence["subagents"] {
  const created = events.filter(
    (event): event is TrueForgeApi.ThreadCreatedEvent =>
      event.type === "thread.created",
  );
  if (created.length !== 2) {
    throw new Error("TrueForge investigation did not create exactly two subagents");
  }
  const evidenceThread = created.find(
    (thread) => thread.agentInfo.name === "EvidenceProvenanceVerifier",
  );
  const policyThread = created.find(
    (thread) => thread.agentInfo.name === "PolicyPatchReviewer",
  );
  if (evidenceThread === undefined || policyThread === undefined) {
    throw new Error("TrueForge investigation did not use both focused subagent roles");
  }

  const readCompletedSubagent = (thread: TrueForgeApi.ThreadCreatedEvent) => {
    const done = events.find(
      (event): event is TrueForgeApi.ThreadDoneEvent =>
        event.type === "thread.done" && event.threadId === thread.threadId,
    );
    if (done?.state.status !== "done") {
      throw new Error(`TrueForge subagent ${thread.threadId} did not finish`);
    }
    const output = z.string().min(1).parse(done.state.output.content);
    return {
      base: {
        createdEventId: thread.id,
        doneEventId: done.id,
        inputHash: sha256(thread.agentInfo.input),
        outputHash: sha256(output),
        status: "done" as const,
        threadId: thread.threadId,
        title: thread.title,
      },
      input: thread.agentInfo.input,
      output,
    };
  };

  const policy = readCompletedSubagent(policyThread);
  const policyEvidence = policyPatchSubagentSchema.parse({
    ...policy.base,
    output: parseJson(policy.output, policyPatchSubagentOutputSchema),
    role: "PolicyPatchReviewer",
  });
  requireInputFacts(policy.input, [
    policyEvidence.output.policyHash,
    String(policyEvidence.output.policyVersion),
    policyEvidence.output.trustedDestination,
  ]);

  const evidence = readCompletedSubagent(evidenceThread);
  const provenanceEvidence = evidenceProvenanceSubagentSchema.parse({
    ...evidence.base,
    output: parseJson(
      evidence.output,
      evidenceProvenanceSubagentOutputSchema,
    ),
    role: "EvidenceProvenanceVerifier",
  });
  requireInputFacts(evidence.input, [
    provenanceEvidence.output.bundleHash,
    provenanceEvidence.output.runId,
  ]);

  return [policyEvidence, provenanceEvidence];
}

function readAnalysisArtifactProof(
  events: readonly TrueForgeApi.SessionEvent[],
  toolCallId: string,
  stdout: string,
): Pick<InvestigationExecutionEvidence["analysis"], "artifact" | "result"> {
  const call = events
    .filter(
      (event): event is TrueForgeApi.ModelMessageEvent =>
        event.type === "model.message",
    )
    .flatMap((event) => event.toolCalls ?? [])
    .find((toolCall) => toolCall.id === toolCallId);
  const parsedArguments = parseJson(
    call?.function.arguments,
    execArgumentsSchema,
  );
  if (parsedArguments === undefined) {
    throw new Error("TrueForge analysis artifact command is missing intent or command");
  }
  const { command } = parsedArguments;
  const pathOccurrences = command.split(INVESTIGATION_ANALYSIS_ARTIFACT_PATH).length - 1;
  if (
    pathOccurrences < 2 ||
    !command.includes(ANALYSIS_MARKER) ||
    !command.includes("missing_destination_allowlist_in_send_external_message") ||
    !new RegExp(
      `\\bpython(?:3)?\\s+${escapeRegularExpression(INVESTIGATION_ANALYSIS_ARTIFACT_PATH)}`,
    ).test(command)
  ) {
    throw new Error(
      "TrueForge analysis artifact command did not create and execute the required Python artifact",
    );
  }

  const lines = stdout.split(/\r?\n/);
  const markerIndex = lines.indexOf(ANALYSIS_MARKER);
  const resultLine = lines.slice(markerIndex + 1).find((line) => line.trim() !== "");
  const result = parseJson(resultLine, investigationAnalysisResultSchema);
  if (markerIndex < 0 || result === undefined) {
    throw new Error("TrueForge analysis artifact did not return structured findings");
  }
  return {
    artifact: {
      commandHash: sha256(command),
      path: INVESTIGATION_ANALYSIS_ARTIFACT_PATH,
    },
    result,
  };
}

function requireInputFacts(input: string, facts: readonly string[]): void {
  if (!facts.every((fact) => input.includes(fact))) {
    throw new Error("TrueForge focused subagent input omitted required facts");
  }
}

function parseJson<T>(
  value: string | undefined,
  schema: z.ZodType<T>,
): T | undefined {
  if (value === undefined) return undefined;
  try {
    const trimmed = value.trim();
    const fenced = /^```json\s*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
    const result = schema.safeParse(JSON.parse(fenced?.[1] ?? trimmed));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requestOptions(
  signal?: AbortSignal,
  timeoutInSeconds?: number,
): TrueForgeRequestOptions {
  const options: TrueForgeRequestOptions = { maxRetries: 0 };
  if (signal !== undefined) options.abortSignal = signal;
  if (timeoutInSeconds !== undefined) {
    options.timeoutInSeconds = timeoutInSeconds;
  }
  return options;
}
