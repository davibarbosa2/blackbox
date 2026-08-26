import { describe, expect, it } from "vitest";

import { createBlackboxApp } from "../../src/http/app.js";

describe("BLACKBOX HTTP health", () => {
  it("lets a developer observe that BLACKBOX is ready", async () => {
    const response = await createBlackboxApp().request("/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
