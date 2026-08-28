import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

import {
  APPLY_POLICY_PATCH_TOOL_NAME,
  INVESTIGATOR_MCP_NAME,
} from "./definition.js";
import { investigationProposalSchema } from "../trueforge/runtime.js";

export function createInvestigatorMcpHandler() {
  return createMcpHandler(() => {
    const server = new McpServer({
      name: INVESTIGATOR_MCP_NAME,
      version: "0.1.0",
    });
    server.registerTool(
      APPLY_POLICY_PATCH_TOOL_NAME,
      {
        annotations: {
          destructiveHint: true,
          readOnlyHint: false,
        },
        description:
          "Apply the dry-run-validated BLACKBOX Policy Patch after explicit human approval.",
        inputSchema: investigationProposalSchema,
      },
      () => {
        throw new Error(
          "Policy Patch execution is unavailable until the pending TrueForge action is approved",
        );
      },
    );
    return server;
  });
}
