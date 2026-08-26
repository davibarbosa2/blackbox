import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import {
  runtimeSmokeEvidenceSchema,
  runtimeSmokeFailureStageSchema,
} from "../trueforge/runtime.js";

const runtimeSmokeBaseSchema = z.object({
  createdAt: z.string(),
  smokeId: z.string(),
  updatedAt: z.string(),
});

const runningRuntimeSmokeSchema = runtimeSmokeBaseSchema.extend({
  stage: z.literal("runtime"),
  status: z.literal("running"),
});

const succeededRuntimeSmokeSchema = runtimeSmokeBaseSchema.extend({
  result: runtimeSmokeEvidenceSchema,
  stage: z.literal("complete"),
  status: z.literal("succeeded"),
});

const failedRuntimeSmokeSchema = runtimeSmokeBaseSchema.extend({
  error: z.object({ message: z.string() }),
  stage: z.union([runtimeSmokeFailureStageSchema, z.literal("runtime")]),
  status: z.literal("failed"),
});

const cancelledRuntimeSmokeSchema = runtimeSmokeBaseSchema.extend({
  stage: z.literal("runtime"),
  status: z.literal("cancelled"),
});

export const runtimeSmokeRecordSchema = z.discriminatedUnion("status", [
  cancelledRuntimeSmokeSchema,
  runningRuntimeSmokeSchema,
  succeededRuntimeSmokeSchema,
  failedRuntimeSmokeSchema,
]);

export type CancelledRuntimeSmoke = z.infer<
  typeof cancelledRuntimeSmokeSchema
>;
export type RunningRuntimeSmoke = z.infer<typeof runningRuntimeSmokeSchema>;
export type SucceededRuntimeSmoke = z.infer<
  typeof succeededRuntimeSmokeSchema
>;
export type FailedRuntimeSmoke = z.infer<typeof failedRuntimeSmokeSchema>;
export type RuntimeSmokeRecord = z.infer<typeof runtimeSmokeRecordSchema>;

export class FileRuntimeSmokeStore {
  readonly #runtimeDirectory: string;

  constructor(runtimeDirectory: string) {
    this.#runtimeDirectory = runtimeDirectory;
  }

  async write(record: RuntimeSmokeRecord): Promise<void> {
    const resultPath = this.resultPath(record.smokeId);
    const temporaryPath = `${resultPath}.tmp`;

    await mkdir(dirname(resultPath), { mode: 0o700, recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, resultPath);
  }

  async read(smokeId: string): Promise<RuntimeSmokeRecord | undefined> {
    try {
      const contents = await readFile(this.resultPath(smokeId), "utf8");
      return runtimeSmokeRecordSchema.parse(JSON.parse(contents));
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }
  }

  resultPath(smokeId: string): string {
    return join(this.#runtimeDirectory, "smokes", smokeId, "result.json");
  }
}

function isMissingFile(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
