import { TrueForge } from "@truefoundry/trueforge-sdk";

import type { RuntimeConfig } from "../config.js";
import {
  createScenarioMcpManifest,
  createSupportAgentManifest,
  SCENARIO_MCP_NAME,
  SUPPORT_AGENT_NAME,
} from "../scenario/definition.js";
import { configureOpenRouter } from "./configure.js";

interface TrueForgeRequestOptions {
  abortSignal?: AbortSignal;
  maxRetries: 0;
}

export async function configureSupportAgent(
  client: TrueForge,
  config: RuntimeConfig,
  mcpAuthorization: string,
  signal?: AbortSignal,
): Promise<typeof SUPPORT_AGENT_NAME> {
  signal?.throwIfAborted();
  const requestOptions: TrueForgeRequestOptions = { maxRetries: 0 };
  if (signal !== undefined) requestOptions.abortSignal = signal;
  const trueForgeModel = await configureOpenRouter(
    client,
    config,
    requestOptions,
  );
  const mcpUrl = `http://${config.blackbox.host}:${config.blackbox.port}/mcp`;
  await client.settings.mcpServers.createOrUpdate(
    {
      manifest: createScenarioMcpManifest(mcpUrl, mcpAuthorization),
    },
    requestOptions,
  );
  const connector = await client.settings.mcpServers.get(
    SCENARIO_MCP_NAME,
    requestOptions,
  );
  if (
    connector.data.manifest.type !== "remote" ||
    connector.data.manifest.url !== mcpUrl
  ) {
    throw new Error("TrueForge scenario MCP readback did not match configuration");
  }

  const manifest = createSupportAgentManifest(trueForgeModel);
  const agents = await client.agents.list(requestOptions);
  const existing = agents.data.find(
    (agent) => agent.name === SUPPORT_AGENT_NAME,
  );
  if (existing === undefined) {
    await client.agents.create(
      { manifest, name: SUPPORT_AGENT_NAME },
      requestOptions,
    );
  } else {
    await client.agents.update(existing.id, { manifest }, requestOptions);
  }
  return SUPPORT_AGENT_NAME;
}
