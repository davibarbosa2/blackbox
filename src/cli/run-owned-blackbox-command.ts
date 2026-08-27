import type { RuntimeConfig } from "../config.js";
import { startOwnedBlackbox } from "./owned-blackbox.js";

export async function runOwnedBlackboxCommand(
  config: RuntimeConfig,
  command: (baseUrl: string, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  let receivedSignal: NodeJS.Signals | undefined;
  const abort = (signal: NodeJS.Signals): void => {
    receivedSignal = signal;
    controller.abort(new Error(`Received ${signal}`));
  };
  const interrupt = (): void => abort("SIGINT");
  const terminate = (): void => abort("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);

  let failure: { error: unknown } | undefined;
  let blackbox: Awaited<ReturnType<typeof startOwnedBlackbox>> | undefined;
  try {
    blackbox = await startOwnedBlackbox(config, controller.signal);
    await command(blackbox.baseUrl, controller.signal);
  } catch (error) {
    failure = { error };
  } finally {
    try {
      await blackbox?.stop();
    } catch (error) {
      failure ??= { error };
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }

  if (receivedSignal === "SIGINT") {
    process.exitCode = 130;
    return;
  }
  if (receivedSignal === "SIGTERM") {
    process.exitCode = 143;
    return;
  }
  if (failure !== undefined) throw failure.error;
}
