import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";

import {
  type PendingPolicyDecision,
  type PolicyActionResolution,
  policyActionResolutionSchema,
} from "./runtime.js";

interface TrueForgeRequestOptions {
  abortSignal?: AbortSignal;
  maxRetries: 0;
  timeoutInSeconds?: number;
}

export async function executeTrueForgePolicyAction(
  client: TrueForge,
  pendingDecision: PendingPolicyDecision,
  decision: "allow" | "deny",
  signal?: AbortSignal,
): Promise<PolicyActionResolution> {
  const pendingTurn = await client.sessions.getTurn(
    pendingDecision.sessionId,
    pendingDecision.turnId,
    requestOptions(signal),
  );
  const pendingState = pendingTurn.data.state;
  if (pendingState.status !== "done") {
    throw new Error("TrueForge pending action changed before resolution");
  }
  const action = pendingState.requiredActions[0];
  if (
    pendingState.requiredActions.length !== 1 ||
    action?.type !== "tool.approval_required" ||
    action.id !== pendingDecision.actionId ||
    action.threadId !== pendingDecision.threadId
  ) {
    throw new Error("TrueForge pending action changed before resolution");
  }
  if (
    action.toolCalls.length !== 1 ||
    action.toolCalls[0]?.id !== pendingDecision.callId
  ) {
    throw new Error("TrueForge pending action changed before resolution");
  }

  const stream = await client.sessions.createTurnStream(
    pendingDecision.sessionId,
    {
      input: [
        {
          approval:
            decision === "allow"
              ? { status: "allow" }
              : { status: "deny" },
          threadId: pendingDecision.threadId,
          toolCallId: pendingDecision.callId,
          type: "user.tool_approval",
        },
      ],
      previousTurnId: pendingDecision.turnId,
    },
    requestOptions(signal, 5 * 60),
  );
  const events: TrueForgeApi.TurnStreamingEvent[] = [];
  for await (const event of stream) events.push(event);
  const created = events.find(
    (event): event is TrueForgeApi.TurnCreatedEvent =>
      event.type === "turn.created",
  );
  const done = events.findLast(
    (event): event is TrueForgeApi.TurnDoneEvent => event.type === "turn.done",
  );
  if (
    created === undefined ||
    done?.state.status !== "done" ||
    done.state.requiredActions.length !== 0
  ) {
    throw new Error("TrueForge policy-action resolution did not finish");
  }
  if (
    decision === "allow" &&
    !events.some(
      (event) =>
        event.type === "tool.response" &&
        event.toolCallId === pendingDecision.callId &&
        event.threadId === pendingDecision.threadId,
    )
  ) {
    throw new Error("TrueForge approved Policy Patch produced no tool response");
  }

  return policyActionResolutionSchema.parse({
    decision,
    pendingDecision,
    resumedTurnId: created.turnId,
    status: "done",
  });
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
