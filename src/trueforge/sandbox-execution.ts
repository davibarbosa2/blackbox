import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { z } from "zod";

const execResponseSchema = z.object({
  response: z.object({
    exitCode: z.number(),
    result: z.string(),
  }),
});

type ExecResponse = z.infer<typeof execResponseSchema>["response"];

export interface SandboxExecutionEvidence {
  exitCode: 0;
  stdout: string;
  toolCallId: string;
}

export function findSuccessfulSandboxExecution(
  events: readonly TrueForgeApi.SessionEvent[],
  expectedMarker: string,
): SandboxExecutionEvidence {
  const execCallIds = new Set(
    events
      .filter(
        (event): event is TrueForgeApi.ModelMessageEvent =>
          event.type === "model.message",
      )
      .flatMap((event) => event.toolCalls ?? [])
      .filter((toolCall) => toolCall.function.name === "exec")
      .map((toolCall) => toolCall.id),
  );

  for (const event of events) {
    if (
      event.type !== "tool.response" ||
      !execCallIds.has(event.toolCallId)
    ) {
      continue;
    }

    const response = parseExecResponse(event.content);
    if (
      response?.exitCode === 0 &&
      response.result.split(/\r?\n/).includes(expectedMarker)
    ) {
      return {
        exitCode: 0,
        stdout: response.result,
        toolCallId: event.toolCallId,
      };
    }
  }

  throw new Error(
    `No correlated sandbox exec returned exit code 0 with ${expectedMarker}`,
  );
}

function parseExecResponse(
  content: string,
): ExecResponse | undefined {
  try {
    const parsed = execResponseSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data.response : undefined;
  } catch {
    return undefined;
  }
}
