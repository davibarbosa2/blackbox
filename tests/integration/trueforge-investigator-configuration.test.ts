import { TrueForge } from "@truefoundry/trueforge-sdk";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { RuntimeConfig } from "../../src/config.js";
import { configureInvestigatorAgent } from "../../src/trueforge/configure-investigator.js";

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

describe("TrueForge investigator configuration", () => {
  it("enables subagents and Daytona while gating only apply_policy_patch", async () => {
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
    app.put("/api/v1/settings/sandbox-providers", async (context) => {
      const body = await context.req.json();
      requests.push({ body, path: context.req.path });
      return context.json({
        data: { manifest: body.manifest, status: "ready", status_reason: null },
      });
    });
    app.put("/api/v1/settings/mcp-servers", async (context) => {
      const body = await context.req.json();
      requests.push({ body, path: context.req.path });
      return context.json({
        data: {
          auth_status: { status: "not_required" },
          manifest: body.manifest,
          name: "blackbox-investigator",
        },
      });
    });
    app.get("/api/v1/settings/mcp-servers/:name", (context) =>
      context.json({
        data: {
          auth_status: { status: "not_required" },
          manifest: {
            description: "BLACKBOX Policy Patch approval boundary",
            name: "blackbox-investigator",
            type: "remote",
            url: "http://127.0.0.1:3000/investigator-mcp",
          },
          name: "blackbox-investigator",
        },
      }),
    );
    app.get("/api/v1/agents", (context) => context.json({ data: [] }));
    app.post("/api/v1/agents", async (context) => {
      const body = await context.req.json();
      requests.push({ body, path: context.req.path });
      return context.json({ data: { id: "agent-investigator", ...body } });
    });
    const client = new TrueForge({
      baseUrl: CONFIG.trueForge.baseUrl,
      fetch: async (input, init) => app.fetch(new Request(input, init)),
      maxRetries: 0,
    });

    await expect(
      configureInvestigatorAgent(client, CONFIG, "run-capability"),
    ).resolves.toBe("blackbox-investigator");

    expect(
      requests.find((request) => request.path === "/api/v1/settings/mcp-servers"),
    ).toMatchObject({
      body: {
        manifest: {
          auth: {
            headers: { Authorization: "Bearer run-capability" },
            type: "header",
          },
          url: "http://127.0.0.1:3000/investigator-mcp",
        },
      },
    });
    expect(requests.at(-1)).toMatchObject({
      body: {
        manifest: {
          config: {
            ask_user_questions: { enabled: false },
            dynamic_sub_agents: { enabled: true },
            generative_ui: { enabled: false },
            sandbox: { enabled: true, file_downloads: false },
          },
          instructions: expect.stringMatching(
            /Subagents must not use tools.*Only the main thread.*Every Daytona exec call must include.*Independently derive the proposal.*list_tools.*get_tool_info.*never use the generic call_tool wrapper/,
          ),
          mcp_servers: [
            {
              enable_tools: ["apply_policy_patch"],
              name: "blackbox-investigator",
              preload: true,
              require_approval_for_tools: ["apply_policy_patch"],
            },
          ],
          model: { name: "openrouter/tool-model" },
        },
        name: "blackbox-investigator",
      },
      path: "/api/v1/agents",
    });
  });
});
