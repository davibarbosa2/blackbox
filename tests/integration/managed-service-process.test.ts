import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { ManagedServiceProcess } from "../../src/process/managed-service.js";

const HEALTH_SERVER_SOURCE = `
  const { createServer } = require("node:http");
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("OK!");
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(Number(process.env.TEST_PORT), "127.0.0.1");
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
`;

describe("managed service process", () => {
  const services: ManagedServiceProcess[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.stop()));
  });

  it("owns a child service from health readiness through graceful shutdown", async () => {
    const port = await findAvailablePort();
    const service = new ManagedServiceProcess({
      args: ["-e", HEALTH_SERVER_SOURCE],
      command: process.execPath,
      environment: { TEST_PORT: String(port) },
      health: {
        expectedBody: "OK!",
        timeoutMs: 2_000,
        url: `http://127.0.0.1:${port}/healthz`,
      },
      name: "test-service",
      shutdownTimeoutMs: 2_000,
    });
    services.push(service);

    await service.start();

    await expect(
      fetch(`http://127.0.0.1:${port}/healthz`).then((response) =>
        response.text(),
      ),
    ).resolves.toBe("OK!");

    await service.stop();
    await expect(canListen(port)).resolves.toBe(true);
  });

  it("fails startup when the owned child never becomes healthy", async () => {
    const port = await findAvailablePort();
    const service = new ManagedServiceProcess({
      args: ["-e", "setInterval(() => undefined, 1_000)"],
      command: process.execPath,
      health: {
        expectedBody: "OK!",
        timeoutMs: 100,
        url: `http://127.0.0.1:${port}/healthz`,
      },
      name: "unhealthy-service",
      shutdownTimeoutMs: 2_000,
    });
    services.push(service);

    await expect(service.start()).rejects.toThrow(
      `unhealthy-service health check timed out at http://127.0.0.1:${port}/healthz`,
    );
  });

  it("reports a spawn failure without hanging its cleanup path", async () => {
    const service = new ManagedServiceProcess({
      args: [],
      command: "/blackbox/command-does-not-exist",
      health: {
        expectedBody: "OK!",
        timeoutMs: 1_000,
        url: "http://127.0.0.1:1/healthz",
      },
      name: "missing-service",
      shutdownTimeoutMs: 100,
    });

    const outcome = await Promise.race([
      service.start().then(
        () => "started",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      ),
      delay(500).then(() => "timed-out"),
    ]);

    expect(outcome).toContain("missing-service failed to start");
  });
});

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("Expected a TCP address"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
