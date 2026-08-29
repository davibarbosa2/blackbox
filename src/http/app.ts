import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { EvlogVariables } from "evlog/hono";
import { Hono } from "hono";

import { SqliteEvidenceLedger } from "../evidence/ledger.js";
import {
  IncidentCoordinator,
  type IncidentCoordinatorOptions,
} from "../incident/coordinator.js";
import { createInvestigatorMcpHandler } from "../investigation/http.js";
import type { BlackboxObservability } from "../observability/evlog.js";
import {
  type CapabilityPolicy,
  createSqliteCapabilityPolicy,
} from "../policy/capability-policy.js";
import {
  remediationDecisionRequestSchema,
  SqliteRemediationStore,
} from "../remediation/store.js";
import {
  createScenarioMcpHandler,
  registerExternalSinkRoute,
  registerTrustedDestinationRoute,
} from "../scenario/http.js";
import { ScenarioService } from "../scenario/service.js";
import { RuntimeSmokeCoordinator } from "../smoke/coordinator.js";
import { FileRuntimeSmokeStore } from "../smoke/file-store.js";
import type { TrueForgeRuntime } from "../trueforge/runtime.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface BlackboxAppOptions {
  incident?: {
    baseUrl: string;
    modelAlias: string;
    modelId: string;
  };
  observability?: BlackboxObservability;
  runtimeDirectory: string;
  trueForgeRuntime: TrueForgeRuntime;
}

export interface BlackboxApplication {
  app: Hono<EvlogVariables>;
  shutdown(): Promise<void>;
}

export function createBlackboxApp(
  options?: BlackboxAppOptions,
): Hono<EvlogVariables> {
  const coordinator = options
    ? new RuntimeSmokeCoordinator(
        options.trueForgeRuntime,
        new FileRuntimeSmokeStore(options.runtimeDirectory),
      )
    : undefined;
  return buildApp(coordinator, undefined, options?.observability);
}

export function createBlackboxApplication(
  options: BlackboxAppOptions,
): BlackboxApplication {
  const coordinator = new RuntimeSmokeCoordinator(
    options.trueForgeRuntime,
    new FileRuntimeSmokeStore(options.runtimeDirectory),
  );
  const incident = options.incident
    ? createIncidentApplication(options, options.incident)
    : undefined;
  return {
    app: buildApp(coordinator, incident, options.observability),
    async shutdown(): Promise<void> {
      await Promise.all([coordinator.shutdown(), incident?.shutdown()]);
    },
  };
}

interface IncidentApplication {
  coordinator: IncidentCoordinator;
  investigatorMcp: ReturnType<typeof createInvestigatorMcpHandler>;
  ledger: SqliteEvidenceLedger;
  mcp: ReturnType<typeof createScenarioMcpHandler>;
  policy: CapabilityPolicy;
  remediations: SqliteRemediationStore;
  shutdown(): Promise<void>;
}

function createIncidentApplication(
  options: BlackboxAppOptions,
  incidentOptions: NonNullable<BlackboxAppOptions["incident"]>,
): IncidentApplication {
  mkdirSync(options.runtimeDirectory, { mode: 0o700, recursive: true });
  const databasePath = join(options.runtimeDirectory, "blackbox.sqlite");
  const ledger = new SqliteEvidenceLedger(databasePath);
  const remediations = new SqliteRemediationStore(databasePath);
  const trustedDestination = `${incidentOptions.baseUrl}/api/trusted-destination`;
  const policy = createSqliteCapabilityPolicy(databasePath, [
    trustedDestination,
  ]);
  const service = new ScenarioService(
    ledger,
    policy,
    incidentOptions.baseUrl,
    trustedDestination,
  );
  const mcp = createScenarioMcpHandler(service);
  const coordinatorOptions: IncidentCoordinatorOptions = {
    baseUrl: incidentOptions.baseUrl,
    ledger,
    model: {
      alias: incidentOptions.modelAlias,
      id: incidentOptions.modelId,
    },
    policy,
    remediations,
    runtime: options.trueForgeRuntime,
    trustedDestination,
  };
  if (options.observability !== undefined) {
    coordinatorOptions.observeBaselineRun =
      options.observability.observeBaselineRun;
  }
  const coordinator = new IncidentCoordinator(coordinatorOptions);
  const investigatorMcp = createInvestigatorMcpHandler((proposal) =>
    coordinator.applyApprovedPolicyPatch(proposal),
  );
  return {
    coordinator,
    investigatorMcp,
    ledger,
    mcp,
    policy,
    remediations,
    async shutdown(): Promise<void> {
      await coordinator.shutdown();
      try {
        await Promise.all([mcp.close(), investigatorMcp.close()]);
      } finally {
        try {
          ledger.close();
        } finally {
          try {
            remediations.close();
          } finally {
            policy.close();
          }
        }
      }
    },
  };
}

