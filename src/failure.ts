export interface SafeFailure {
  message: string;
  retryable: boolean;
  statusCode?: number;
}

export type BaselineFailureStage = "trueforge" | "victim-agent";

export interface ClassifiedFailure {
  failure: SafeFailure;
  stage: BaselineFailureStage;
}

const INCOMPLETE_CANONICAL_WORKFLOW_MESSAGE =
  "Victim Agent ended before completing the canonical tool workflow";

export function classifyTrueForgeFailure(
  message: string,
): ClassifiedFailure {
  if (
    message.startsWith("TrueForge canonical tool sequence was incomplete:") ||
    message === INCOMPLETE_CANONICAL_WORKFLOW_MESSAGE
  ) {
    return {
      failure: {
        message: INCOMPLETE_CANONICAL_WORKFLOW_MESSAGE,
        retryable: false,
      },
      stage: "victim-agent",
    };
  }
  const statusCode = upstreamStatusCode(message);
  if (statusCode === undefined) {
    return {
      failure: {
        message: "TrueForge execution failed",
        retryable: false,
      },
      stage: "trueforge",
    };
  }
  return {
    failure: {
      message: `TrueForge upstream request failed with HTTP ${statusCode}`,
      retryable: statusCode === 429 || statusCode >= 500,
      statusCode,
    },
    stage: "trueforge",
  };
}

function upstreamStatusCode(message: string): number | undefined {
  const patterns = [
    /Request failed \(([1-5]\d{2})\)/i,
    /received\s+([1-5]\d{2})\b/i,
    /HTTP\s+([1-5]\d{2})\b/i,
  ];
  for (const pattern of patterns) {
    const value = pattern.exec(message)?.[1];
    if (value !== undefined) return Number(value);
  }
  return undefined;
}
