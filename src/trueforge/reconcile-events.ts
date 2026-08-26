import {
  isEventDelta,
  mergeEventDelta,
  type TrueForgeApi,
} from "@truefoundry/trueforge-sdk";
import { isDeepStrictEqual } from "node:util";

import type { RuntimeSmokeEvidence } from "./runtime.js";

type ReconciliationEvidence = RuntimeSmokeEvidence["reconciliation"];

export function reconcileTurnEvents(
  liveEvents: readonly TrueForgeApi.TurnStreamingEvent[],
  persistedEvents: readonly TrueForgeApi.SessionEvent[],
): ReconciliationEvidence {
  const mergedLiveEvents = mergeLiveDeltas(liveEvents);
  const liveEventIds = mergedLiveEvents.map((event) => event.id);
  const persistedEventIds = persistedEvents.map((event) => event.id);

  if (!sameStrings(liveEventIds, persistedEventIds)) {
    throw new Error("TrueForge live and persisted event IDs do not match");
  }

  const firstLive = mergedLiveEvents[0];
  const firstPersisted = persistedEvents[0];
  if (
    firstLive?.type !== "turn.created" ||
    firstPersisted?.type !== "turn.created" ||
    firstLive.turnId !== firstPersisted.turnId
  ) {
    throw new Error("TrueForge reconciliation is missing the same turn.created");
  }

  const lastLive = mergedLiveEvents.at(-1);
  const lastPersisted = persistedEvents.at(-1);
  if (
    lastLive?.type !== "turn.done" ||
    lastPersisted?.type !== "turn.done" ||
    lastLive.state.status !== lastPersisted.state.status
  ) {
    throw new Error("TrueForge reconciliation is missing the same turn.done");
  }

  const liveMessages = mergedLiveEvents.filter(
    (event): event is TrueForgeApi.ModelMessageEvent =>
      event.type === "model.message",
  );
  const persistedMessages = persistedEvents.filter(
    (event): event is TrueForgeApi.ModelMessageEvent =>
      event.type === "model.message",
  );
  const durableLiveMessages = liveMessages.map(durableModelMessage);
  const durablePersistedMessages = persistedMessages.map(durableModelMessage);
  if (!isDeepStrictEqual(durableLiveMessages, durablePersistedMessages)) {
    throw new Error(
      "TrueForge live model messages do not match persisted merged messages",
    );
  }

  return {
    complete: true,
    liveEventIds,
    persistedEventIds,
  };
}

function durableModelMessage({
  createdAt: _createdAt,
  reasoningContent: _reasoningContent,
  ...durable
}: TrueForgeApi.ModelMessageEvent): Omit<
  TrueForgeApi.ModelMessageEvent,
  "createdAt" | "reasoningContent"
> {
  return durable;
}

function mergeLiveDeltas(
  liveEvents: readonly TrueForgeApi.TurnStreamingEvent[],
): TrueForgeApi.SessionEvent[] {
  const merged: TrueForgeApi.SessionEvent[] = [];
  const eventsById = new Map<string, TrueForgeApi.SessionEvent>();

  for (const sourceEvent of liveEvents) {
    const event = structuredClone(sourceEvent);
    if (isEventDelta(event)) {
      const base = eventsById.get(event.id);
      if (base === undefined) {
        throw new Error(
          `TrueForge delta ${event.id} arrived without a base model.message`,
        );
      }
      mergeEventDelta(base, event);
      continue;
    }

    merged.push(event);
    eventsById.set(event.id, event);
  }

  return merged;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
