import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { describe, expect, it } from "vitest";

import { findSuccessfulSandboxExecution } from "../../src/trueforge/sandbox-execution.js";

describe("Daytona sandbox execution evidence", () => {
  it("selects the correlated exec response with exit zero and the exact marker", () => {
    const toolCalls: TrueForgeApi.ModelMessageEvent = {
      createdAt: "2026-08-25T20:00:00.000Z",
      id: "event-tool-calls",
      threadId: "main",
      toolCalls: [
        {
          function: { arguments: "{}", name: "exec" },
          id: "call-failed",
          toolInfo: { name: "exec", type: "truefoundry-system" },
          type: "function",
        },
        {
          function: { arguments: "{}", name: "exec" },
          id: "call-source-code",
          toolInfo: { name: "exec", type: "truefoundry-system" },
          type: "function",
        },
        {
          function: { arguments: "{}", name: "exec" },
          id: "call-success",
          toolInfo: { name: "exec", type: "truefoundry-system" },
          type: "function",
        },
      ],
      type: "model.message",
    };
    const failedResponse: TrueForgeApi.ToolResponseEvent = {
      content: JSON.stringify({ response: { exitCode: 2, result: "failed" } }),
      createdAt: "2026-08-25T20:00:01.000Z",
      id: "event-response-failed",
      threadId: "main",
      toolCallId: "call-failed",
      type: "tool.response",
    };
    const sourceCodeResponse: TrueForgeApi.ToolResponseEvent = {
      content: JSON.stringify({
        response: {
          exitCode: 0,
          result: 'print("BLACKBOX_DAYTONA_OK")\n',
        },
      }),
      createdAt: "2026-08-25T20:00:02.000Z",
      id: "event-response-source-code",
      threadId: "main",
      toolCallId: "call-source-code",
      type: "tool.response",
    };
    const successfulResponse: TrueForgeApi.ToolResponseEvent = {
      content: JSON.stringify({
        response: { exitCode: 0, result: "BLACKBOX_DAYTONA_OK\n" },
      }),
      createdAt: "2026-08-25T20:00:03.000Z",
      id: "event-response-success",
      threadId: "main",
      toolCallId: "call-success",
      type: "tool.response",
    };

    expect(
      findSuccessfulSandboxExecution(
        [
          toolCalls,
          failedResponse,
          sourceCodeResponse,
          successfulResponse,
        ],
        "BLACKBOX_DAYTONA_OK",
      ),
    ).toEqual({
      exitCode: 0,
      stdout: "BLACKBOX_DAYTONA_OK\n",
      toolCallId: "call-success",
    });
  });
});
