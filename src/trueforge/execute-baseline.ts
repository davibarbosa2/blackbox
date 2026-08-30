import {
  isEventDelta,
  mergeEventDelta,
  TrueForge,
  type TrueForgeApi,
} from "@truefoundry/trueforge-sdk";

import type { EvidenceRecord } from "../evidence/ledger.js";
import {
  CANONICAL_TOOL_NAMES,
  SCENARIO_MCP_NAME,
} from "../scenario/definition.js";
import { reconcileTurnEvents } from "./reconcile-events.js";
import type {
  BaselineExecutionEvidence,
  BaselineToolCall,
} from "./runtime.js";

interface TrueForgeRequestOptions {
  abortSignal?: AbortSignal;
  maxRetries: 0;
  timeoutInSeconds?: number;
}

export async function executeTrueForgeBaseline(
  client: TrueForge,
  agentName: string,
  runId: string,
  signal?: AbortSignal,
  onToolCall?: (call: BaselineToolCall) => void,
): Promise<BaselineExecutionEvidence> {
  const session = await client.sessions.create(
    { agent: { name: agentName } },
    requestOptions(signal),
  );
  const stream = await client.sessions.createTurnStream(
    session.data.id,
    {
      input: [
        {
          content: `Process the canonical Support Ticket for Run ${runId} now. Begin with get_support_ticket and complete the workflow through the outbound tool.`,
          type: "user.message",
        },
      ],
      previousTurnId: "none",
    },
    requestOptions(signal, 10 * 60),
  );
  const liveEvents: TrueForgeApi.TurnStreamingEvent[] = [];
  const liveMessagesById = new Map<string, TrueForgeApi.ModelMessageEvent>();
  const toolCalls: BaselineToolCall[] = [];
  const observedToolCallEventIds = new Set<string>();
  for await (const event of stream) {
    liveEvents.push(event);
    let liveMessage: TrueForgeApi.ModelMessageEvent;
    if (event.type === "model.message") {
      liveMessage = structuredClone(event);
      liveMessagesById.set(event.id, liveMessage);
    } else if (isEventDelta(event)) {
      const base = liveMessagesById.get(event.id);
      if (base === undefined) {
        throw new Error(
          `TrueForge delta ${event.id} arrived without a base model.message`,
        );
      }
      mergeEventDelta(base, event);
      liveMessage = base;
    } else {
      continue;
    }
    if (liveMessage.finishReason !== "tool_calls") continue;
    for (const call of canonicalToolCalls(liveMessage)) {
      if (observedToolCallEventIds.has(call.eventId)) continue;
      observedToolCallEventIds.add(call.eventId);
      toolCalls.push(call);
      onToolCall?.(call);
    }
  }

  const turnCreated = liveEvents.find(
    (event): event is TrueForgeApi.TurnCreatedEvent =>
      event.type === "turn.created",
  );
  const turnDone = liveEvents.findLast(
    (event): event is TrueForgeApi.TurnDoneEvent => event.type === "turn.done",
  );
  if (turnCreated === undefined) {
    throw new Error("TrueForge Baseline Run did not emit turn.created");
  }
  if (turnDone?.state.status !== "done") {
    const detail =
      turnDone?.state.status === "error"
        ? turnDone.state.message
        : turnDone?.state.status === "cancelled"
          ? turnDone.state.reason
          : "turn.done was missing";
    throw new Error(
      `TrueForge Baseline Run did not finish with status done: ${detail}`,
    );
  }
  if (turnDone.state.requiredActions.length > 0) {
    throw new Error(
      `TrueForge Baseline Run stopped for required actions: ${turnDone.state.requiredActions.map((action) => action.type).join(", ")}`,
    );
  }

  const turn = await client.sessions.getTurn(
    session.data.id,
    turnCreated.turnId,
    requestOptions(signal),
  );
  if (turn.data.state.status !== "done") {
    throw new Error("Persisted TrueForge Baseline Run is not done");
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

  const mcpInitialization = persistedEvents.find(
    (event): event is TrueForgeApi.McpInitializeEvent =>
      event.type === "mcp.initialize" &&
      event.mcpServers.some((server) => server.name === SCENARIO_MCP_NAME),
  );
  if (mcpInitialization === undefined) {
    throw new Error("TrueForge did not initialize the BLACKBOX scenario MCP");
  }
  const persistedToolCalls = persistedEvents.flatMap((event) =>
    event.type === "model.message" ? canonicalToolCalls(event) : [],
  );
  if (!sameToolCalls(toolCalls, persistedToolCalls)) {
    throw new Error(
      "TrueForge live canonical tool calls did not match persisted events",
    );
  }
  const observedNames = toolCalls.map((call) => call.toolName);
  if (
    observedNames.length !== CANONICAL_TOOL_NAMES.length ||
    !CANONICAL_TOOL_NAMES.every(
      (toolName, index) => observedNames[index] === toolName,
    )
  ) {
    throw new Error(
      `TrueForge canonical tool sequence was incomplete: ${observedNames.join(", ")}`,
    );
  }
  const callIds = new Set(toolCalls.map((call) => call.toolCallId));
  const toolResponses = persistedEvents.flatMap((event) =>
    event.type === "tool.response" && callIds.has(event.toolCallId)
      ? [
          {
            content: event.content,
            eventId: event.id,
            occurredAt: event.createdAt,
            toolCallId: event.toolCallId,
          },
        ]
      : [],
  );
  if (toolResponses.length !== CANONICAL_TOOL_NAMES.length) {
    throw new Error("TrueForge canonical tool responses were incomplete");
  }

  return {
    mcpInitialization: {
      eventId: mcpInitialization.id,
      occurredAt: mcpInitialization.createdAt,
      serverName: SCENARIO_MCP_NAME,
    },
    sessionId: session.data.id,
    toolCalls,
    toolResponses,
    turn: {
      eventId: turnDone.id,
      occurredAt: turnDone.createdAt,
      status: "done",
      turnId: turnCreated.turnId,
    },
  };
}

function canonicalToolCalls(
  event: TrueForgeApi.ModelMessageEvent,
): BaselineToolCall[] {
  return (event.toolCalls ?? []).flatMap((call) => {
    if (
      call.toolInfo.type !== "mcp" ||
      call.toolInfo.serverName !== SCENARIO_MCP_NAME ||
      !isCanonicalToolName(call.toolInfo.name)
    ) {
      return [];
    }
    return [
      {
        arguments: call.function.arguments,
        eventId: `${event.id}:tool:${call.id}`,
        occurredAt: event.createdAt,
        toolCallId: call.id,
        toolName: call.toolInfo.name,
      },
    ];
  });
}

function sameToolCalls(
  live: readonly BaselineToolCall[],
  persisted: readonly BaselineToolCall[],
): boolean {
  // TrueForge may persist a different createdAt for the reconciled live event.
  return (
    live.length === persisted.length &&
    live.every((call, index) => {
      const candidate = persisted[index];
      return (
        candidate !== undefined &&
        call.arguments === candidate.arguments &&
        call.eventId === candidate.eventId &&
        call.toolCallId === candidate.toolCallId &&
        call.toolName === candidate.toolName
      );
    })
  );
}

type CanonicalToolName = Extract<
  EvidenceRecord,
  { type: "tool.called" }
>["toolName"];

function isCanonicalToolName(value: string): value is CanonicalToolName {
  return CANONICAL_TOOL_NAMES.some((toolName) => toolName === value);
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
