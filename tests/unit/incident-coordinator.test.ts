import { describe, expect, it, vi } from "vitest";

import type {
  EvidenceLedger,
  EvidenceRecord,
  RunManifest,
} from "../../src/evidence/ledger.js";
import { IncidentCoordinator } from "../../src/incident/coordinator.js";
import type { BaselineRunObservation } from "../../src/observability/evlog.js";
import { createBaselineCapabilityPolicy } from "../../src/policy/capability-policy.js";
import type { TrueForgeRuntime } from "../../src/trueforge/runtime.js";

describe("Incident coordinator observability", () => {
  it("emits a terminal observation when evidence finalization fails", async () => {
    const records: EvidenceRecord[] = [];
    let manifest: RunManifest | undefined;
    const ledger: EvidenceLedger = {
      append(sourceRecords): void {
        records.push(...sourceRecords);
      },
      createRun(sourceManifest): void {
        manifest = sourceManifest;
      },
      finalizeBaseline(): never {
        throw new Error("SQLite finalization failed with private details");
      },
      readBundle: () => undefined,
      readManifest(): RunManifest {
        if (manifest === undefined) throw new Error("Run manifest unavailable");
        return manifest;
      },
    };
    const runtime: TrueForgeRuntime = {
      async executeBaseline(): Promise<never> {
        throw new Error(
          "Request failed (429): raw customer ticket and secret evidence",
        );
      },
      executeSmoke: () => new Promise(() => undefined),
    };
    const observation: BaselineRunObservation = {
      completed: vi.fn(),
      failed: vi.fn(),
      finalizationFailed: vi.fn(),
    };
    const coordinator = new IncidentCoordinator(
      runtime,
      ledger,
      createBaselineCapabilityPolicy(),
      "glm-5.2",
      "z-ai/glm-5.2:free",
      "http://127.0.0.1:3000",
      () => observation,
    );

    coordinator.start();

    await vi.waitFor(() => {
      expect(observation.finalizationFailed).toHaveBeenCalledOnce();
    });
    expect(observation.failed).toHaveBeenCalledWith(
      {
        message: "TrueForge upstream request failed with HTTP 429",
        retryable: true,
        statusCode: 429,
      },
      "trueforge",
    );
    expect(observation.completed).not.toHaveBeenCalled();
    expect(
      records.find((record) => record.type === "run.failed"),
    ).toMatchObject({
      message: "TrueForge upstream request failed with HTTP 429",
      stage: "trueforge",
    });
    expect(JSON.stringify(records)).not.toContain("raw customer ticket");
    expect(JSON.stringify(records)).not.toContain("secret evidence");
  });
});
