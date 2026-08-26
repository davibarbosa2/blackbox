import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

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
): { exitCode: number; result: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isObject(parsed) || !isObject(parsed.response)) {
      return undefined;
    }
    if (
      typeof parsed.response.exitCode !== "number" ||
      typeof parsed.response.result !== "string"
    ) {
      return undefined;
    }
    return {
      exitCode: parsed.response.exitCode,
      result: parsed.response.result,
    };
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
