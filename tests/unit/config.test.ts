import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseRuntimeConfig } from "../../src/config.js";

describe("runtime configuration", () => {
  it("builds the pinned local runtime defaults from valid credentials", () => {
    const config = parseRuntimeConfig(
      {
        DAYTONA_API_KEY: "daytona-secret",
        OPENROUTER_API_KEY: "openrouter-secret",
        OPENROUTER_MODEL_ID: "stealth/ox-alpha",
      },
      "/workspace/blackbox",
    );

    expect(config).toEqual({
      blackbox: {
        host: "127.0.0.1",
        port: 3000,
      },
      daytona: {
        apiKey: "daytona-secret",
      },
      openRouter: {
        apiKey: "openrouter-secret",
        baseUrl: "https://openrouter.ai/api/v1",
        modelAlias: "ox-alpha",
        modelId: "stealth/ox-alpha",
      },
      runtimeDirectory: resolve("/workspace/blackbox", ".blackbox/runtime"),
      trueForge: {
        baseUrl: "http://127.0.0.1:8790",
        host: "127.0.0.1",
        port: 8790,
        sqlitePath: resolve(
          "/workspace/blackbox",
          ".blackbox/runtime/trueforge.sqlite",
        ),
      },
    });
  });

  it("honors documented model, port, host, and data-directory overrides", () => {
    const config = parseRuntimeConfig(
      {
        BLACKBOX_HOST: "0.0.0.0",
        BLACKBOX_PORT: "3100",
        BLACKBOX_RUNTIME_DIR: "var/runtime",
        DAYTONA_API_KEY: "daytona-secret",
        OPENROUTER_API_KEY: "openrouter-secret",
        OPENROUTER_MODEL_ID: "vendor/tool-model",
        TRUEFORGE_HOST: "127.0.0.2",
        TRUEFORGE_MODEL_ALIAS: "tool-model",
        TRUEFORGE_PORT: "8890",
      },
      "/workspace/blackbox",
    );

    expect(config.blackbox).toEqual({ host: "0.0.0.0", port: 3100 });
    expect(config.openRouter).toMatchObject({
      modelAlias: "tool-model",
      modelId: "vendor/tool-model",
    });
    expect(config.runtimeDirectory).toBe(
      resolve("/workspace/blackbox", "var/runtime"),
    );
    expect(config.trueForge).toEqual({
      baseUrl: "http://127.0.0.2:8890",
      host: "127.0.0.2",
      port: 8890,
      sqlitePath: resolve(
        "/workspace/blackbox",
        "var/runtime/trueforge.sqlite",
      ),
    });
  });

  it("rejects an invalid configured port before starting services", () => {
    expect(() =>
      parseRuntimeConfig({
        BLACKBOX_PORT: "not-a-port",
        DAYTONA_API_KEY: "daytona-secret",
        OPENROUTER_API_KEY: "openrouter-secret",
        OPENROUTER_MODEL_ID: "stealth/ox-alpha",
      }),
    ).toThrow("BLACKBOX_PORT must be an integer between 1 and 65535");
  });

  it("requires the OpenRouter model id instead of embedding one in application logic", () => {
    expect(() =>
      parseRuntimeConfig({
        DAYTONA_API_KEY: "daytona-secret",
        OPENROUTER_API_KEY: "openrouter-secret",
      }),
    ).toThrow("Missing required environment variable: OPENROUTER_MODEL_ID");
  });
});
