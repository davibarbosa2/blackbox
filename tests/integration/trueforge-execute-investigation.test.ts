import { TrueForge } from "@truefoundry/trueforge-sdk";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { executeTrueForgeInvestigation } from "../../src/trueforge/execute-investigation.js";

const CREATED_AT = "2026-08-27T20:00:00.000Z";
const BASE_HASH = "93d054afcb184730a08510550d5ed932dcf78ae88011a76b16423f615df0210c";
const BUNDLE_HASH = "a".repeat(64);
const CANARY_SHA256 = "b".repeat(64);
const ANALYSIS_ARTIFACT_PATH = "/tmp/blackbox-investigation-analysis.py";
const TRUSTED_DESTINATION =
  "http://127.0.0.1:3000/api/trusted-destination";
interface RawEvent {
  id: string;
  type: string;
}
const PROPOSAL = {
  canonicalCause: "missing_destination_allowlist_in_send_external_message",
  evidenceJustification: {
    bundleHash: BUNDLE_HASH,
    runId: "run-1",
    summary: "The exact Canary Secret reached the correlated External Sink.",
  },
  patch: {
    destinationAllowlist: [
      TRUSTED_DESTINATION,
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
  threadEvents(
    "PolicyPatchReviewer",
    "thread-policy",
    "call-subagent-policy",
    JSON.stringify({
      marker: "POLICY_PATCH_REVIEWED",
      policyHash: BASE_HASH,
      policyVersion: 1,
      protectedDocumentAccess: "unchanged",
      trustedDestination: TRUSTED_DESTINATION,
    }),
    "policy",
  ),
  threadEvents(
    "EvidenceProvenanceVerifier",
    "thread-evidence",
    "call-subagent-evidence",
    [
      "```json",
      JSON.stringify({
        bundleHash: BUNDLE_HASH,
        canonicalCause:
          "missing_destination_allowlist_in_send_external_message",
        marker: "EVIDENCE_PROVENANCE_VERIFIED",
        runId: "run-1",
      }),
      "```",
    ].join("\n"),
    "evidence",
  ),
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
      function: {
        arguments: JSON.stringify({
          command: [
            `cat > ${ANALYSIS_ARTIFACT_PATH} <<'PY'`,
            'print("BLACKBOX_INVESTIGATION_ANALYSIS_OK")',
            `print('${JSON.stringify({
              bundleHash: BUNDLE_HASH,
              canarySha256: CANARY_SHA256,
              canonicalCause:
                "missing_destination_allowlist_in_send_external_message",
              policyHash: BASE_HASH,
              runId: "run-1",
            })}')`,
            "PY",
            `python ${ANALYSIS_ARTIFACT_PATH}`,
          ].join("\n"),
          intent: "Create and execute the BLACKBOX investigation analysis artifact",
        }),
        name: "exec",
      },
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
      result: [
        "BLACKBOX_INVESTIGATION_ANALYSIS_OK",
        JSON.stringify({
          bundleHash: BUNDLE_HASH,
          canarySha256: CANARY_SHA256,
          canonicalCause:
            "missing_destination_allowlist_in_send_external_message",
          policyHash: BASE_HASH,
          runId: "run-1",
        }),
        "",
      ].join("\n"),
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
    const client = createClient(EVENTS);
    const milestones: unknown[] = [];

    const evidence = await executeTrueForgeInvestigation(
      client,
      "blackbox-investigator",
      "Investigate the supplied finalized Baseline Evidence Bundle.",
      undefined,
      (milestone) => milestones.push(milestone),
    );

    expect(evidence).toEqual({
      analysis: {
        artifact: {
          commandHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          path: ANALYSIS_ARTIFACT_PATH,
        },
        execution: {
          exitCode: 0,
          stdout: EXEC_RESPONSE.content
            ? JSON.parse(EXEC_RESPONSE.content).response.result
            : "",
          toolCallId: "call-exec",
        },
        result: {
          bundleHash: BUNDLE_HASH,
          canarySha256: CANARY_SHA256,
          canonicalCause:
            "missing_destination_allowlist_in_send_external_message",
          policyHash: BASE_HASH,
          runId: "run-1",
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
        threadId: "main",
        toolName: "apply_policy_patch",
        turnId: "turn-investigation-1",
      },
      subagents: [
        {
          createdEventId: "event-thread-policy-created",
          doneEventId: "event-thread-policy-done",
          inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          output: {
            marker: "POLICY_PATCH_REVIEWED",
            policyHash: BASE_HASH,
            policyVersion: 1,
            protectedDocumentAccess: "unchanged",
            trustedDestination: TRUSTED_DESTINATION,
          },
          outputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          role: "PolicyPatchReviewer",
          status: "done",
          threadId: "thread-policy",
          title: "PolicyPatchReviewer",
        },
        {
          createdEventId: "event-thread-evidence-created",
          doneEventId: "event-thread-evidence-done",
          inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          output: {
            bundleHash: BUNDLE_HASH,
            canonicalCause:
              "missing_destination_allowlist_in_send_external_message",
            marker: "EVIDENCE_PROVENANCE_VERIFIED",
            runId: "run-1",
          },
          outputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          role: "EvidenceProvenanceVerifier",
          status: "done",
          threadId: "thread-evidence",
          title: "EvidenceProvenanceVerifier",
        },
      ],
    });
    expect(milestones).toEqual([
      {
        kind: "TURN_STARTED",
        occurredAt: CREATED_AT,
        sessionId: "session-investigation-1",
        sourceEventId: "event-turn-created",
      },
      {
        kind: "INVESTIGATOR_MCP_INITIALIZED",
        occurredAt: CREATED_AT,
        sessionId: "session-investigation-1",
        sourceEventId: "event-mcp",
      },
      {
        kind: "POLICY_REVIEW_STARTED",
        occurredAt: CREATED_AT,
        sessionId: "session-investigation-1",
        sourceEventId: "event-thread-policy-created",
      },
      {
        kind: "POLICY_REVIEW_COMPLETED",
        occurredAt: CREATED_AT,
        sessionId: "session-investigation-1",
        sourceEventId: "event-thread-policy-done",
      },
      {
        kind: "EVIDENCE_REVIEW_STARTED",
        occurredAt: CREATED_AT,
        sessionId: "session-investigation-1",
        sourceEventId: "event-thread-evidence-created",
      },
      {
        kind: "EVIDENCE_REVIEW_COMPLETED",
        occurredAt: CREATED_AT,
        sessionId: "session-investigation-1",
        sourceEventId: "event-thread-evidence-done",
      },
      {
        kind: "ANALYSIS_SANDBOX_CREATED",
        occurredAt: CREATED_AT,
        sessionId: "session-investigation-1",
        sourceEventId: "event-sandbox-created",
      },
      {
        kind: "ANALYSIS_EXECUTION_STARTED",
        occurredAt: CREATED_AT,
        sessionId: "session-investigation-1",
        sourceEventId: "event-exec-call",
      },
      {
        kind: "ANALYSIS_EXECUTION_COMPLETED",
        occurredAt: CREATED_AT,
        sessionId: "session-investigation-1",
        sourceEventId: "event-exec-response",
      },
      {
        kind: "POLICY_PATCH_DRAFTED",
        occurredAt: CREATED_AT,
        sessionId: "session-investigation-1",
        sourceEventId: "event-apply-call",
      },
      {
        kind: "POLICY_ACTION_OBSERVED",
        occurredAt: CREATED_AT,
        sessionId: "session-investigation-1",
        sourceEventId: "action-apply-1",
      },
    ]);
    expect(JSON.stringify(milestones)).not.toContain(BUNDLE_HASH);
    expect(JSON.stringify(milestones)).not.toContain(CANARY_SHA256);
    expect(JSON.stringify(milestones)).not.toContain("Investigate the supplied");
  });

  it("does not treat an approval for another call as the Policy Patch boundary", async () => {
    const wrongApproval = {
      ...APPROVAL_REQUIRED,
      tool_calls: [
        { id: "call-not-the-policy-patch", source_event_id: APPLY_CALL.id },
      ],
    };
    const events = EVENTS.map((event) => {
      if (event.id === APPROVAL_REQUIRED.id) return wrongApproval;
      if (event.id === TURN_DONE.id) {
        return {
          ...TURN_DONE,
          state: { ...TURN_DONE.state, required_actions: [wrongApproval] },
        };
      }
      return event;
    });
    const milestones: Array<{ kind: string }> = [];

    await executeTrueForgeInvestigation(
      createClient(events),
      "blackbox-investigator",
      "Investigate finalized evidence.",
      undefined,
      (milestone) => milestones.push(milestone),
    );

    expect(milestones.some(({ kind }) => kind === "POLICY_ACTION_OBSERVED")).toBe(
      false,
    );
  });

  it("rejects a marker that was not produced by a created Python artifact", async () => {
    const events = EVENTS.map((event) =>
      event.id === EXEC_CALL.id
        ? {
            ...EXEC_CALL,
            tool_calls: EXEC_CALL.tool_calls.map((toolCall) => ({
                ...toolCall,
                function: { arguments: "{}", name: "exec" },
              })),
          }
        : event,
    );

    await expect(
      executeTrueForgeInvestigation(
        createClient(events),
        "blackbox-investigator",
        "Investigate the supplied finalized Baseline Evidence Bundle.",
      ),
    ).rejects.toThrow("analysis artifact command");
  });

  it("keeps progress reporting outside the investigation evidence boundary", async () => {
    await expect(
      executeTrueForgeInvestigation(
        createClient(EVENTS),
        "blackbox-investigator",
        "Investigate the supplied finalized Baseline Evidence Bundle.",
        undefined,
        () => {
          throw new Error("Mission Control progress store unavailable");
        },
      ),
    ).resolves.toMatchObject({
      pendingAction: {
        actionId: "action-apply-1",
        sessionId: "session-investigation-1",
      },
    });
  });

  it("rejects two completed but unfocused subagents", async () => {
    const genericThreads = [
      threadEvents(
        "GenericReviewer",
        "thread-policy",
        "call-subagent-policy",
        JSON.stringify({}),
        "policy",
      ),
      threadEvents(
        "GenericReviewer",
        "thread-evidence",
        "call-subagent-evidence",
        JSON.stringify({}),
        "evidence",
      ),
    ].flat();
    const events = EVENTS.map(
      (event) => genericThreads.find((candidate) => candidate.id === event.id) ?? event,
    );

    await expect(
      executeTrueForgeInvestigation(
        createClient(events),
        "blackbox-investigator",
        "Investigate the supplied finalized Baseline Evidence Bundle.",
      ),
    ).rejects.toThrow("focused subagent roles");
  });
});

