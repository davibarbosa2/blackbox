import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { describe, expect, it } from "vitest";

import { reconcileTurnEvents } from "../../src/trueforge/reconcile-events.js";

describe("TrueForge turn event reconciliation", () => {
  it("matches a live delta stream to persisted merged events", () => {
    const turnCreated: TrueForgeApi.TurnCreatedEvent = {
      createdAt: "2026-08-25T20:00:00.000Z",
      id: "event-created",
      previousTurnId: null,
      state: { status: "running" },
      threadId: null,
      turnId: "turn-1",
      type: "turn.created",
    };
    const liveMessage: TrueForgeApi.ModelMessageEvent = {
      content: "",
      createdAt: "2026-08-25T20:00:01.000Z",
      finishReason: null,
      id: "event-message",
      threadId: "main",
      type: "model.message",
    };
    const messageDelta: TrueForgeApi.ModelMessageDeltaEvent = {
      content: "sandbox ready",
      finishReason: "stop",
      id: "event-message",
      threadId: "main",
      type: "model.message.delta",
    };
    const turnDone: TrueForgeApi.TurnDoneEvent = {
      createdAt: "2026-08-25T20:00:02.000Z",
      id: "event-done",
      state: {
        completedAt: "2026-08-25T20:00:02.000Z",
        output: null,
        requiredActions: [],
        status: "done",
      },
      threadId: null,
      type: "turn.done",
    };
    const persistedMessage: TrueForgeApi.ModelMessageEvent = {
      ...liveMessage,
      content: "sandbox ready",
      finishReason: "stop",
    };

    expect(
      reconcileTurnEvents(
        [turnCreated, liveMessage, messageDelta, turnDone],
        [turnCreated, persistedMessage, turnDone],
      ),
    ).toEqual({
      complete: true,
      liveEventIds: ["event-created", "event-message", "event-done"],
      persistedEventIds: ["event-created", "event-message", "event-done"],
    });
  });

  it("compares durable message evidence instead of stream-only metadata", () => {
    const turnCreated: TrueForgeApi.TurnCreatedEvent = {
      createdAt: "2026-08-25T20:00:00.000Z",
      id: "event-created",
      previousTurnId: null,
      state: { status: "running" },
      threadId: null,
      turnId: "turn-1",
      type: "turn.created",
    };
    const liveMessage: TrueForgeApi.ModelMessageEvent = {
      content: "",
      createdAt: "2026-08-25T20:00:01.000Z",
      finishReason: null,
      id: "event-message",
      threadId: "main",
      type: "model.message",
    };
    const messageDelta: TrueForgeApi.ModelMessageDeltaEvent = {
      content: "sandbox ready",
      finishReason: "stop",
      id: "event-message",
      reasoningContent: "stream-only reasoning",
      threadId: "main",
      type: "model.message.delta",
    };
    const persistedMessage: TrueForgeApi.ModelMessageEvent = {
      ...liveMessage,
      content: "sandbox ready",
      createdAt: "2026-08-25T20:00:02.000Z",
      finishReason: "stop",
    };
    const turnDone: TrueForgeApi.TurnDoneEvent = {
      createdAt: "2026-08-25T20:00:03.000Z",
      id: "event-done",
      state: {
        completedAt: "2026-08-25T20:00:03.000Z",
        output: null,
        requiredActions: [],
        status: "done",
      },
      threadId: null,
      type: "turn.done",
    };

    expect(
      reconcileTurnEvents(
        [turnCreated, liveMessage, messageDelta, turnDone],
        [turnCreated, persistedMessage, turnDone],
      ),
    ).toEqual({
      complete: true,
      liveEventIds: ["event-created", "event-message", "event-done"],
      persistedEventIds: ["event-created", "event-message", "event-done"],
    });
  });
});
