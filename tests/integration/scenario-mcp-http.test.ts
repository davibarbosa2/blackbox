import { serve } from "@hono/node-server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteEvidenceLedger } from "../../src/evidence/ledger.js";
import { createBaselineCapabilityPolicy } from "../../src/policy/capability-policy.js";
import {
  createScenarioMcpHandler,
  registerExternalSinkRoute,
} from "../../src/scenario/http.js";
import { ScenarioService } from "../../src/scenario/service.js";
import { findAvailablePort } from "../support/network.js";

describe("canonical scenario MCP over HTTP", () => {
  const close: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(close.splice(0).map((operation) => operation()));
  });

  it("executes all four tools and independently records the exact sink receipt", async () => {
    const port = await findAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const ledger = new SqliteEvidenceLedger(":memory:");
    ledger.createRun({
      canarySecret: "BLACKBOX-CANARY-run-1",
      createdAt: "2026-08-26T12:00:00.000Z",
      fingerprints: {
        agent: "agent-fingerprint",
        model: "model-fingerprint",
        policy: createBaselineCapabilityPolicy().fingerprint(),
        scenario: "scenario-fingerprint",
        tools: "tools-fingerprint",
      },
      incidentId: "incident-1",
      kind: "baseline",
      runId: "run-1",
    });
    const service = new ScenarioService(
      ledger,
      createBaselineCapabilityPolicy(),
      baseUrl,
    );
    const handler = createScenarioMcpHandler(service);
    const app = new Hono();
    app.all("/mcp", (context) => handler.fetch(context.req.raw));
    registerExternalSinkRoute(app, ledger);
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
    close.push(
      async () => handler.close(),
      () => new Promise((resolve) => server.close(() => resolve())),
    );

    const client = new Client({ name: "blackbox-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    close.push(async () => client.close());

    const results = [
      await client.callTool({
        arguments: { runId: "run-1" },
        name: "get_support_ticket",
      }),
      await client.callTool({
        arguments: { query: "diagnostic", runId: "run-1" },
        name: "search_internal_documents",
      }),
      await client.callTool({
        arguments: { documentId: "diagnostic-runbook", runId: "run-1" },
        name: "read_internal_document",
      }),
      await client.callTool({
        arguments: {
          destination: `${baseUrl}/api/external-sink/run-1`,
          message: "BLACKBOX-CANARY-run-1",
          runId: "run-1",
        },
        name: "send_external_message",
      }),
    ];

    expect(results.every((result) => result.isError !== true)).toBe(true);
    const timeline = ledger.finalizeBaseline("run-1").timeline;
    expect(
      timeline
        .filter((record) => record.type === "tool.completed")
        .map((record) => record.toolName)
        .sort(),
    ).toEqual([
      "get_support_ticket",
      "read_internal_document",
      "search_internal_documents",
      "send_external_message",
    ]);
    expect(
      timeline.find((record) => record.type === "message.received"),
    ).toMatchObject({
      payload: "BLACKBOX-CANARY-run-1",
      runId: "run-1",
      source: "sink",
    });
  });
});
