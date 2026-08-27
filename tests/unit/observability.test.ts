import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFsLogs } from "evlog/fs";
import { afterEach, describe, expect, it } from "vitest";

import type { EvidenceBundle } from "../../src/evidence/ledger.js";
import { createBlackboxObservability } from "../../src/observability/evlog.js";

describe("BLACKBOX Evlog observability", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup
        .splice(0)
        .map((path) => rm(path, { force: true, recursive: true })),
    );
  });

  it("persists one redacted, actionable wide event for a failed Baseline Run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "blackbox-evlog-"));
    cleanup.push(directory);
    const logDirectory = join(directory, "logs");
    const observability = createBlackboxObservability({
      enabled: true,
      logDirectory,
      secrets: ["openrouter-secret", "daytona-secret"],
      silent: true,
    });
    const observation = observability.observeBaselineRun({
      incidentId: "incident-1",
      modelAlias: "glm-5.2",
      modelId: "z-ai/glm-5.2:free",
      runId: "run-1",
    });

    observation.failed(
      new Error(
        "Request failed (429): openrouter-secret BLACKBOX-CANARY-sensitive",
      ),
      "trueforge",
    );
    observation.completed(INCONCLUSIVE_BUNDLE);
    await observability.flush();

    const events = [];
    for await (const event of readFsLogs({ dir: logDirectory })) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "baseline.run",
      complete: false,
      evidenceCount: 2,
      incidentId: "incident-1",
      level: "error",
      missingEvidence: ["trueforge.turn.completed", "sink.message.received"],
      modelId: "z-ai/glm-5.2:free",
      provider: "openrouter",
      retryable: true,
      runId: "run-1",
      stage: "trueforge",
      statusCode: 429,
      verdict: "INCONCLUSIVE",
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("openrouter-secret");
    expect(serialized).not.toContain("BLACKBOX-CANARY-sensitive");
    expect(serialized).not.toContain("daytona-secret");
  });
});

const INCONCLUSIVE_BUNDLE = {
  bundleHash: "0".repeat(64),
  completeness: {
    complete: false,
    missing: ["trueforge.turn.completed", "sink.message.received"],
  },
  finalizedAt: "2026-08-26T12:00:08.000Z",
  manifest: {
    canarySecret: "BLACKBOX-CANARY-sensitive",
    createdAt: "2026-08-26T12:00:00.000Z",
    fingerprints: {
      agent: "agent-fingerprint",
      model: "model-fingerprint",
      policy: "policy-fingerprint",
      scenario: "scenario-fingerprint",
      tools: "tools-fingerprint",
    },
    incidentId: "incident-1",
    kind: "baseline",
    runId: "run-1",
  },
  schemaVersion: 1,
  timeline: [
    {
      id: "run-1:state:COMPLETED",
      occurredAt: "2026-08-26T12:00:08.000Z",
      runId: "run-1",
      source: "blackbox",
      state: "COMPLETED",
      type: "run.state_changed",
    },
    {
      id: "run-1:failed",
      message: "Request failed (429)",
      occurredAt: "2026-08-26T12:00:07.000Z",
      runId: "run-1",
      source: "blackbox",
      stage: "trueforge",
      type: "run.failed",
    },
  ],
  verdict: "INCONCLUSIVE",
} satisfies EvidenceBundle;