function createClient(events: readonly RawEvent[]): TrueForge {
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
    const body = events
      .map(
        (event, index) =>
          `id: ${index + 1}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join("");
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
  app.get("/api/v1/sessions/:sessionId/turns/:turnId/events", (context) =>
    context.json({ data: events, pagination: { limit: 100 } }),
  );
  return new TrueForge({
    baseUrl: "http://trueforge.test",
    fetch: async (input, init) => app.fetch(new Request(input, init)),
    maxRetries: 0,
  });
}

function threadEvents(
  title: string,
  threadId: string,
  toolCallId: string,
  output: string,
  eventName: "evidence" | "policy",
) {
  return [
    {
      agent_info: {
        input: `Perform ${title} for bundle ${BUNDLE_HASH}, run run-1, policy ${BASE_HASH} version 1, and ${TRUSTED_DESTINATION}`,
        name: title,
        type: "dynamic",
      },
      created_at: CREATED_AT,
          id: `event-thread-${eventName}-created`,
      parent: { thread_id: "main", tool_call_id: toolCallId },
      thread_id: threadId,
      title,
      type: "thread.created",
    },
    {
      created_at: CREATED_AT,
          id: `event-thread-${eventName}-done`,
      parent: { thread_id: "main", tool_call_id: toolCallId },
      state: {
        output: {
          content: output,
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
