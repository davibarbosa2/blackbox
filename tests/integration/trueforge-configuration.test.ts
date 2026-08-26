import { TrueForge } from "@truefoundry/trueforge-sdk";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { RuntimeConfig } from "../../src/config.js";
import { configureTrueForge } from "../../src/trueforge/configure.js";

const CONFIG: RuntimeConfig = {
  blackbox: { host: "127.0.0.1", port: 3000 },
  daytona: { apiKey: "daytona-secret" },
  openRouter: {
    apiKey: "openrouter-secret",
    baseUrl: "https://openrouter.example/api/v1",
    modelAlias: "tool-model",
    modelId: "vendor/tool-model",
  },
  runtimeDirectory: "/runtime",
  trueForge: {
    baseUrl: "http://trueforge.test",
    host: "127.0.0.1",
    port: 8790,
    sqlitePath: "/runtime/trueforge.sqlite",
  },
};

describe("TrueForge runtime configuration", () => {
  it("upserts providers and creates the stable smoke agent", async () => {
    const app = new Hono();
    const requests: Array<{ body: unknown; path: string }> = [];
    let modelProviderReadbacks = 0;

    app.put("/api/v1/settings/model-providers", async (context) => {
      const body = await context.req.json();
      requests.push({ body, path: context.req.path });
      return context.json({ data: { manifest: body.manifest } });
    });
    app.get("/api/v1/settings/model-providers", (context) => {
      modelProviderReadbacks += 1;
      return context.json({
        data: [
          {
            manifest: {
              base_url: "https://openrouter.example/api/v1",
              models: [
                {
                  model_id: "vendor/tool-model",
                  name: "tool-model",
                  properties: {},
                },
              ],
              name: "openrouter",
              type: "custom",
            },
            name: "openrouter",
          },
        ],
      });
    });
    app.put("/api/v1/settings/sandbox-providers", async (context) => {
      const body = await context.req.json();
      requests.push({ body, path: context.req.path });
      return context.json({
        data: {
          manifest: body.manifest,
          status: "ready",
          status_reason: null,
        },
      });
    });
    app.get("/api/v1/agents", (context) => context.json({ data: [] }));
    app.post("/api/v1/agents", async (context) => {
      const body = await context.req.json();
      requests.push({ body, path: context.req.path });
      return context.json({ data: { id: "agent-1", ...body } });
    });

    const client = new TrueForge({
      baseUrl: CONFIG.trueForge.baseUrl,
      fetch: async (input, init) => app.fetch(new Request(input, init)),
      maxRetries: 0,
    });

    await expect(configureTrueForge(client, CONFIG)).resolves.toEqual({
      agentId: "agent-1",
      agentName: "blackbox-runtime-smoke",
      sandboxStatus: "ready",
      trueForgeModel: "openrouter/tool-model",
    });
    expect(modelProviderReadbacks).toBe(1);
    expect(requests).toEqual([
      {
        body: {
          manifest: {
            auth: { api_key: "openrouter-secret" },
            base_url: "https://openrouter.example/api/v1",
            models: [
              {
                model_id: "vendor/tool-model",
                name: "tool-model",
                properties: {},
              },
            ],
            name: "openrouter",
            type: "custom",
          },
        },
        path: "/api/v1/settings/model-providers",
      },
      {
        body: {
          manifest: {
            auth: { api_key: "daytona-secret" },
            auto_archive_interval_in_minutes: 60,
            auto_delete_interval_in_minutes: 120,
            auto_stop_interval_in_minutes: 5,
            exec_timeout_ms: 120000,
            type: "daytona",
          },
        },
        path: "/api/v1/settings/sandbox-providers",
      },
      {
        body: {
          manifest: {
            config: {
              ask_user_questions: { enabled: false },
              dynamic_sub_agents: { enabled: false },
              generative_ui: { enabled: false },
              iteration_limit: 12,
              sandbox: { enabled: true, file_downloads: false },
            },
            instructions: expect.stringContaining("BLACKBOX_DAYTONA_OK"),
            model: {
              name: "openrouter/tool-model",
              params: {
                max_tokens: 4096,
                temperature: 0,
              },
            },
          },
          name: "blackbox-runtime-smoke",
        },
        path: "/api/v1/agents",
      },
    ]);
  });

  it("stops before provider I/O when configuration is cancelled", async () => {
    const cancellation = new Error("configuration cancelled");
    const controller = new AbortController();
    controller.abort(cancellation);
    let requests = 0;
    const client = new TrueForge({
      baseUrl: CONFIG.trueForge.baseUrl,
      fetch: async () => {
        requests += 1;
        throw new Error("provider request should not run");
      },
      maxRetries: 0,
    });

    const error = await configureTrueForge(
      client,
      CONFIG,
      controller.signal,
    ).catch((cause: unknown) => cause);

    expect(error).toBe(cancellation);
    expect(requests).toBe(0);
  });
});
