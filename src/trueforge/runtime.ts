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
