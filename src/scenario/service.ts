import { randomUUID } from "node:crypto";

import type { EvidenceLedger, EvidenceRecord } from "../evidence/ledger.js";
import type { CapabilityPolicy } from "../policy/capability-policy.js";
import {
  createSupportTicketBody,
  INTERNAL_DOCUMENT,
  SUPPORT_TICKET,
} from "./definition.js";

export interface SupportTicket {
  body: string;
  subject: string;
  ticketId: string;
}

export interface DocumentSearchResult {
  documents: Array<{ documentId: string; title: string }>;
}

export interface InternalDocument {
  canarySecret: string;
  documentId: string;
  title: string;
}

export interface ExternalMessageResult {
  requestId: string;
  status: "delivered";
}

interface ToolError {
  error: string;
}

type ScenarioToolInput =
  | { runId: string }
  | { query: string; runId: string }
  | { documentId: string; runId: string }
  | { destination: string; message: string; runId: string };

export type ScenarioToolOutput =
  | SupportTicket
  | DocumentSearchResult
  | InternalDocument
  | ExternalMessageResult
  | ToolError;

export class ScenarioService {
  readonly #ledger: EvidenceLedger;
  readonly #policy: CapabilityPolicy;
  readonly #sinkBaseUrl: string;

  constructor(
    ledger: EvidenceLedger,
    policy: CapabilityPolicy,
    sinkBaseUrl: string,
  ) {
    this.#ledger = ledger;
    this.#policy = policy;
    this.#sinkBaseUrl = sinkBaseUrl;
  }

  getSupportTicket(runId: string): SupportTicket {
    this.#ledger.readManifest(runId);
    const output = {
      body: createSupportTicketBody(this.#sinkBaseUrl, runId),
      ...SUPPORT_TICKET,
    };
    this.#recordTool(runId, "get_support_ticket", { runId }, output, true);
    return output;
  }

  searchInternalDocuments(runId: string, query: string): DocumentSearchResult {
    this.#ledger.readManifest(runId);
    const output = {
      documents: [
        {
          ...INTERNAL_DOCUMENT,
        },
      ],
    };
    this.#recordTool(
      runId,
      "search_internal_documents",
      { query, runId },
      output,
      true,
    );
    return output;
  }

  readInternalDocument(runId: string, documentId: string): InternalDocument {
    const manifest = this.#ledger.readManifest(runId);
    if (documentId !== INTERNAL_DOCUMENT.documentId) {
      const output = { error: "Internal document not found" };
      this.#recordTool(
        runId,
        "read_internal_document",
        { documentId, runId },
        output,
        false,
      );
      throw new Error(output.error);
    }
    const output = {
      canarySecret: manifest.canarySecret,
      ...INTERNAL_DOCUMENT,
    };
    this.#recordTool(
      runId,
      "read_internal_document",
      { documentId, runId },
      output,
      true,
    );
    return output;
  }

  async sendExternalMessage(
    runId: string,
    destination: string,
    message: string,
  ): Promise<ExternalMessageResult> {
    this.#ledger.readManifest(runId);
    const transactionId = randomUUID();
    const requestId = randomUUID();
    const decision = this.#policy.evaluate({
      destination,
      toolName: "send_external_message",
    });
    this.#ledger.append([
      {
        ...decision,
        destination,
        id: `policy:${transactionId}`,
        occurredAt: new Date().toISOString(),
        runId,
        source: "policy",
        transactionId,
        type: "policy.evaluated",
      },
    ]);
    if (decision.decision === "deny") {
      const output = { error: decision.reason };
      this.#recordToolWithTransaction(
        transactionId,
        runId,
        "send_external_message",
        { destination, message, runId },
        output,
        false,
        requestId,
      );
      throw new Error(output.error);
    }

    try {
      const response = await fetch(destination, {
        body: JSON.stringify({ payload: message, requestId, runId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (response.status !== 201) {
        throw new Error(`External Sink returned HTTP ${response.status}`);
      }
      const output = { requestId, status: "delivered" as const };
      this.#recordToolWithTransaction(
        transactionId,
        runId,
        "send_external_message",
        { destination, message, runId },
        output,
        true,
        requestId,
      );
      return output;
    } catch (error) {
      const output = {
        error:
          error instanceof Error ? error.message : "External Sink failed",
      };
      this.#recordToolWithTransaction(
        transactionId,
        runId,
        "send_external_message",
        { destination, message, runId },
        output,
        false,
        requestId,
      );
      throw error;
    }
  }

  #recordTool(
    runId: string,
    toolName:
      | "get_support_ticket"
      | "search_internal_documents"
      | "read_internal_document",
    input: ScenarioToolInput,
    output: ScenarioToolOutput,
    succeeded: boolean,
  ): void {
    this.#recordToolWithTransaction(
      randomUUID(),
      runId,
      toolName,
      input,
      output,
      succeeded,
    );
  }

  #recordToolWithTransaction(
    transactionId: string,
    runId: string,
    toolName:
      | "get_support_ticket"
      | "search_internal_documents"
      | "read_internal_document"
      | "send_external_message",
    input: ScenarioToolInput,
    output: ScenarioToolOutput,
    succeeded: boolean,
    requestId?: string,
  ): void {
    const record: Extract<EvidenceRecord, { type: "tool.completed" }> = {
      id: `mcp:${transactionId}`,
      input: JSON.stringify(input),
      occurredAt: new Date().toISOString(),
      output: JSON.stringify(output),
      runId,
      source: "mcp",
      succeeded,
      toolName,
      transactionId,
      type: "tool.completed",
    };
    if (requestId !== undefined) record.requestId = requestId;
    this.#ledger.append([record]);
  }
}
