import { z } from "zod";

export const runtimeSmokeEvidenceSchema = z.object({
  agent: z.object({
    id: z.string(),
    name: z.string(),
  }),
  execution: z.object({
    exitCode: z.literal(0),
    stdout: z.string(),
    toolCallId: z.string(),
  }),
  health: z.object({
    body: z.literal("OK!"),
    status: z.literal(200),
  }),
  preflight: z.object({
    finishReason: z.literal("tool_calls"),
    responseModel: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
  }),
  provider: z.object({
    modelAlias: z.string(),
    name: z.string(),
    trueForgeModel: z.string(),
    upstreamModelId: z.string(),
  }),
  reconciliation: z.object({
    complete: z.boolean(),
    liveEventIds: z.array(z.string()),
    persistedEventIds: z.array(z.string()),
  }),
  sandbox: z.object({
    event: z.literal("sandbox.created"),
    id: z.string(),
  }),
  turn: z.object({
    sessionId: z.string(),
    status: z.literal("done"),
    turnId: z.string(),
  }),
  versions: z.object({
    node: z.string(),
    pnpm: z.literal("11.16.0"),
    trueForge: z.literal("0.1.4"),
    trueForgeSdk: z.literal("0.1.3"),
  }),
});

export type RuntimeSmokeEvidence = z.infer<typeof runtimeSmokeEvidenceSchema>;

export const runtimeSmokeFailureStageSchema = z.enum([
  "health",
  "configuration",
  "preflight",
  "sandbox-smoke",
]);

export type RuntimeSmokeFailureStage = z.infer<
  typeof runtimeSmokeFailureStageSchema
>;

const baselineToolCallSchema = z.object({
  arguments: z.string(),
  eventId: z.string(),
  occurredAt: z.string(),
  toolCallId: z.string(),
  toolName: z.enum([
    "get_support_ticket",
    "search_internal_documents",
    "read_internal_document",
    "send_external_message",
  ]),
});

export const baselineExecutionEvidenceSchema = z.object({
  mcpInitialization: z.object({
    eventId: z.string(),
    occurredAt: z.string(),
    serverName: z.literal("blackbox-scenario"),
  }),
  sessionId: z.string(),
  toolCalls: z.array(baselineToolCallSchema),
  toolResponses: z.array(
    z.object({
      content: z.string(),
      eventId: z.string(),
      occurredAt: z.string(),
      toolCallId: z.string(),
    }),
  ),
  turn: z.object({
    eventId: z.string(),
    occurredAt: z.string(),
    status: z.literal("done"),
    turnId: z.string(),
  }),
});

export type BaselineExecutionEvidence = z.infer<
  typeof baselineExecutionEvidenceSchema
>;

export interface BaselineExecutionRequest {
  mcpAuthorization: string;
  runId: string;
  signal?: AbortSignal;
}

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
  executeBaseline(
    request: BaselineExecutionRequest,
  ): Promise<BaselineExecutionEvidence>;
  executeSmoke(options?: {
    signal?: AbortSignal;
  }): Promise<RuntimeSmokeEvidence>;
}
