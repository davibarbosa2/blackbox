import { describe, expect, it } from "vitest";

import { runOpenRouterToolPreflight } from "../../src/openrouter/preflight.js";

describe("OpenRouter tool-calling preflight", () => {
  it("accepts only the configured model making the required tool call", async () => {
    const controller = new AbortController();
    const fetcher = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      expect(input.toString()).toBe(
        "https://openrouter.example/api/v1/chat/completions",
      );
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer openrouter-secret",
        "Content-Type": "application/json",
      });
      expect(init?.signal).toBe(controller.signal);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "vendor/tool-model",
        tool_choice: "required",
        tools: [
          {
            function: { name: "blackbox_preflight" },
            type: "function",
          },
        ],
      });

      return Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                {
                  function: {
                    arguments: "{}",
                    name: "blackbox_preflight",
                  },
                  id: "call-preflight",
                  type: "function",
                },
              ],
            },
          },
        ],
        model: "vendor/tool-model",
      });
    };

    await expect(
      runOpenRouterToolPreflight(
        {
          apiKey: "openrouter-secret",
          baseUrl: "https://openrouter.example/api/v1",
          modelId: "vendor/tool-model",
        },
        fetcher,
        controller.signal,
      ),
    ).resolves.toEqual({
      finishReason: "tool_calls",
      responseModel: "vendor/tool-model",
      toolCallId: "call-preflight",
      toolName: "blackbox_preflight",
    });
  });

  it("rejects a tool call made by a routed fallback model", async () => {
    const fetcher = async (): Promise<Response> =>
      Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                {
                  function: {
                    arguments: "{}",
                    name: "blackbox_preflight",
                  },
                  id: "call-fallback",
                  type: "function",
                },
              ],
            },
          },
        ],
        model: "vendor/fallback-model",
      });

    await expect(
      runOpenRouterToolPreflight(
        {
          apiKey: "openrouter-secret",
          baseUrl: "https://openrouter.example/api/v1",
          modelId: "vendor/tool-model",
        },
        fetcher,
      ),
    ).rejects.toThrow(
      "OpenRouter preflight returned model vendor/fallback-model, expected vendor/tool-model",
    );
  });
});