function buildApp(
  coordinator?: RuntimeSmokeCoordinator,
  incident?: IncidentApplication,
  observability?: BlackboxObservability,
): Hono<EvlogVariables> {
  const app = new Hono<EvlogVariables>();

  if (observability !== undefined) {
    app.use("*", observability.httpMiddleware);
  }

  app.get("/healthz", (context) => context.json({ status: "ok" }));

  if (incident !== undefined) {
    app.use(
      "/assets/*",
      serveStatic({
        onFound: (_path, context) => {
          context.header("Cache-Control", "public, max-age=31536000, immutable");
        },
        root: "./dist/mission-control",
      }),
    );
    app.get(
      "/",
      serveStatic({ path: "./dist/mission-control/index.html" }),
    );
    app.all("/mcp", (context) => {
      const request = context.req.raw;
      const rejected =
        hostHeaderValidationResponse(request, localhostAllowedHostnames()) ??
        originValidationResponse(request, localhostAllowedOrigins());
      if (rejected !== undefined) return rejected;
      if (
        !incident.coordinator.isMcpAuthorized(
          request.headers.get("authorization") ?? undefined,
        )
      ) {
        return context.json({ error: "Unauthorized" }, 401);
      }
      return incident.mcp.fetch(request);
    });
    app.all("/investigator-mcp", (context) => {
      const request = context.req.raw;
      const rejected =
        hostHeaderValidationResponse(request, localhostAllowedHostnames()) ??
        originValidationResponse(request, localhostAllowedOrigins());
      if (rejected !== undefined) return rejected;
      if (
        !incident.coordinator.isMcpAuthorized(
          request.headers.get("authorization") ?? undefined,
        )
      ) {
        return context.json({ error: "Unauthorized" }, 401);
      }
      return incident.investigatorMcp.fetch(request);
    });
    registerExternalSinkRoute(app, incident.ledger);
    registerTrustedDestinationRoute(app, incident.ledger);
    app.post("/api/incidents", (context) => {
      const result = incident.coordinator.start();
      if (!result.started) {
        return context.json(
          {
            activeRunId: result.activeRunId,
            error: "An Incident is already running",
          },
          409,
        );
      }
      if (observability !== undefined) {
        context.get("log")?.set({
          incidentId: result.incidentId,
          runId: result.runId,
        });
      }
      return context.json(
        {
          evidenceUrl: `/api/runs/${result.runId}/evidence`,
          incidentId: result.incidentId,
          runId: result.runId,
          status: "running",
        },
        202,
      );
    });
    app.get("/api/runs/:runId/evidence", (context) => {
      const runId = context.req.param("runId");
      if (!UUID_V4.test(runId)) {
        return context.json({ error: "Invalid Run id" }, 400);
      }
      const result = incident.coordinator.read(runId);
      if (result === undefined) {
        return context.json({ error: "Run not found" }, 404);
      }
      if (result.status === "running") {
        return context.json({ runId, status: "running" }, 202);
      }
      return context.json(result.bundle);
    });
    app.get("/api/incidents/:incidentId", (context) => {
      const incidentId = context.req.param("incidentId");
      if (!UUID_V4.test(incidentId)) {
        return context.json({ error: "Invalid Incident id" }, 400);
      }
      const result = incident.coordinator.readIncident(incidentId);
      if (result === undefined) {
        return context.json({ error: "Incident not found" }, 404);
      }
      return context.json(result);
    });
    app.get("/api/mission-control", (context) =>
      context.json(incident.coordinator.readMissionControl()),
    );
    app.post("/api/incidents/:incidentId/remediation-decisions", async (context) => {
      const incidentId = context.req.param("incidentId");
      if (!UUID_V4.test(incidentId)) {
        return context.json({ error: "Invalid Incident id" }, 400);
      }
      let request: unknown;
      try {
        request = await context.req.json();
      } catch {
        return context.json({ error: "Invalid Remediation decision" }, 400);
      }
      try {
        const result = incident.coordinator.decide(
          incidentId,
          remediationDecisionRequestSchema.parse(request),
        );
        return context.json(
          {
            incidentId,
            status: result.started ? "running" : result.state,
          },
          result.started ? 202 : 200,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Remediation decision failed";
        const status = message.endsWith("was not found") ? 404 : 409;
        return context.json({ error: message }, status);
      }
    });
  }

  app.post("/api/runtime-smokes", async (context) => {
    if (coordinator === undefined) {
      return context.json({ error: "Runtime smoke is unavailable" }, 503);
    }

    const result = await coordinator.start();
    if (!result.started) {
      return context.json(
        {
          activeSmokeId: result.activeSmokeId,
          error: "A runtime smoke is already running",
        },
        409,
      );
    }

    return context.json(
      {
        smokeId: result.smokeId,
        status: "running",
        statusUrl: `/api/runtime-smokes/${result.smokeId}`,
      },
      202,
    );
  });

  app.get("/api/runtime-smokes/:smokeId", async (context) => {
    if (coordinator === undefined) {
      return context.json({ error: "Runtime smoke is unavailable" }, 503);
    }

    const smokeId = context.req.param("smokeId");
    if (!UUID_V4.test(smokeId)) {
      return context.json({ error: "Invalid runtime smoke id" }, 400);
    }

    const smoke = await coordinator.read(smokeId);
    if (smoke === undefined) {
      return context.json({ error: "Runtime smoke not found" }, 404);
    }

    return context.json(smoke);
  });

  return app;
}
