import { randomUUID } from "node:crypto";

import {
  RuntimeSmokeStageError,
  type TrueForgeRuntime,
} from "../trueforge/runtime.js";
import {
  FileRuntimeSmokeStore,
  type RunningRuntimeSmoke,
  type RuntimeSmokeRecord,
} from "./file-store.js";

export type StartRuntimeSmokeResult =
  | {
      started: true;
      smokeId: string;
    }
  | {
      started: false;
      activeSmokeId: string;
    };

export class RuntimeSmokeCoordinator {
  readonly #runtime: TrueForgeRuntime;
  readonly #store: FileRuntimeSmokeStore;
  #active:
    | {
        completion: Promise<void>;
        controller: AbortController;
        smokeId: string;
      }
    | undefined;

  constructor(runtime: TrueForgeRuntime, store: FileRuntimeSmokeStore) {
    this.#runtime = runtime;
    this.#store = store;
  }

  async start(): Promise<StartRuntimeSmokeResult> {
    if (this.#active !== undefined) {
      return { activeSmokeId: this.#active.smokeId, started: false };
    }

    const smokeId = randomUUID();
    const timestamp = new Date().toISOString();
    const running: RunningRuntimeSmoke = {
      createdAt: timestamp,
      smokeId,
      stage: "runtime",
      status: "running",
      updatedAt: timestamp,
    };

    const controller = new AbortController();
    const startup = this.#store.write(running);
    const completion = startup
      .then(() => this.#execute(running, controller.signal))
      .finally(() => {
        if (this.#active?.smokeId === smokeId) {
          this.#active = undefined;
        }
      });
    this.#active = { completion, controller, smokeId };
    void completion.catch(() => undefined);
    await startup;

    return { smokeId, started: true };
  }

  read(smokeId: string): Promise<RuntimeSmokeRecord | undefined> {
    return this.#store.read(smokeId);
  }

  async shutdown(): Promise<void> {
    const active = this.#active;
    if (active === undefined) {
      return;
    }

    active.controller.abort(new Error("BLACKBOX is shutting down"));
    await active.completion;
  }

  async #execute(
    running: RunningRuntimeSmoke,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      signal.throwIfAborted();
      const result = await this.#runtime.executeSmoke({ signal });
      await this.#store.write({
        ...running,
        result,
        stage: "complete",
        status: "succeeded",
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      const failure = publicFailure(error);
      await this.#store.write(
        signal.aborted
          ? {
              ...running,
              status: "cancelled",
              updatedAt: new Date().toISOString(),
            }
          : {
              ...running,
              error: { message: failure.message },
              stage: failure.stage,
              status: "failed",
              updatedAt: new Date().toISOString(),
            },
      );
    }
  }
}

function publicFailure(error: unknown): {
  message: string;
  stage: RuntimeSmokeStageError["stage"] | "runtime";
} {
  return {
    message: error instanceof Error ? error.message : "Runtime smoke failed",
    stage: error instanceof RuntimeSmokeStageError ? error.stage : "runtime",
  };
}
