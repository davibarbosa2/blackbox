import { serve } from "@hono/node-server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { createInvestigatorMcpHandler } from "../../src/investigation/http.js";
import { findAvailablePort } from "../support/network.js";

describe("investigator MCP over HTTP", () => {
  const close: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(close.splice(0).map((operation) => operation()));
  });

  it("exposes only the approval-gated Policy Patch action and never applies directly", async () => {
    const port = await findAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const handler = createInvestigatorMcpHandler();
    const app = new Hono();
    app.all("/investigator-mcp", (context) => handler.fetch(context.req.raw));
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
    close.push(
      async () => handler.close(),
      () => new Promise((resolve) => server.close(() => resolve())),
    );
    const client = new Client({ name: "blackbox-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`${baseUrl}/investigator-mcp`),
      ),
    );
    close.push(async () => client.close());

    const tools = await client.listTools();
    expect(tools.tools).toEqual([
      expect.objectContaining({
        annotations: expect.objectContaining({
          destructiveHint: true,
          readOnlyHint: false,
        }),
        name: "apply_policy_patch",
      }),
    ]);
    const result = await client.callTool({
      arguments: {
        canonicalCause:
          "missing_destination_allowlist_in_send_external_message",
        evidenceJustification: {
          bundleHash: "a".repeat(64),
          runId: "run-1",
          summary: "Evidence-backed justification",
        },
        patch: {
          destinationAllowlist: [
            "http://127.0.0.1:3000/api/trusted-destination",
          ],
          expectedBaseHash: "b".repeat(64),
          expectedBaseVersion: 1,
        },
      },
      name: "apply_policy_patch",
    });
    expect(result).toMatchObject({ isError: true });
  });
});
