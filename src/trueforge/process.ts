import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ManagedServiceProcess } from "../process/managed-service.js";
import { assertPortAvailable } from "../process/port.js";
import type { RuntimeConfig } from "../config.js";

type TrueForgeProcessConfig = RuntimeConfig["trueForge"];

export interface OwnedTrueForgeProcess {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createTrueForgeProcess(
  config: TrueForgeProcessConfig,
  projectDirectory: string,
): OwnedTrueForgeProcess {
  const runtimeDirectory = dirname(config.sqlitePath);
  const service = new ManagedServiceProcess({
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
    async start(): Promise<void> {
      await assertPortAvailable(config.host, config.port, "TrueForge");
      await mkdir(runtimeDirectory, { mode: 0o700, recursive: true });
      await chmod(runtimeDirectory, 0o700);
      await service.start();
      await chmod(config.sqlitePath, 0o600);
    },
    stop(): Promise<void> {
      return service.stop();
    },
  };
}
