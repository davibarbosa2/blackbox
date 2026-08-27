import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";

import { SqliteEvidenceLedger } from "../evidence/ledger.js";
import { IncidentCoordinator } from "../incident/coordinator.js";
import { createBaselineCapabilityPolicy } from "../policy/capability-policy.js";
import {
  createScenarioMcpHandler,
  registerExternalSinkRoute,
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
  runtimeDirectory: string;
  trueForgeRuntime: TrueForgeRuntime;
}

export interface BlackboxApplication {
  app: Hono;
  shutdown(): Promise<void>;
}

export function createBlackboxApp(options?: BlackboxAppOptions): Hono {
  const coordinator = options
    ? new RuntimeSmokeCoordinator(
        options.trueForgeRuntime,
        new FileRuntimeSmokeStore(options.runtimeDirectory),
      )
    : undefined;
  return buildApp(coordinator);
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
    app: buildApp(coordinator, incident),
    async shutdown(): Promise<void> {
      await Promise.all([coordinator.shutdown(), incident?.shutdown()]);
    },
  };
}

interface IncidentApplication {
  coordinator: IncidentCoordinator;
  ledger: SqliteEvidenceLedger;
  mcp: ReturnType<typeof createScenarioMcpHandler>;
  shutdown(): Promise<void>;
}

function createIncidentApplication(
  options: BlackboxAppOptions,
  incidentOptions: NonNullable<BlackboxAppOptions["incident"]>,
): IncidentApplication {
  mkdirSync(options.runtimeDirectory, { mode: 0o700, recursive: true });
  const ledger = new SqliteEvidenceLedger(
    join(options.runtimeDirectory, "blackbox.sqlite"),
  );
  const policy = createBaselineCapabilityPolicy();
  const service = new ScenarioService(
    ledger,
    policy,
    incidentOptions.baseUrl,
  );
  const mcp = createScenarioMcpHandler(service);
  const coordinator = new IncidentCoordinator(
    options.trueForgeRuntime,
    ledger,
    policy,
    incidentOptions.modelAlias,
    incidentOptions.modelId,
    incidentOptions.baseUrl,
  );
  return {
    coordinator,
    ledger,
    mcp,
    async shutdown(): Promise<void> {
      await coordinator.shutdown();
      try {
        await mcp.close();
      } finally {
        ledger.close();
      }
    },
  };
}

function buildApp(
  coordinator?: RuntimeSmokeCoordinator,
  incident?: IncidentApplication,
): Hono {
  const app = new Hono();

  app.get("/healthz", (context) => context.json({ status: "ok" }));

  if (incident !== undefined) {
    app.all("/mcp", (context) => {
      const request = context.req.raw;
      const rejected =
        hostHeaderValidationResponse(request, localhostAllowedHostnames()) ??
        originValidationResponse(request, localhostAllowedOrigins());
      return rejected ?? incident.mcp.fetch(request);
    });
    registerExternalSinkRoute(app, incident.ledger);
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
