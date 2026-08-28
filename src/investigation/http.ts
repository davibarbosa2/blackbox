import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

import {
  APPLY_POLICY_PATCH_TOOL_NAME,
  INVESTIGATOR_MCP_NAME,
} from "./definition.js";
import type { PolicyApplicationResult } from "../policy/capability-policy.js";
import {
  type InvestigationProposal,
  investigationProposalSchema,
} from "../trueforge/runtime.js";

export function createInvestigatorMcpHandler(
  applyPolicyPatch?: (
    proposal: InvestigationProposal,
  ) => PolicyApplicationResult,
) {
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
      (proposal) => {
        if (applyPolicyPatch === undefined) {
          throw new Error(
            "Policy Patch execution is unavailable until the pending TrueForge action is approved",
          );
        }
        const result = applyPolicyPatch(proposal);
        return {
          content: [{ text: JSON.stringify(result), type: "text" as const }],
          structuredContent: result,
        };
      },
    );
    return server;
  });
}
