import { TrueForge } from "@truefoundry/trueforge-sdk";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { executeTrueForgePolicyAction } from "../../src/trueforge/resolve-policy-action.js";

const CREATED_AT = "2026-08-28T12:00:00.000Z";
const PENDING_DECISION = {
  actionId: "action-apply-1",
  callId: "call-apply-1",
  sessionId: "session-investigation-1",
  threadId: "main",
  toolName: "apply_policy_patch" as const,
  turnId: "turn-investigation-1",
};

describe("TrueForge pending Policy Patch resolution", () => {
  it("resumes the exact persisted action with the matching approval event", async () => {
    const requests: unknown[] = [];
    const client = createClient(PENDING_DECISION.callId, requests);

    const resolution = await executeTrueForgePolicyAction(
      client,
      PENDING_DECISION,
      "allow",
    );

    expect(requests).toEqual([
      {
        input: [
          {
            approval: { status: "allow" },
            thread_id: "main",
            tool_call_id: "call-apply-1",
            type: "user.tool_approval",
          },
        ],
        previous_turn_id: "turn-investigation-1",
        stream: true,
      },
    ]);
    expect(resolution).toEqual({
      decision: "allow",
      pendingDecision: PENDING_DECISION,
      resumedTurnId: "turn-remediation-1",
      status: "done",
    });
  });

  it("refuses to resume when TrueForge no longer exposes the persisted call", async () => {
    const requests: unknown[] = [];
    const client = createClient("different-call", requests);

    await expect(
      executeTrueForgePolicyAction(client, PENDING_DECISION, "deny"),
    ).rejects.toThrow("pending action changed");
    expect(requests).toEqual([]);
  });
});

function createClient(callId: string, requests: unknown[]): TrueForge {
  const app = new Hono();
  app.get("/api/v1/sessions/:sessionId/turns/:turnId", (context) =>
    context.json({
      data: {
        created_at: CREATED_AT,
        id: PENDING_DECISION.turnId,
        previous_turn_id: null,
        session_id: PENDING_DECISION.sessionId,
        state: {
          completed_at: CREATED_AT,
          output: null,
          required_actions: [
            {
              created_at: CREATED_AT,
              id: PENDING_DECISION.actionId,
              thread_id: PENDING_DECISION.threadId,
              tool_calls: [
                { id: callId, source_event_id: "event-apply-call" },
              ],
              type: "tool.approval_required",
            },
          ],
          status: "done",
        },
      },
    }),
  );
  app.post("/api/v1/sessions/:sessionId/turns", async (context) => {
    requests.push(await context.req.json());
    const events = [
      {
        created_at: CREATED_AT,
        id: "event-turn-created",
        previous_turn_id: PENDING_DECISION.turnId,
        state: { status: "running" },
        thread_id: null,
        turn_id: "turn-remediation-1",
        type: "turn.created",
      },
      {
        content: JSON.stringify({ status: "APPLIED" }),
        created_at: CREATED_AT,
        id: "event-tool-response",
        thread_id: PENDING_DECISION.threadId,
        tool_call_id: PENDING_DECISION.callId,
        type: "tool.response",
      },
      {
        created_at: CREATED_AT,
        id: "event-turn-done",
        state: {
          completed_at: CREATED_AT,
          output: null,
          required_actions: [],
          status: "done",
        },
        thread_id: null,
        type: "turn.done",
      },
    ];
    return new Response(
      events
        .map(
          (event, index) =>
            `id: ${index + 1}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  return new TrueForge({
    baseUrl: "http://trueforge.test",
    fetch: async (input, init) => app.fetch(new Request(input, init)),
    maxRetries: 0,
  });
}
