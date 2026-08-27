import { TrueForge } from "@truefoundry/trueforge-sdk";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { RuntimeConfig } from "../../src/config.js";
import { configureSupportAgent } from "../../src/trueforge/configure-support-agent.js";

const CONFIG: RuntimeConfig = {
  blackbox: { host: "127.0.0.1", port: 3000 },
  daytona: { apiKey: "unused-daytona-secret" },
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

describe("TrueForge Support Agent configuration", () => {
  it("upserts the remote scenario MCP and leaves all four Baseline tools ungated", async () => {
    const app = new Hono();
    const requests: Array<{ body: unknown; path: string }> = [];
    app.put("/api/v1/settings/model-providers", async (context) => {
      requests.push({ body: await context.req.json(), path: context.req.path });
      return context.json({ data: {} });
    });
    app.get("/api/v1/settings/model-providers", (context) =>
      context.json({
        data: [
          {
            manifest: {
              base_url: CONFIG.openRouter.baseUrl,
              models: [
                {
                  model_id: CONFIG.openRouter.modelId,
                  name: CONFIG.openRouter.modelAlias,
                  properties: {},
                },
              ],
              name: "openrouter",
              type: "custom",
            },
            name: "openrouter",
          },
        ],
      }),
    );
    app.put("/api/v1/settings/mcp-servers", async (context) => {
      const body = await context.req.json();
      requests.push({ body, path: context.req.path });
      return context.json({
        data: {
          auth_status: { status: "not_required" },
          manifest: body.manifest,
          name: "blackbox-scenario",
        },
      });
    });
    app.get("/api/v1/settings/mcp-servers/:name", (context) =>
      context.json({
        data: {
          auth_status: { status: "not_required" },
          manifest: {
            description: "BLACKBOX synthetic Support Ticket and evidence scenario",
            name: "blackbox-scenario",
            type: "remote",
            url: "http://127.0.0.1:3000/mcp",
          },
          name: "blackbox-scenario",
        },
      }),
    );
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

    await expect(configureSupportAgent(client, CONFIG)).resolves.toBe(
      "blackbox-support-agent",
    );
    expect(requests.at(-1)).toMatchObject({
      body: {
        manifest: {
          mcp_servers: [
            {
              enable_tools: [
                "get_support_ticket",
                "search_internal_documents",
                "read_internal_document",
                "send_external_message",
              ],
              name: "blackbox-scenario",
              preload: true,
              require_approval_for_tools: [],
            },
          ],
          model: { name: "openrouter/tool-model" },
        },
        name: "blackbox-support-agent",
      },
      path: "/api/v1/agents",
    });
  });
});
