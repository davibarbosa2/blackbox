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
): Promise<RunningBlackboxServer> {
  await assertPortAvailable(
    config.blackbox.host,
    config.blackbox.port,
    "BLACKBOX",
  );
  const trueForgeProcess =
    dependencies.trueForgeProcess ??
    createTrueForgeProcess(config.trueForge, process.cwd());
  const trueForgeRuntime =
    dependencies.trueForgeRuntime ?? createSdkTrueForgeRuntime(config);

  await trueForgeProcess.start();
  const application = createBlackboxApplication({
    runtimeDirectory: config.runtimeDirectory,
    trueForgeRuntime,
  });

  let httpServer: ServerType;
  try {
    httpServer = await listen(
      application.app.fetch,
      config.blackbox.host,
      config.blackbox.port,
    );
  } catch (error) {
    await trueForgeProcess.stop();
    throw error;
  }

  let stopping: Promise<void> | undefined;
  return {
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
