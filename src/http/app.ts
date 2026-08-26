import { Hono } from "hono";

import { RuntimeSmokeCoordinator } from "../smoke/coordinator.js";
import { FileRuntimeSmokeStore } from "../smoke/file-store.js";
import type { TrueForgeRuntime } from "../trueforge/runtime.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface BlackboxAppOptions {
  runtimeDirectory: string;
  trueForgeRuntime: TrueForgeRuntime;
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

export function createBlackboxApplication(options: BlackboxAppOptions): {
  app: Hono;
  shutdown(): Promise<void>;
} {
  const coordinator = new RuntimeSmokeCoordinator(
    options.trueForgeRuntime,
    new FileRuntimeSmokeStore(options.runtimeDirectory),
  );
  return {
    app: buildApp(coordinator),
    shutdown: () => coordinator.shutdown(),
  };
}

function buildApp(coordinator?: RuntimeSmokeCoordinator): Hono {
  const app = new Hono();

  app.get("/healthz", (context) => context.json({ status: "ok" }));

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
