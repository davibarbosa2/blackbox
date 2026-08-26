import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ManagedServiceProcess } from "../process/managed-service.js";
import { assertPortAvailable } from "../process/port.js";
import type { RuntimeConfig } from "../config.js";

type TrueForgeProcessConfig = RuntimeConfig["trueForge"];

export interface OwnedTrueForgeProcess {
  start(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

interface TrueForgeProcessDependencies {
  changeMode?: typeof chmod;
  service?: Pick<ManagedServiceProcess, "start" | "stop">;
}

export function createTrueForgeProcess(
  config: TrueForgeProcessConfig,
  projectDirectory: string,
  dependencies: TrueForgeProcessDependencies = {},
): OwnedTrueForgeProcess {
  const runtimeDirectory = dirname(config.sqlitePath);
  const changeMode = dependencies.changeMode ?? chmod;
  const service =
    dependencies.service ??
    new ManagedServiceProcess({
      args: ["--port", String(config.port)],
      command: join(projectDirectory, "node_modules", ".bin", "trueforge"),
      environment: {
        CODE_MODE_SOCKET_PARENT: join(runtimeDirectory, "code-mode-sockets"),
        HOST: config.host,
        LOCAL_SANDBOX_ROOT_PARENT: join(runtimeDirectory, "sandboxes"),
        LOG_LEVEL: "warn",
        NODE_ENV: "production",
        SQLITE_PATH: config.sqlitePath,
        STANDALONE: "true",
      },
      health: {
        expectedBody: "OK!",
        timeoutMs: 15_000,
        url: `${config.baseUrl}/healthz`,
      },
      name: "TrueForge",
      shutdownTimeoutMs: 35_000,
    });

  return {
    async start(signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      await assertPortAvailable(config.host, config.port, "TrueForge");
      await mkdir(runtimeDirectory, { mode: 0o700, recursive: true });
      await changeMode(runtimeDirectory, 0o700);
      await service.start(signal);
      try {
        signal?.throwIfAborted();
        await changeMode(config.sqlitePath, 0o600);
      } catch (error) {
        await service.stop();
        throw error;
      }
    },
    stop(): Promise<void> {
      return service.stop();
    },
  };
}
