import { TrueForge } from "@truefoundry/trueforge-sdk";

import type { RuntimeConfig } from "../config.js";
import {
  createInvestigatorAgentManifest,
  createInvestigatorMcpManifest,
  INVESTIGATOR_AGENT_NAME,
  INVESTIGATOR_MCP_NAME,
} from "../investigation/definition.js";
import { configureTrueForge } from "./configure.js";

interface TrueForgeRequestOptions {
  abortSignal?: AbortSignal;
  maxRetries: 0;
}

export async function configureInvestigatorAgent(
  client: TrueForge,
  config: RuntimeConfig,
  mcpAuthorization: string,
  signal?: AbortSignal,
): Promise<typeof INVESTIGATOR_AGENT_NAME> {
  signal?.throwIfAborted();
  const requestOptions: TrueForgeRequestOptions = { maxRetries: 0 };
  if (signal !== undefined) requestOptions.abortSignal = signal;
  const prepared = await configureTrueForge(client, config, signal);
  const mcpUrl = `http://${config.blackbox.host}:${config.blackbox.port}/investigator-mcp`;
  await client.settings.mcpServers.createOrUpdate(
    {
      manifest: createInvestigatorMcpManifest(mcpUrl, mcpAuthorization),
    },
    requestOptions,
  );
  const connector = await client.settings.mcpServers.get(
    INVESTIGATOR_MCP_NAME,
    requestOptions,
  );
  if (
    connector.data.manifest.type !== "remote" ||
    connector.data.manifest.url !== mcpUrl
  ) {
    throw new Error(
      "TrueForge investigator MCP readback did not match configuration",
    );
  }

  const manifest = createInvestigatorAgentManifest(prepared.trueForgeModel);
  const agents = await client.agents.list(requestOptions);
  const existing = agents.data.find(
    (agent) => agent.name === INVESTIGATOR_AGENT_NAME,
  );
  if (existing === undefined) {
    await client.agents.create(
      { manifest, name: INVESTIGATOR_AGENT_NAME },
      requestOptions,
    );
  } else {
    await client.agents.update(existing.id, { manifest }, requestOptions);
  }
  return INVESTIGATOR_AGENT_NAME;
}
