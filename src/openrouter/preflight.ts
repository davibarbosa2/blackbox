import { z } from "zod";

const PREFLIGHT_TOOL_NAME = "blackbox_preflight";

const preflightEnvelopeSchema = z.object({
  choices: z.array(z.unknown()),
  model: z.string(),
});

const preflightChoiceSchema = z.object({
  finish_reason: z.literal("tool_calls"),
  message: z.object({ tool_calls: z.array(z.unknown()) }),
});

const preflightToolCallSchema = z.object({
  function: z.object({ name: z.string() }),
  id: z.string(),
});

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
  const request: RequestInit = {
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
  };
  if (signal !== undefined) {
    request.signal = signal;
  }

  const response = await fetcher(
    `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
    request,
  );

  if (!response.ok) {
    throw new Error(`OpenRouter preflight failed with HTTP ${response.status}`);
  }

  const envelope = preflightEnvelopeSchema.safeParse(await response.json());
  const choice = envelope.success
    ? preflightChoiceSchema.safeParse(envelope.data.choices[0])
    : undefined;
  const toolCall = choice?.success
    ? choice.data.message.tool_calls
        .map((candidate) => preflightToolCallSchema.safeParse(candidate))
        .find(
          (candidate) =>
            candidate.success &&
            candidate.data.function.name === PREFLIGHT_TOOL_NAME,
        )
    : undefined;
  if (!envelope.success || !choice?.success || !toolCall?.success) {
    throw new Error(
      `OpenRouter preflight did not call ${PREFLIGHT_TOOL_NAME} as required`,
    );
  }
  if (envelope.data.model !== config.modelId) {
    throw new Error(
      `OpenRouter preflight returned model ${envelope.data.model}, expected ${config.modelId}`,
    );
  }

  return {
    finishReason: "tool_calls",
    responseModel: envelope.data.model,
    toolCallId: toolCall.data.id,
    toolName: PREFLIGHT_TOOL_NAME,
  };
}
