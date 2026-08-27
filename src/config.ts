import { resolve } from "node:path";

export interface RuntimeConfig {
  blackbox: {
    host: string;
    port: number;
  };
  daytona: {
    apiKey: string;
  };
  openRouter: {
    apiKey: string;
    baseUrl: string;
    modelAlias: string;
    modelId: string;
  };
  runtimeDirectory: string;
  trueForge: {
    baseUrl: string;
    host: string;
    port: number;
    sqlitePath: string;
  };
}

export function parseRuntimeConfig(
  environment: NodeJS.ProcessEnv,
  workingDirectory = process.cwd(),
): RuntimeConfig {
  const blackboxHost = localBlackboxHost(environment.BLACKBOX_HOST);
  const blackboxPort = port(environment, "BLACKBOX_PORT", 3000);
  const trueForgeHost = environment.TRUEFORGE_HOST?.trim() || "127.0.0.1";
  const trueForgePort = port(environment, "TRUEFORGE_PORT", 8790);
  const runtimeDirectory = resolve(
    workingDirectory,
    environment.BLACKBOX_RUNTIME_DIR?.trim() || ".blackbox/runtime",
  );

  return {
    blackbox: {
      host: blackboxHost,
      port: blackboxPort,
    },
    daytona: {
      apiKey: required(environment, "DAYTONA_API_KEY"),
    },
    openRouter: {
      apiKey: required(environment, "OPENROUTER_API_KEY"),
      baseUrl: "https://openrouter.ai/api/v1",
      modelAlias: environment.TRUEFORGE_MODEL_ALIAS?.trim() || "ox-alpha",
      modelId: required(environment, "OPENROUTER_MODEL_ID"),
    },
    runtimeDirectory,
    trueForge: {
      baseUrl: `http://${trueForgeHost}:${trueForgePort}`,
      host: trueForgeHost,
      port: trueForgePort,
      sqlitePath: resolve(runtimeDirectory, "trueforge.sqlite"),
    },
  };
}

function localBlackboxHost(value: string | undefined): string {
  const host = value?.trim() || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("BLACKBOX_HOST must be 127.0.0.1 or localhost");
  }
  return host;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function port(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const value = environment[name];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}
