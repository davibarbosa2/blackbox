import { TrueForge } from "@truefoundry/trueforge-sdk";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

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
  it("emits a canonical tool invocation before the live turn finishes", async () => {
    let releaseStream = (): void => undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const observedCalls: Array<{
      arguments: string;
      eventId: string;
      occurredAt: string;
      toolCallId: string;
      toolName: (typeof CANONICAL_TOOL_NAMES)[number];
    }> = [];
    const firstCall = TOOL_EVENTS[0]!;
    const firstCallStarted = {
      ...firstCall,
      finish_reason: null,
      tool_calls: undefined,
    };
    const firstCallIdentity = {
      id: firstCall.id,
      thread_id: "main",
      tool_calls: [
        {
          function: {
            arguments: '{"run',
            name: "get_support_ticket",
          },
          id: "call-1",
          index: 0,
          tool_info: {
            name: "get_support_ticket",
            server_id: "server-1",
            server_name: "blackbox-scenario",
            type: "mcp",
          },
          type: "function",
        },
      ],
      type: "model.message.delta",
    };
    const firstCallFinished = {
      finish_reason: "tool_calls",
      id: firstCall.id,
      thread_id: "main",
      tool_calls: [
        {
          function: { arguments: 'Id":"run-1"}' },
          index: 0,
        },
      ],
      type: "model.message.delta",
    };
    const liveEvents = [
      TURN_CREATED,
      MCP_INITIALIZED,
      firstCallStarted,
      firstCallIdentity,
      firstCallFinished,
      ...TOOL_EVENTS.slice(1),
      TURN_DONE,
    ];
    const persistedEvents = EVENTS.map((event) =>
      event === firstCall
        ? { ...event, created_at: "2026-08-26T20:00:00.250Z" }
        : event,
    );
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
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        async start(controller) {
          for (const [index, event] of liveEvents.entries()) {
            controller.enqueue(
              encoder.encode(
                `id: ${index + 1}\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
            if (event === firstCallFinished) await streamGate;
          }
          controller.close();
        },
      }), {
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
        context.json({ data: persistedEvents, pagination: { limit: 100 } }),
    );
    const client = new TrueForge({
      baseUrl: "http://trueforge.test",
      fetch: async (input, init) => app.fetch(new Request(input, init)),
      maxRetries: 0,
    });

    let settled = false;
    const execution = executeTrueForgeBaseline(
      client,
      "blackbox-support-agent",
      "run-1",
      undefined,
      (call) => observedCalls.push(call),
    ).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(observedCalls).toEqual([
        {
          arguments: JSON.stringify({ runId: "run-1" }),
          eventId: "event-call-1:tool:call-1",
          occurredAt: CREATED_AT,
          toolCallId: "call-1",
          toolName: "get_support_ticket",
        },
      ]);
    });
    expect(settled).toBe(false);
    releaseStream();
    const evidence = await execution;

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
    expect(observedCalls).toEqual(evidence.toolCalls);
  });
});
