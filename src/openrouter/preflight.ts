const PREFLIGHT_TOOL_NAME = "blackbox_preflight";

interface OpenRouterPreflightConfig {
  apiKey: string;
  baseUrl: string;
  modelId: string;
}

export interface OpenRouterPreflightEvidence {
  finishReason: "tool_calls";
  responseModel: string;
  toolCallId: string;
  toolName: typeof PREFLIGHT_TOOL_NAME;
}

export async function runOpenRouterToolPreflight(
  config: OpenRouterPreflightConfig,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<OpenRouterPreflightEvidence> {
  const response = await fetcher(
    `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      body: JSON.stringify({
        max_tokens: 64,
        messages: [
          {
            content: `Call ${PREFLIGHT_TOOL_NAME} exactly once.`,
            role: "user",
          },
        ],
        model: config.modelId,
        temperature: 0,
        tool_choice: "required",
        tools: [
          {
            function: {
              description: "Confirms that the configured model can call tools.",
              name: PREFLIGHT_TOOL_NAME,
              parameters: {
                additionalProperties: false,
                properties: {},
                type: "object",
              },
            },
            type: "function",
          },
        ],
      }),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      ...(signal ? { signal } : {}),
    },
  );

  if (!response.ok) {
    throw new Error(`OpenRouter preflight failed with HTTP ${response.status}`);
  }

  const body: unknown = await response.json();
  const evidence = extractPreflightEvidence(body);
  if (evidence === undefined) {
    throw new Error(
      `OpenRouter preflight did not call ${PREFLIGHT_TOOL_NAME} as required`,
    );
  }
  return evidence;
}

function extractPreflightEvidence(
  body: unknown,
): OpenRouterPreflightEvidence | undefined {
  if (!isObject(body) || typeof body.model !== "string") {
    return undefined;
  }

  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  if (
    !isObject(choice) ||
    choice.finish_reason !== "tool_calls" ||
    !isObject(choice.message) ||
    !Array.isArray(choice.message.tool_calls)
  ) {
    return undefined;
  }

  const toolCall = choice.message.tool_calls.find(
    (candidate) =>
      isObject(candidate) &&
      typeof candidate.id === "string" &&
      isObject(candidate.function) &&
      candidate.function.name === PREFLIGHT_TOOL_NAME,
  );
  if (
    !isObject(toolCall) ||
    typeof toolCall.id !== "string" ||
    !isObject(toolCall.function)
  ) {
    return undefined;
  }

  return {
    finishReason: "tool_calls",
    responseModel: body.model,
    toolCallId: toolCall.id,
    toolName: PREFLIGHT_TOOL_NAME,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
