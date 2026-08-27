export interface SafeFailure {
  message: string;
  retryable: boolean;
  statusCode?: number;
}

export function classifyTrueForgeFailure(message: string): SafeFailure {
  const statusCode = upstreamStatusCode(message);
  if (statusCode === undefined) {
    return {
      message: "TrueForge execution failed",
      retryable: false,
    };
  }
  return {
    message: `TrueForge upstream request failed with HTTP ${statusCode}`,
    retryable: statusCode === 429 || statusCode >= 500,
    statusCode,
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
