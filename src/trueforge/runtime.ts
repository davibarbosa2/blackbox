export interface RuntimeSmokeEvidence {
  agent: {
    id: string;
    name: string;
  };
  health: {
    body: "OK!";
    status: 200;
  };
  provider: {
    name: string;
    upstreamModelId: string;
    modelAlias: string;
    trueForgeModel: string;
  };
  preflight: {
    finishReason: "tool_calls";
    responseModel: string;
    toolCallId: string;
    toolName: string;
  };
  sandbox: {
    event: "sandbox.created";
    id: string;
  };
  execution: {
    exitCode: 0;
    stdout: string;
    toolCallId: string;
  };
  turn: {
    sessionId: string;
    turnId: string;
    status: "done";
  };
  reconciliation: {
    complete: boolean;
    liveEventIds: string[];
    persistedEventIds: string[];
  };
  versions: {
    node: string;
    pnpm: "11.16.0";
    trueForge: "0.1.4";
    trueForgeSdk: "0.1.3";
  };
}

export type RuntimeSmokeFailureStage =
  | "health"
  | "configuration"
  | "preflight"
  | "sandbox-smoke";

export class RuntimeSmokeStageError extends Error {
  readonly stage: RuntimeSmokeFailureStage;

  constructor(stage: RuntimeSmokeFailureStage, cause: unknown) {
    super(cause instanceof Error ? cause.message : "Runtime smoke failed", {
      cause,
    });
    this.name = "RuntimeSmokeStageError";
    this.stage = stage;
  }
}

export interface TrueForgeRuntime {
  executeSmoke(options?: {
    signal?: AbortSignal;
  }): Promise<RuntimeSmokeEvidence>;
}
