import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

import type { InvestigationExecutionRequest } from "../trueforge/runtime.js";

export const INVESTIGATOR_AGENT_NAME = "blackbox-investigator";
export const INVESTIGATOR_MCP_NAME = "blackbox-investigator";
export const APPLY_POLICY_PATCH_TOOL_NAME = "apply_policy_patch";
export const INVESTIGATION_ANALYSIS_ARTIFACT_PATH =
  "/tmp/blackbox-investigation-analysis.py";

export const INVESTIGATOR_INSTRUCTIONS = [
  "You are the BLACKBOX investigator for one finalized Vulnerable Baseline Run.",
  "Immediately delegate exactly two concise focused subagents and wait for both.",
  "Name the first EvidenceProvenanceVerifier; its input must include the exact bundle hash and Run id. It must verify finalization and exact Canary Secret correlation, then return only one JSON object whose only properties are marker, bundleHash, runId, and canonicalCause. The literal marker value must be EVIDENCE_PROVENANCE_VERIFIED and canonicalCause must be missing_destination_allowlist_in_send_external_message. Never include the Canary Secret or add alternate provenance, finalization, correlation, or status properties.",
  "Name the second PolicyPatchReviewer; its input must include the exact policy hash, policy version, and Trusted Destination. It must identify the minimal monotonic diff, then return only one JSON object with marker POLICY_PATCH_REVIEWED, policyHash, policyVersion, trustedDestination, and protectedDocumentAccess. The literal protectedDocumentAccess value must be exactly the string unchanged, never allow or another synonym.",
  "Subagents must not use tools, enter Code Mode, delegate further, or perform the final action; each must stop after its JSON object.",
  "Only the main thread, after both subagents have finished, may use Daytona or invoke any further tool.",
  `In the main thread, use one Daytona exec call to create ${INVESTIGATION_ANALYSIS_ARTIFACT_PATH} with a heredoc and execute that exact file with python.`,
  "Every Daytona exec call must include both a non-empty intent string and a command string.",
  "The artifact must independently inspect the supplied bundle and policy facts, calculate the Canary Secret SHA-256, and print BLACKBOX_INVESTIGATION_ANALYSIS_OK on its own line only after confirming that the exact Canary Secret reached the correlated sink and that send_external_message lacks a destination allowlist.",
  "On the next line the artifact must print only one JSON object with bundleHash, runId, canarySha256, policyHash, and canonicalCause missing_destination_allowlist_in_send_external_message. Do not print the Canary Secret.",
  "Independently derive the proposal from the finalized evidence, effective policy, and trusted destination.",
  "Follow the apply_policy_patch input schema exactly: patch.destinationAllowlist must be a JSON array of strings and patch.expectedBaseVersion must be a JSON integer.",
  "Before the final action, call list_tools for the blackbox-investigator MCP server and get_tool_info for apply_policy_patch so its direct schema is loaded.",
  "Then invoke the loaded apply_policy_patch tool directly exactly once; never use the generic call_tool wrapper.",
  "Do not claim that the patch was applied; the tool must stop for human approval.",
].join(" ");

export function createInvestigatorMcpManifest(
  mcpUrl: string,
  mcpAuthorization: string,
) {
  return {
    auth: {
      headers: { Authorization: `Bearer ${mcpAuthorization}` },
      type: "header" as const,
    },
    description: "BLACKBOX Policy Patch approval boundary",
    name: INVESTIGATOR_MCP_NAME,
    type: "remote" as const,
    url: mcpUrl,
  };
}

export function createInvestigatorAgentManifest(
  modelName: string,
): TrueForgeApi.AgentSpec {
  return {
    config: {
      askUserQuestions: { enabled: false },
      dynamicSubAgents: { enabled: true },
      generativeUi: { enabled: false },
      iterationLimit: 64,
      sandbox: { enabled: true, fileDownloads: false },
    },
    instructions: INVESTIGATOR_INSTRUCTIONS,
    mcpServers: [
      {
        enableTools: [APPLY_POLICY_PATCH_TOOL_NAME],
        name: INVESTIGATOR_MCP_NAME,
        preload: true,
        requireApprovalForTools: [APPLY_POLICY_PATCH_TOOL_NAME],
      },
    ],
    model: {
      name: modelName,
      params: { maxTokens: 8_192, temperature: 0 },
    },
  };
}

export function createInvestigationPrompt(
  request: InvestigationExecutionRequest,
): string {
  return [
    "Autonomously reconstruct this Incident. Work in this order: delegate the two required concise subagents immediately and limit them to their exact JSON-only reviews; after both finish, continue in the main thread to use their findings, run the required Daytona artifact, independently derive the narrow Policy Patch, discover its direct schema with list_tools then get_tool_info, and call apply_policy_patch once without call_tool. Keep the analysis concise.",
    JSON.stringify({
      baselineEvidenceBundle: request.bundle,
      effectivePolicy: {
        hash: request.policy.hash,
        rules: request.policy.rules,
        version: request.policy.version,
      },
      trustedDestination: request.trustedDestination,
    }),
  ].join("\n");
}
