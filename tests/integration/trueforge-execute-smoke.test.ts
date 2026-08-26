import { TrueForge } from "@truefoundry/trueforge-sdk";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { executeTrueForgeSmoke } from "../../src/trueforge/execute-smoke.js";

const CREATED_AT = "2026-08-25T20:00:00.000Z";
const TURN_CREATED = {
  created_at: CREATED_AT,
  id: "event-created",
  previous_turn_id: null,
  state: { status: "running" },
  thread_id: null,
  turn_id: "turn-1",
  type: "turn.created",
};
const SANDBOX_CREATED = {
  created_at: CREATED_AT,
  id: "event-sandbox",
  sandbox_id: "v1:daytona:default.sandbox-1",
  thread_id: null,
  type: "sandbox.created",
};
const TOOL_CALL = {
  content: null,
  created_at: CREATED_AT,
  finish_reason: "tool_calls",
  id: "event-tool-call",
  thread_id: "main",
  tool_calls: [
    {
      function: { arguments: "{}", name: "exec" },
      id: "call-success",
      tool_info: { name: "exec", type: "truefoundry-system" },
      type: "function",
    },
  ],
  type: "model.message",
};
const TOOL_RESPONSE = {
  content: JSON.stringify({
    response: { exitCode: 0, result: "BLACKBOX_DAYTONA_OK\n" },
  }),
  created_at: CREATED_AT,
  id: "event-tool-response",
  thread_id: "main",
  tool_call_id: "call-success",
  type: "tool.response",
};
const TURN_DONE = {
  created_at: CREATED_AT,
  id: "event-done",
  state: {
    completed_at: CREATED_AT,
    output: null,
    required_actions: [],
    status: "done",
  },
  thread_id: null,
  type: "turn.done",
};
const EVENTS = [
  TURN_CREATED,
  SANDBOX_CREATED,
  TOOL_CALL,
  TOOL_RESPONSE,
  TURN_DONE,
];

describe("TrueForge sandbox smoke execution", () => {
  it("streams a turn and proves it against terminal persisted events", async () => {
    const app = new Hono();
    let turnRequest: unknown;

    app.post("/api/v1/sessions", async (context) => {
      const body = await context.req.json();
      expect(body).toEqual({ agent: { name: "blackbox-runtime-smoke" } });
      return context.json({
        data: {
          agent: {
            id: "agent-1",
            name: "blackbox-runtime-smoke",
            type: "reference",
          },
          created_at: CREATED_AT,
          created_by: "local",
          id: "session-1",
          title: null,
          updated_at: CREATED_AT,
        },
      });
    });
    app.post("/api/v1/sessions/:sessionId/turns", async (context) => {
      turnRequest = await context.req.json();
      const body = EVENTS.map(
        (event, index) => `id: ${index + 1}\ndata: ${JSON.stringify(event)}\n\n`,
      ).join("");
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    app.get(
      "/api/v1/sessions/:sessionId/turns/:turnId",
      (context) =>
        context.json({
          data: {
            created_at: CREATED_AT,
            id: "turn-1",
            previous_turn_id: null,
            session_id: "session-1",
            state: TURN_DONE.state,
          },
        }),
    );
    app.get(
      "/api/v1/sessions/:sessionId/turns/:turnId/events",
      (context) =>
        context.json({
          data: EVENTS,
          pagination: { limit: 100 },
        }),
    );

    const client = new TrueForge({
      baseUrl: "http://trueforge.test",
      fetch: async (input, init) => app.fetch(new Request(input, init)),
      maxRetries: 0,
    });

    await expect(
      executeTrueForgeSmoke(client, "blackbox-runtime-smoke"),
    ).resolves.toEqual({
      execution: {
        exitCode: 0,
        stdout: "BLACKBOX_DAYTONA_OK\n",
        toolCallId: "call-success",
      },
      reconciliation: {
        complete: true,
        liveEventIds: EVENTS.map((event) => event.id),
        persistedEventIds: EVENTS.map((event) => event.id),
      },
      sandbox: {
        event: "sandbox.created",
        id: "v1:daytona:default.sandbox-1",
      },
      turn: { sessionId: "session-1", status: "done", turnId: "turn-1" },
    });
    expect(turnRequest).toMatchObject({
      previous_turn_id: "none",
      stream: true,
    });
  });
});
