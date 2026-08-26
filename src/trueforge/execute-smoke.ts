import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";

import { reconcileTurnEvents } from "./reconcile-events.js";
import {
  findSuccessfulSandboxExecution,
  type SandboxExecutionEvidence,
} from "./sandbox-execution.js";
import type { RuntimeSmokeEvidence } from "./runtime.js";

const EXPECTED_STDOUT_MARKER = "BLACKBOX_DAYTONA_OK";

export interface TrueForgeExecutionEvidence {
  execution: SandboxExecutionEvidence;
  reconciliation: RuntimeSmokeEvidence["reconciliation"];
  sandbox: RuntimeSmokeEvidence["sandbox"];
  turn: RuntimeSmokeEvidence["turn"];
}

export async function executeTrueForgeSmoke(
  client: TrueForge,
  agentName: string,
  signal?: AbortSignal,
): Promise<TrueForgeExecutionEvidence> {
  const session = await client.sessions.create(
    { agent: { name: agentName } },
    { ...(signal ? { abortSignal: signal } : {}), maxRetries: 0 },
  );
  const stream = await client.sessions.createTurnStream(
    session.data.id,
    {
      input: [
        {
          content:
            "Create the requested Python smoke file and execute it now. Return only after observing the sandbox tool response.",
          type: "user.message",
        },
      ],
      previousTurnId: "none",
    },
    {
      ...(signal ? { abortSignal: signal } : {}),
      maxRetries: 0,
      timeoutInSeconds: 10 * 60,
    },
  );

  const liveEvents: TrueForgeApi.TurnStreamingEvent[] = [];
  for await (const event of stream) {
    liveEvents.push(event);
  }

  const turnCreated = liveEvents.find(
    (event): event is TrueForgeApi.TurnCreatedEvent =>
      event.type === "turn.created",
  );
  const turnDone = liveEvents.findLast(
    (event): event is TrueForgeApi.TurnDoneEvent => event.type === "turn.done",
  );
  const sandboxCreated = liveEvents.find(
    (event): event is TrueForgeApi.SandboxCreatedEvent =>
      event.type === "sandbox.created",
  );
  if (turnCreated === undefined) {
    throw new Error("TrueForge stream did not emit turn.created");
  }
  if (turnDone?.state.status !== "done") {
    throw new Error(
      `TrueForge stream did not finish with turn.done.status=done`,
    );
  }
  if (turnDone.state.requiredActions.length > 0) {
    throw new Error("TrueForge smoke finished with unresolved required actions");
  }
  if (sandboxCreated === undefined) {
    throw new Error("TrueForge stream did not emit sandbox.created");
  }

  const turn = await client.sessions.getTurn(
    session.data.id,
    turnCreated.turnId,
    { ...(signal ? { abortSignal: signal } : {}), maxRetries: 0 },
  );
  if (turn.data.state.status !== "done") {
    throw new Error(
      `Persisted TrueForge turn is ${turn.data.state.status}, expected done`,
    );
  }

  const page = await client.sessions.listTurnEvents(
    session.data.id,
    turnCreated.turnId,
    { limit: 100, order: "asc" },
    { ...(signal ? { abortSignal: signal } : {}), maxRetries: 0 },
  );
  const persistedEvents: TrueForgeApi.SessionEvent[] = [];
  for await (const event of page) {
    persistedEvents.push(event);
  }

  const reconciliation = reconcileTurnEvents(liveEvents, persistedEvents);
  const execution = findSuccessfulSandboxExecution(
    persistedEvents,
    EXPECTED_STDOUT_MARKER,
  );

  return {
    execution,
    reconciliation,
    sandbox: {
      event: "sandbox.created",
      id: sandboxCreated.sandboxId,
    },
    turn: {
      sessionId: session.data.id,
      status: "done",
      turnId: turnCreated.turnId,
    },
  };
}
