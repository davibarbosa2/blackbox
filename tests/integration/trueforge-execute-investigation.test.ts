import { TrueForge } from "@truefoundry/trueforge-sdk";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { executeTrueForgeInvestigation } from "../../src/trueforge/execute-investigation.js";

const CREATED_AT = "2026-08-27T20:00:00.000Z";
const BASE_HASH = "93d054afcb184730a08510550d5ed932dcf78ae88011a76b16423f615df0210c";
const BUNDLE_HASH = "a".repeat(64);
const PROPOSAL = {
  canonicalCause: "missing_destination_allowlist_in_send_external_message",
  evidenceJustification: {
    bundleHash: BUNDLE_HASH,
    runId: "run-1",
    summary: "The exact Canary Secret reached the correlated External Sink.",
  },
  patch: {
    destinationAllowlist: [
      "http://127.0.0.1:3000/api/trusted-destination",
    ],
    expectedBaseHash: BASE_HASH,
    expectedBaseVersion: 1,
  },
};
const TURN_CREATED = {
  created_at: CREATED_AT,
  id: "event-turn-created",
  previous_turn_id: null,
  state: { status: "running" },
  thread_id: null,
  turn_id: "turn-investigation-1",
  type: "turn.created",
};
const MCP_INITIALIZED = {
  created_at: CREATED_AT,
  id: "event-mcp",
  mcp_servers: [{ id: "server-investigator", name: "blackbox-investigator" }],
  thread_id: "main",
  type: "mcp.initialize",
};
const THREADS = [
  threadEvents("policy-analysis", "thread-policy", "call-subagent-policy"),
  threadEvents("evidence-analysis", "thread-evidence", "call-subagent-evidence"),
].flat();
const SANDBOX_CREATED = {
  created_at: CREATED_AT,
  id: "event-sandbox-created",
  sandbox_id: "v1:daytona:default.investigation-1",
  thread_id: null,
  type: "sandbox.created",
};
const EXEC_CALL = {
  content: null,
  created_at: CREATED_AT,
  finish_reason: "tool_calls",
  id: "event-exec-call",
  thread_id: "main",
  tool_calls: [
    {
      function: { arguments: "{}", name: "exec" },
      id: "call-exec",
      tool_info: { name: "exec", type: "truefoundry-system" },
      type: "function",
    },
  ],
  type: "model.message",
};
const EXEC_RESPONSE = {
  content: JSON.stringify({
    response: {
      exitCode: 0,
      result: "BLACKBOX_INVESTIGATION_ANALYSIS_OK\n",
    },
  }),
  created_at: CREATED_AT,
  id: "event-exec-response",
  thread_id: "main",
  tool_call_id: "call-exec",
  type: "tool.response",
};
const APPLY_CALL = {
  content: null,
  created_at: CREATED_AT,
  finish_reason: "tool_calls",
  id: "event-apply-call",
  thread_id: "main",
  tool_calls: [
    {
      function: {
        arguments: JSON.stringify(PROPOSAL),
        name: "apply_policy_patch",
      },
      id: "call-apply-1",
      tool_info: {
        name: "apply_policy_patch",
        server_id: "server-investigator",
        server_name: "blackbox-investigator",
        type: "mcp",
      },
      type: "function",
    },
  ],
  type: "model.message",
};
const APPROVAL_REQUIRED = {
  created_at: CREATED_AT,
  id: "action-apply-1",
  thread_id: "main",
  tool_calls: [
    {
      id: "call-apply-1",
      source_event_id: "event-apply-call",
    },
  ],
  type: "tool.approval_required",
};
const TURN_DONE = {
  created_at: CREATED_AT,
  id: "event-turn-done",
  state: {
    completed_at: CREATED_AT,
    output: null,
    required_actions: [APPROVAL_REQUIRED],
    status: "done",
  },
  thread_id: null,
  type: "turn.done",
};
const EVENTS = [
  TURN_CREATED,
  MCP_INITIALIZED,
  ...THREADS,
  SANDBOX_CREATED,
  EXEC_CALL,
  EXEC_RESPONSE,
  APPLY_CALL,
  APPROVAL_REQUIRED,
  TURN_DONE,
];

describe("TrueForge Incident investigation", () => {
  it("proves two subagents, Daytona analysis, and the literal pending action", async () => {
    const app = new Hono();
    app.post("/api/v1/sessions", (context) =>
      context.json({
        data: {
          agent: {
            id: "agent-investigator",
            name: "blackbox-investigator",
            type: "reference",
          },
          created_at: CREATED_AT,
          created_by: "local",
          id: "session-investigation-1",
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
          id: "turn-investigation-1",
          previous_turn_id: null,
          session_id: "session-investigation-1",
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

    const evidence = await executeTrueForgeInvestigation(
      client,
      "blackbox-investigator",
      "Investigate the supplied finalized Baseline Evidence Bundle.",
    );

    expect(evidence).toEqual({
      analysis: {
        execution: {
          exitCode: 0,
          stdout: "BLACKBOX_INVESTIGATION_ANALYSIS_OK\n",
          toolCallId: "call-exec",
        },
        sandbox: {
          event: "sandbox.created",
          id: "v1:daytona:default.investigation-1",
        },
      },
      diagnosis: {
        canonicalCause: "missing_destination_allowlist_in_send_external_message",
        summary: "The exact Canary Secret reached the correlated External Sink.",
      },
      pendingAction: {
        actionId: "action-apply-1",
        callId: "call-apply-1",
        proposal: PROPOSAL,
        sessionId: "session-investigation-1",
        toolName: "apply_policy_patch",
        turnId: "turn-investigation-1",
      },
      subagents: [
        {
          createdEventId: "event-thread-policy-created",
          doneEventId: "event-thread-policy-done",
          status: "done",
          threadId: "thread-policy",
          title: "policy-analysis",
        },
        {
          createdEventId: "event-thread-evidence-created",
          doneEventId: "event-thread-evidence-done",
          status: "done",
          threadId: "thread-evidence",
          title: "evidence-analysis",
        },
      ],
    });
  });
});

function threadEvents(title: string, threadId: string, toolCallId: string) {
  return [
    {
      agent_info: {
        input: `Analyze ${title}`,
        name: title,
        type: "dynamic",
      },
      created_at: CREATED_AT,
      id: `event-thread-${title === "policy-analysis" ? "policy" : "evidence"}-created`,
      parent: { thread_id: "main", tool_call_id: toolCallId },
      thread_id: threadId,
      title,
      type: "thread.created",
    },
    {
      created_at: CREATED_AT,
      id: `event-thread-${title === "policy-analysis" ? "policy" : "evidence"}-done`,
      parent: { thread_id: "main", tool_call_id: toolCallId },
      state: {
        output: {
          content: `${title} completed`,
          created_at: CREATED_AT,
          id: `event-thread-${threadId}-output`,
          thread_id: threadId,
          type: "model.message",
        },
        status: "done",
      },
      thread_id: threadId,
      title,
      type: "thread.done",
    },
  ];
}
