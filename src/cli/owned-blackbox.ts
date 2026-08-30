import { join } from "node:path";

import type { RuntimeConfig } from "../config.js";
import { ManagedServiceProcess } from "../process/managed-service.js";
import { assertPortAvailable } from "../process/port.js";

export interface OwnedBlackbox {
  baseUrl: string;
  stop(): Promise<void>;
}

export async function startOwnedBlackbox(
  config: RuntimeConfig,
  signal: AbortSignal,
): Promise<OwnedBlackbox> {
  await assertPortAvailable(
    config.blackbox.host,
    config.blackbox.port,
    "BLACKBOX",
  );
  const baseUrl = `http://${config.blackbox.host}:${config.blackbox.port}`;
  const service = new ManagedServiceProcess({
    args: ["src/main.ts"],
    command: join(process.cwd(), "node_modules", ".bin", "tsx"),
    environment: {
      BLACKBOX_HOST: config.blackbox.host,
      BLACKBOX_PORT: String(config.blackbox.port),
      BLACKBOX_RUNTIME_DIR: config.runtimeDirectory,
      DAYTONA_API_KEY: config.daytona.apiKey,
      OPENROUTER_API_KEY: config.openRouter.apiKey,
      OPENROUTER_MODEL_ID: config.openRouter.modelId,
      TRUEFORGE_HOST: config.trueForge.host,
      TRUEFORGE_MODEL_ALIAS: config.openRouter.modelAlias,
      TRUEFORGE_PORT: String(config.trueForge.port),
    },
    health: {
      expectedBody: '{"status":"ok"}',
      timeoutMs: 30_000,
      url: `${baseUrl}/healthz`,
    },
    name: "BLACKBOX",
    output: process.stderr,
    shutdownTimeoutMs: 45_000,
  });
  await service.start(signal);
  return {
    baseUrl,
    stop: () => service.stop(),
  };
}
