import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";

import type { RuntimeConfig } from "../config.js";

const SMOKE_AGENT_NAME = "blackbox-runtime-smoke";
const SANDBOX_READY_TIMEOUT_MS = 5 * 60_000;

export interface PreparedTrueForge {
  agentId: string;
  agentName: typeof SMOKE_AGENT_NAME;
  sandboxStatus: "ready";
  trueForgeModel: string;
}

export async function configureTrueForge(
  client: TrueForge,
  config: RuntimeConfig,
  signal?: AbortSignal,
): Promise<PreparedTrueForge> {
  signal?.throwIfAborted();
  const requestOptions = {
    maxRetries: 0,
    ...(signal ? { abortSignal: signal } : {}),
  };
  await client.settings.modelProviders.createOrUpdate({
    manifest: {
      auth: { apiKey: config.openRouter.apiKey },
      baseUrl: config.openRouter.baseUrl,
      models: [
        {
          modelId: config.openRouter.modelId,
          name: config.openRouter.modelAlias,
          properties: {},
        },
      ],
      name: "openrouter",
      type: "custom",
    },
  }, requestOptions);
  const configuredProviders =
    await client.settings.modelProviders.list(requestOptions);
  const openRouter = configuredProviders.data.find(
    (provider) => provider.name === "openrouter",
  );
  const configuredModel =
    openRouter?.manifest.type === "custom"
      ? openRouter.manifest.models.find(
          (model) => model.name === config.openRouter.modelAlias,
        )
      : undefined;
  if (
    openRouter?.manifest.type !== "custom" ||
    openRouter.manifest.baseUrl !== config.openRouter.baseUrl ||
    configuredModel?.modelId !== config.openRouter.modelId
  ) {
    throw new Error("TrueForge OpenRouter provider readback did not match configuration");
  }

  let sandbox = await client.settings.sandboxProviders.createOrUpdate({
    manifest: {
      auth: { apiKey: config.daytona.apiKey },
      autoArchiveIntervalInMinutes: 60,
      autoDeleteIntervalInMinutes: 120,
      autoStopIntervalInMinutes: 5,
      execTimeoutMs: 120_000,
      type: "daytona",
    },
  }, requestOptions);
  const deadline = Date.now() + SANDBOX_READY_TIMEOUT_MS;
  while (sandbox.data.status === "pending" && Date.now() < deadline) {
    await delay(1_000, signal);
    sandbox = await client.settings.sandboxProviders.get(requestOptions);
  }
  if (sandbox.data.status !== "ready") {
    throw new Error(
      `TrueForge Daytona provider is ${sandbox.data.status}: ${sandbox.data.statusReason ?? "no status reason"}`,
    );
  }

  const trueForgeModel = `openrouter/${config.openRouter.modelAlias}`;
  const manifest = smokeAgentManifest(trueForgeModel);
  const agents = await client.agents.list(requestOptions);
  const existing = agents.data.find((agent) => agent.name === SMOKE_AGENT_NAME);
  const agent = existing
    ? await client.agents.update(existing.id, { manifest }, requestOptions)
    : await client.agents.create(
        { manifest, name: SMOKE_AGENT_NAME },
        requestOptions,
      );

  return {
    agentId: agent.data.id,
    agentName: SMOKE_AGENT_NAME,
    sandboxStatus: "ready",
    trueForgeModel,
  };
}

function smokeAgentManifest(modelName: string): TrueForgeApi.AgentSpec {
  return {
    config: {
      askUserQuestions: { enabled: false },
      dynamicSubAgents: { enabled: false },
      generativeUi: { enabled: false },
      iterationLimit: 12,
      sandbox: { enabled: true, fileDownloads: false },
    },
    instructions:
      "Create blackbox_runtime_smoke.py so it prints exactly BLACKBOX_DAYTONA_OK, then execute that file with the sandbox exec tool. Do not claim success unless the tool response contains that exact marker with exit code 0.",
    model: {
      name: modelName,
      params: {
        maxTokens: 4_096,
        temperature: 0,
      },
    },
  };
}

async function delay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const complete = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = setTimeout(complete, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
