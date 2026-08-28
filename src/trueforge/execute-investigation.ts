import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";

import { INVESTIGATOR_MCP_NAME } from "../investigation/definition.js";
import {
  investigationExecutionEvidenceSchema,
  investigationProposalSchema,
  type InvestigationExecutionEvidence,
} from "./runtime.js";
import { reconcileTurnEvents } from "./reconcile-events.js";
import { findSuccessfulSandboxExecution } from "./sandbox-execution.js";

const ANALYSIS_MARKER = "BLACKBOX_INVESTIGATION_ANALYSIS_OK";

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
  for await (const event of stream) liveEvents.push(event);

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
      toolName: "apply_policy_patch",
      turnId: turnCreated.turnId,
    },
    subagents,
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
  const readCompletedSubagentEvidence = (
    thread: TrueForgeApi.ThreadCreatedEvent | undefined,
  ) => {
    if (thread === undefined) {
      throw new Error("TrueForge subagent creation evidence is missing");
    }
    const done = events.find(
      (event): event is TrueForgeApi.ThreadDoneEvent =>
        event.type === "thread.done" && event.threadId === thread.threadId,
    );
    if (done?.state.status !== "done") {
      throw new Error(`TrueForge subagent ${thread.threadId} did not finish`);
    }
    return {
      createdEventId: thread.id,
      doneEventId: done.id,
      status: "done" as const,
      threadId: thread.threadId,
      title: thread.title,
    };
  };
  return [
    readCompletedSubagentEvidence(created[0]),
    readCompletedSubagentEvidence(created[1]),
  ];
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
