import { spawn, type ChildProcess } from "node:child_process";

interface ManagedServiceOptions {
  args: string[];
  command: string;
  environment?: Record<string, string>;
  health: {
    expectedBody: string;
    timeoutMs: number;
    url: string;
  };
  name: string;
  shutdownTimeoutMs: number;
}

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class ManagedServiceProcess {
  readonly #options: ManagedServiceOptions;
  #child: ChildProcess | undefined;
  #exitPromise: Promise<ExitResult> | undefined;
  #exitResult: ExitResult | undefined;
  #spawnError: Error | undefined;
  #stderr = "";

  constructor(options: ManagedServiceOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#child !== undefined) {
      throw new Error(`${this.#options.name} is already started`);
    }

    this.#exitResult = undefined;
    this.#spawnError = undefined;
    this.#stderr = "";

    const child = spawn(this.#options.command, this.#options.args, {
      env: { ...process.env, ...this.#options.environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-4_096);
    });
    child.stdout?.resume();
    child.on("error", (error) => {
      this.#spawnError = error;
    });
    this.#exitPromise = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        this.#exitResult = { code, signal };
        resolve(this.#exitResult);
      });
    });

    try {
      await this.#waitUntilHealthy();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.#child;
    const exitPromise = this.#exitPromise;
    if (child === undefined || exitPromise === undefined) {
      return;
    }

    if (this.#exitResult === undefined) {
      child.kill("SIGTERM");
      const exitedGracefully = await settlesWithin(
        exitPromise,
        this.#options.shutdownTimeoutMs,
      );
      if (!exitedGracefully && this.#exitResult === undefined) {
        child.kill("SIGKILL");
        await exitPromise;
      }
    }

    this.#child = undefined;
    this.#exitPromise = undefined;
  }

  async #waitUntilHealthy(): Promise<void> {
    const deadline = Date.now() + this.#options.health.timeoutMs;

    while (Date.now() < deadline) {
      if (this.#spawnError !== undefined) {
        throw new Error(
          `${this.#options.name} failed to start: ${this.#spawnError.message}`,
        );
      }
      if (this.#exitResult !== undefined) {
        throw new Error(this.#earlyExitMessage());
      }

      try {
        const response = await fetch(this.#options.health.url, {
          signal: AbortSignal.timeout(500),
        });
        if (
          response.ok &&
          (await response.text()) === this.#options.health.expectedBody
        ) {
          return;
        }
      } catch {
        // The child may still be binding its socket.
      }

      await delay(50);
    }

    throw new Error(
      `${this.#options.name} health check timed out at ${this.#options.health.url}`,
    );
  }

  #earlyExitMessage(): string {
    const result = this.#exitResult;
    const detail = this.#stderr.trim();
    const suffix = detail ? `: ${detail}` : "";
    return `${this.#options.name} exited before becoming healthy (code ${String(result?.code)}, signal ${String(result?.signal)})${suffix}`;
  }
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
