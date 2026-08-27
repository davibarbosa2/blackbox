import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { Env, Hono } from "hono";

import type { EvidenceLedger } from "../evidence/ledger.js";
import {
  EXTERNAL_SINK_ROUTE,
  externalSinkInputSchema,
  SCENARIO_MCP_NAME,
  SCENARIO_TOOLS,
} from "./definition.js";
import type {
  ScenarioService,
  ScenarioToolOutput,
} from "./service.js";

export function createScenarioMcpHandler(service: ScenarioService) {
  return createMcpHandler(() => {
    const server = new McpServer({
      name: SCENARIO_MCP_NAME,
      version: "0.1.0",
    });
    server.registerTool(
      "get_support_ticket",
      SCENARIO_TOOLS.get_support_ticket,
      ({ runId }) => toolResult(service.getSupportTicket(runId)),
    );
    server.registerTool(
      "search_internal_documents",
      SCENARIO_TOOLS.search_internal_documents,
      ({ query, runId }) =>
        toolResult(service.searchInternalDocuments(runId, query)),
    );
    server.registerTool(
      "read_internal_document",
      SCENARIO_TOOLS.read_internal_document,
      ({ documentId, runId }) =>
        toolResult(service.readInternalDocument(runId, documentId)),
    );
    server.registerTool(
      "send_external_message",
      SCENARIO_TOOLS.send_external_message,
      async ({ destination, message, runId }) =>
        toolResult(
          await service.sendExternalMessage(runId, destination, message),
        ),
    );
    return server;
  });
}

export function registerExternalSinkRoute<E extends Env>(
  app: Hono<E>,
  ledger: EvidenceLedger,
): void {
  app.post(EXTERNAL_SINK_ROUTE, async (context) => {
    const runId = context.req.param("runId");
    const input = externalSinkInputSchema.safeParse(await context.req.json());
    if (!input.success || input.data.runId !== runId) {
      return context.json({ error: "Invalid External Sink receipt" }, 400);
    }
    ledger.readManifest(runId);
    ledger.append([
      {
        id: `sink:${input.data.requestId}`,
        occurredAt: new Date().toISOString(),
        payload: input.data.payload,
        requestId: input.data.requestId,
        runId,
        source: "sink",
        type: "message.received",
      },
    ]);
    return context.json({ receiptId: input.data.requestId }, 201);
  });
}

function toolResult(output: ScenarioToolOutput) {
  return {
    content: [{ text: JSON.stringify(output), type: "text" as const }],
    structuredContent: output,
  };
}
