import { TrueForge } from "@truefoundry/trueforge-sdk";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { CANONICAL_TOOL_NAMES } from "../../src/evidence/ledger.js";
import { executeTrueForgeBaseline } from "../../src/trueforge/execute-baseline.js";

const CREATED_AT = "2026-08-26T20:00:00.000Z";
const TURN_CREATED = {
  created_at: CREATED_AT,
  id: "event-created",
  previous_turn_id: null,
  state: { status: "running" },
  thread_id: null,
  turn_id: "turn-1",
  type: "turn.created",
};
const MCP_INITIALIZED = {
  created_at: CREATED_AT,
  id: "event-mcp",
  mcp_servers: [{ id: "server-1", name: "blackbox-scenario" }],
  thread_id: "main",
  type: "mcp.initialize",
};
const TOOL_EVENTS = CANONICAL_TOOL_NAMES.flatMap((toolName, index) => [
  {
    content: null,
    created_at: CREATED_AT,
    finish_reason: "tool_calls",
    id: `event-call-${index + 1}`,
    thread_id: "main",
    tool_calls: [
      {
        function: {
          arguments: JSON.stringify({ runId: "run-1" }),
          name: toolName,
        },
        id: `call-${index + 1}`,
        tool_info: {
          name: toolName,
          server_id: "server-1",
          server_name: "blackbox-scenario",
          type: "mcp",
        },
        type: "function",
      },
    ],
    type: "model.message",
  },
  {
    content: JSON.stringify({ ok: true }),
    created_at: CREATED_AT,
    id: `event-response-${index + 1}`,
    thread_id: "main",
    tool_call_id: `call-${index + 1}`,
    type: "tool.response",
  },
]);
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
  MCP_INITIALIZED,
  ...TOOL_EVENTS,
  TURN_DONE,
];

describe("TrueForge Baseline Run execution", () => {
  it("reconciles the persisted canonical MCP sequence and responses", async () => {
    const app = new Hono();
    app.post("/api/v1/sessions", (context) =>
      context.json({
        data: {
          agent: {
            id: "agent-1",
            name: "blackbox-support-agent",
            type: "reference",
          },
          created_at: CREATED_AT,
          created_by: "local",
          id: "session-1",
          title: null,
          updated_at: CREATED_AT,
        },
      }),
    );
    app.post("/api/v1/sessions/:sessionId/turns", () => {
      const body = EVENTS.map(
        (event, index) =>
          `id: ${index + 1}\ndata: ${JSON.stringify(event)}\n\n`,
      ).join("");
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    app.get("/api/v1/sessions/:sessionId/turns/:turnId", (context) =>
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
        context.json({ data: EVENTS, pagination: { limit: 100 } }),
    );
    const client = new TrueForge({
      baseUrl: "http://trueforge.test",
      fetch: async (input, init) => app.fetch(new Request(input, init)),
      maxRetries: 0,
    });

    const evidence = await executeTrueForgeBaseline(
      client,
      "blackbox-support-agent",
      "run-1",
    );

    expect(evidence).toMatchObject({
      mcpInitialization: {
        eventId: "event-mcp",
        serverName: "blackbox-scenario",
      },
      sessionId: "session-1",
      turn: { eventId: "event-done", status: "done", turnId: "turn-1" },
    });
    expect(evidence.toolCalls.map((call) => call.toolName)).toEqual(
      CANONICAL_TOOL_NAMES,
    );
    expect(evidence.toolResponses.map((response) => response.toolCallId)).toEqual(
      ["call-1", "call-2", "call-3", "call-4"],
    );
  });
});
