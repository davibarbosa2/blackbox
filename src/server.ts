import { serve, type ServerType } from "@hono/node-server";

import type { RuntimeConfig } from "./config.js";
import {
  type BlackboxApplication,
  createBlackboxApplication,
} from "./http/app.js";
import { createBlackboxObservability } from "./observability/evlog.js";
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
  const observability = createBlackboxObservability({
    secrets: [config.openRouter.apiKey, config.daytona.apiKey],
  });

  try {
    await trueForgeProcess.start(signal);
  } catch (error) {
    await trueForgeProcess.stop();
    throw error;
  }

  let application: BlackboxApplication | undefined;
  let httpServer: ServerType | undefined;
  try {
    signal?.throwIfAborted();
    application = createBlackboxApplication({
      incident: {
        baseUrl: `http://${config.blackbox.host}:${config.blackbox.port}`,
        modelAlias: config.openRouter.modelAlias,
        modelId: config.openRouter.modelId,
      },
      runtimeDirectory: config.runtimeDirectory,
      trueForgeRuntime,
      observability,
    });
    httpServer = await listen(
      application.app.fetch,
      config.blackbox.host,
      config.blackbox.port,
    );
    application.recover();
    signal?.throwIfAborted();
    const ownedApplication = application;
    const ownedHttpServer = httpServer;
    let stopping: Promise<void> | undefined;
    const runningServer: RunningBlackboxServer = {
      stop(): Promise<void> {
        stopping ??= (async () => {
          const closed = close(ownedHttpServer);
          try {
            await ownedApplication.shutdown();
          } finally {
            try {
              await closed;
            } finally {
              try {
                await trueForgeProcess.stop();
              } finally {
                await observability.flush();
              }
            }
          }
        })();
        return stopping;
      },
      url: `http://${config.blackbox.host}:${config.blackbox.port}`,
    };
    return runningServer;
  } catch (error) {
    const closed =
      httpServer === undefined ? Promise.resolve() : close(httpServer);
    try {
      await application?.shutdown();
    } finally {
      try {
        await closed;
      } finally {
        try {
          await trueForgeProcess.stop();
        } finally {
          await observability.flush();
        }
      }
    }
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
