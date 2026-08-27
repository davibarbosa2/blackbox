import { serve, type ServerType } from "@hono/node-server";

import type { RuntimeConfig } from "./config.js";
import { createBlackboxApplication } from "./http/app.js";
import { assertPortAvailable } from "./process/port.js";
import {
  createTrueForgeProcess,
  type OwnedTrueForgeProcess,
} from "./trueforge/process.js";
import { createSdkTrueForgeRuntime } from "./trueforge/sdk-runtime.js";
import type { TrueForgeRuntime } from "./trueforge/runtime.js";

interface BlackboxServerDependencies {
  trueForgeProcess?: OwnedTrueForgeProcess;
  trueForgeRuntime?: TrueForgeRuntime;
}

export interface RunningBlackboxServer {
  stop(): Promise<void>;
  url: string;
}

export async function startBlackboxServer(
  config: RuntimeConfig,
  dependencies: BlackboxServerDependencies = {},
  signal?: AbortSignal,
): Promise<RunningBlackboxServer> {
  signal?.throwIfAborted();
  await assertPortAvailable(
    config.blackbox.host,
    config.blackbox.port,
    "BLACKBOX",
  );
  signal?.throwIfAborted();
  const trueForgeProcess =
    dependencies.trueForgeProcess ??
    createTrueForgeProcess(config.trueForge, process.cwd());
  const trueForgeRuntime =
    dependencies.trueForgeRuntime ?? createSdkTrueForgeRuntime(config);

  try {
    await trueForgeProcess.start(signal);
  } catch (error) {
    await trueForgeProcess.stop();
    throw error;
  }

  try {
    signal?.throwIfAborted();
    const application = createBlackboxApplication({
      incident: {
        baseUrl: `http://${config.blackbox.host}:${config.blackbox.port}`,
        modelAlias: config.openRouter.modelAlias,
        modelId: config.openRouter.modelId,
      },
      runtimeDirectory: config.runtimeDirectory,
      trueForgeRuntime,
    });
    const httpServer = await listen(
      application.app.fetch,
      config.blackbox.host,
      config.blackbox.port,
    );
    let stopping: Promise<void> | undefined;
    const runningServer: RunningBlackboxServer = {
      stop(): Promise<void> {
        stopping ??= (async () => {
          const closed = close(httpServer);
          try {
            await application.shutdown();
          } finally {
            try {
              await closed;
            } finally {
              await trueForgeProcess.stop();
            }
          }
        })();
        return stopping;
      },
      url: `http://${config.blackbox.host}:${config.blackbox.port}`,
    };
    try {
      signal?.throwIfAborted();
    } catch (error) {
      await runningServer.stop();
      throw error;
    }
    return runningServer;
  } catch (error) {
    await trueForgeProcess.stop();
    throw error;
  }
}

async function listen(
  fetchHandler: Parameters<typeof serve>[0]["fetch"],
  hostname: string,
  port: number,
): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: fetchHandler, hostname, port },
      () => resolve(server),
    );
    server.once("error", reject);
  });
}

async function close(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
