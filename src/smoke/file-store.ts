import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  RuntimeSmokeEvidence,
  RuntimeSmokeFailureStage,
} from "../trueforge/runtime.js";

interface RuntimeSmokeBase {
  smokeId: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunningRuntimeSmoke extends RuntimeSmokeBase {
  status: "running";
  stage: "runtime";
}

export interface SucceededRuntimeSmoke extends RuntimeSmokeBase {
  status: "succeeded";
  stage: "complete";
  result: RuntimeSmokeEvidence;
}

export interface FailedRuntimeSmoke extends RuntimeSmokeBase {
  status: "failed";
  stage: RuntimeSmokeFailureStage | "runtime";
  error: {
    message: string;
  };
}

export interface CancelledRuntimeSmoke extends RuntimeSmokeBase {
  status: "cancelled";
  stage: "runtime";
}

export type RuntimeSmokeRecord =
  | CancelledRuntimeSmoke
  | RunningRuntimeSmoke
  | SucceededRuntimeSmoke
  | FailedRuntimeSmoke;

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
      return JSON.parse(contents) as RuntimeSmokeRecord;
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

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
