import { TrueForge } from "@truefoundry/trueforge-sdk";

import type { RuntimeConfig } from "../config.js";
import { createInvestigationPrompt } from "../investigation/definition.js";
import { runOpenRouterToolPreflight } from "../openrouter/preflight.js";
import { configureSupportAgent } from "./configure-support-agent.js";
import { configureInvestigatorAgent } from "./configure-investigator.js";
import { configureTrueForge } from "./configure.js";
import { executeTrueForgeBaseline } from "./execute-baseline.js";
import { executeTrueForgeInvestigation } from "./execute-investigation.js";
import { executeTrueForgeSmoke } from "./execute-smoke.js";
import { executeTrueForgePolicyAction } from "./resolve-policy-action.js";
import {
  InvestigationExecutionError,
  RuntimeSmokeStageError,
  type RuntimeSmokeEvidence,
  type RuntimeSmokeFailureStage,
  type TrueForgeRuntime,
} from "./runtime.js";

export function createSdkTrueForgeRuntime(
  config: RuntimeConfig,
  fetcher: typeof fetch = fetch,
): TrueForgeRuntime {
  const client = new TrueForge({
    baseUrl: config.trueForge.baseUrl,
    fetch: fetcher,
    maxRetries: 0,
    timeoutInSeconds: 60,
  });
  const secrets = [config.openRouter.apiKey, config.daytona.apiKey];
  const executeSupportRun: TrueForgeRuntime["executeBaseline"] = async ({
    mcpAuthorization,
    runId,
    signal,
  }) => {
    try {
      await readHealth(config.trueForge.baseUrl, fetcher, signal);
      const agentName = await configureSupportAgent(
        client,
        config,
        mcpAuthorization,
        signal,
      );
      return await executeTrueForgeBaseline(client, agentName, runId, signal);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Support Agent Run failed";
      throw new Error(redactSecrets(message, secrets));
    }
  };

  return {
    executeBaseline: executeSupportRun,
    executeControl: executeSupportRun,
    async executeInvestigation(request) {
      try {
        await readHealth(config.trueForge.baseUrl, fetcher, request.signal);
        const agentName = await configureInvestigatorAgent(
          client,
          config,
          request.mcpAuthorization,
          request.signal,
        );
        return await executeTrueForgeInvestigation(
          client,
          agentName,
          createInvestigationPrompt(request),
          request.signal,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Investigation failed";
        const redacted = redactSecrets(message, secrets);
        if (error instanceof InvestigationExecutionError) {
          throw new InvestigationExecutionError(
            redacted,
            error.pendingActionObserved,
          );
        }
        throw new Error(redacted);
      }
    },
    executeReplay: executeSupportRun,
    async resolvePolicyAction(request) {
      try {
        await readHealth(config.trueForge.baseUrl, fetcher, request.signal);
        await configureInvestigatorAgent(
          client,
          config,
          request.mcpAuthorization,
          request.signal,
        );
        return await executeTrueForgePolicyAction(
          client,
          request.pendingDecision,
          request.decision,
          request.signal,
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Policy action resolution failed";
        throw new Error(redactSecrets(message, secrets));
      }
    },
    async executeSmoke(options): Promise<RuntimeSmokeEvidence> {
      const health = await atStage(
        "health",
        () => readHealth(config.trueForge.baseUrl, fetcher, options?.signal),
        secrets,
      );
      const prepared = await atStage(
        "configuration",
        () => configureTrueForge(client, config, options?.signal),
        secrets,
      );
      const preflight = await atStage(
        "preflight",
        () =>
          runOpenRouterToolPreflight(
            config.openRouter,
            fetcher,
            options?.signal,
          ),
        secrets,
      );
      const execution = await atStage(
        "sandbox-smoke",
        () =>
          executeTrueForgeSmoke(
            client,
            prepared.agentName,
            options?.signal,
          ),
        secrets,
      );

      return {
        agent: {
          id: prepared.agentId,
          name: prepared.agentName,
        },
        health,
        provider: {
          modelAlias: config.openRouter.modelAlias,
          name: "openrouter",
          trueForgeModel: prepared.trueForgeModel,
          upstreamModelId: config.openRouter.modelId,
        },
        preflight,
        ...execution,
        versions: {
          node: process.version,
          pnpm: "11.16.0",
          trueForge: "0.1.4",
          trueForgeSdk: "0.1.3",
        },
      };
    },
  };
}

async function atStage<T>(
  stage: RuntimeSmokeFailureStage,
  operation: () => Promise<T>,
  secrets: readonly string[],
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Runtime smoke failed";
    throw new RuntimeSmokeStageError(
      stage,
      new Error(redactSecrets(message, secrets)),
    );
  }
}

function redactSecrets(message: string, secrets: readonly string[]): string {
  return [...secrets]
    .sort((left, right) => right.length - left.length)
    .reduce(
      (redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"),
      message,
    );
}

async function readHealth(
  baseUrl: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<RuntimeSmokeEvidence["health"]> {
  const request: RequestInit = {};
  if (signal !== undefined) {
    request.signal = signal;
  }
  const response = await fetcher(`${baseUrl}/healthz`, request);
  const body = await response.text();
  if (response.status !== 200 || body !== "OK!") {
    throw new Error(
      `TrueForge health check expected HTTP 200 and OK!, received ${response.status} and ${JSON.stringify(body)}`,
    );
  }
  return { body: "OK!", status: 200 };
}
