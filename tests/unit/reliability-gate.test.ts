import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeConfig } from "../../src/config.js";
import {
  formatReliabilityGateSummary,
  reliabilityConfigurationFingerprint,
  reliabilityGateReportSchema,
  runReliabilityGate,
  type ReliabilityEquivalenceSetEvidence,
} from "../../src/cli/reliability-gate-client.js";
import { createModelFingerprint } from "../../src/scenario/definition.js";

const MODEL_ID = "vendor/tool-model";
const MODEL_ALIAS = "tool-model";
const MODEL_FINGERPRINT = createModelFingerprint(MODEL_ALIAS, MODEL_ID);

describe("reliability gate", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  it("persists three isolated accepted sets and resumes a completed gate without rerunning", async () => {
    const runtimeDirectory = await temporaryDirectory(cleanup);
    const observedDirectories: string[] = [];
    let preflights = 0;
    let sets = 0;

    const first = await runReliabilityGate({
      config: config(runtimeDirectory),
      async executeSet(attempt) {
        observedDirectories.push(attempt.runtimeDirectory);
        sets += 1;
        return equivalenceSet(sets);
      },
      async preflight() {
        preflights += 1;
        return {
          modelId: MODEL_ID,
          sandboxId: "sandbox-preflight",
          smokeId: "smoke-preflight",
        };
      },
    });

    expect(first.status).toBe("PASSED");
    expect(first.acceptedSets).toHaveLength(3);
    expect(new Set(observedDirectories)).toHaveLength(3);
    expect(first.acceptedSets.map((set) => set.baseline.verdict)).toEqual([
      "VULNERABLE",
      "VULNERABLE",
      "VULNERABLE",
    ]);
    expect(first.acceptedSets.map((set) => set.replay.verdict)).toEqual([
      "PROTECTED",
      "PROTECTED",
      "PROTECTED",
    ]);
    expect(first.acceptedSets.map((set) => set.control.result)).toEqual([
      "PASSED",
      "PASSED",
      "PASSED",
    ]);
    expect(JSON.stringify(first)).not.toContain("BLACKBOX-CANARY");

    const report = reliabilityGateReportSchema.parse(
      JSON.parse(
        await readFile(
          join(runtimeDirectory, "reliability", first.configuration.fingerprint, "result.json"),
          "utf8",
        ),
      ),
    );
    expect(report).toEqual(first);

    const resumed = await runReliabilityGate({
      config: config(runtimeDirectory),
      executeSet: async () => {
        throw new Error("completed gate must not execute another set");
      },
      preflight: async () => {
        throw new Error("completed gate must not preflight again");
      },
    });

    expect(resumed).toEqual(first);
    expect(preflights).toBe(1);
    expect(sets).toBe(3);
    expect(formatReliabilityGateSummary(first)).toContain(
      "Reliability gate: PASSED (3 consecutive sets)",
    );
    expect(formatReliabilityGateSummary(first)).toContain(
      `Model: ${MODEL_ID} (${MODEL_FINGERPRINT})`,
    );
  });

  it("does not count an interrupted attempt and restarts the consecutive sequence", async () => {
    const runtimeDirectory = await temporaryDirectory(cleanup);
    const controller = new AbortController();
    let firstSet = true;

    await expect(
      runReliabilityGate({
        config: config(runtimeDirectory),
        async executeSet() {
          if (firstSet) {
            firstSet = false;
            controller.abort(new Error("simulated interruption"));
            controller.signal.throwIfAborted();
          }
          return equivalenceSet(99);
        },
        preflight: successfulPreflight,
        signal: controller.signal,
      }),
    ).rejects.toThrow("simulated interruption");

    let sets = 0;
    const resumed = await runReliabilityGate({
      config: config(runtimeDirectory),
      async executeSet() {
        sets += 1;
        return equivalenceSet(sets);
      },
      preflight: successfulPreflight,
    });

    expect(sets).toBe(3);
    expect(resumed.status).toBe("PASSED");
    expect(resumed.rejectedAttempts).toEqual([
      expect.objectContaining({
        failedGate: "attempt.interrupted",
        status: "REJECTED",
      }),
    ]);
    expect(resumed.acceptedSets).toHaveLength(3);
  });

  it("rejects an inconclusive set at the exact gate and never reports partial success", async () => {
    const runtimeDirectory = await temporaryDirectory(cleanup);
    const inconclusive = equivalenceSet(1);
    inconclusive.replay.verdict = "INCONCLUSIVE";
    inconclusive.replay.missingEvidence = ["replay.policy_denied:send_external_message"];

    await expect(
      runReliabilityGate({
        config: config(runtimeDirectory),
        executeSet: async () => inconclusive,
        preflight: successfulPreflight,
      }),
    ).rejects.toThrow(
      "replay.verdict: replay.policy_denied:send_external_message",
    );

    const configurationFingerprint = reliabilityConfigurationFingerprint(
      config(runtimeDirectory),
    );
    const report = reliabilityGateReportSchema.parse(
      JSON.parse(
        await readFile(
          join(runtimeDirectory, "reliability", configurationFingerprint, "result.json"),
          "utf8",
        ),
      ),
    );
    expect(report.status).toBe("FAILED");
    expect(report.acceptedSets).toEqual([]);
    expect(report.rejectedAttempts).toEqual([
      expect.objectContaining({
        failedGate: "replay.verdict",
        status: "REJECTED",
      }),
    ]);
  });

  it("rejects Canary evidence that crosses a Run boundary", async () => {
    const runtimeDirectory = await temporaryDirectory(cleanup);
    const leaked = equivalenceSet(1);
    leaked.replay.observedPayloads.push(leaked.baseline.canarySecret);

    await expect(
      runReliabilityGate({
        config: config(runtimeDirectory),
        executeSet: async () => leaked,
        preflight: successfulPreflight,
      }),
    ).rejects.toThrow(
      "evidence.cross_run_leak: Canary evidence appeared in another Run",
    );
  });
});

function config(runtimeDirectory: string): RuntimeConfig {
  return {
    blackbox: { host: "127.0.0.1", port: 3000 },
    daytona: { apiKey: "daytona-secret" },
    openRouter: {
      apiKey: "openrouter-secret",
      baseUrl: "https://openrouter.example/api/v1",
      modelAlias: MODEL_ALIAS,
      modelId: MODEL_ID,
    },
    runtimeDirectory,
    trueForge: {
      baseUrl: "http://127.0.0.1:8790",
      host: "127.0.0.1",
      port: 8790,
      sqlitePath: join(runtimeDirectory, "trueforge.sqlite"),
    },
  };
}

function equivalenceSet(index: number): ReliabilityEquivalenceSetEvidence {
  const incidentId = `incident-${index}`;
  const baselineRunId = `baseline-${index}`;
  const replayRunId = `replay-${index}`;
  const controlRunId = `control-${index}`;
  const fingerprints = {
    agent: "agent-fingerprint",
    model: MODEL_FINGERPRINT,
    policy: `baseline-policy-${index}`,
    scenario: "scenario-fingerprint",
    tools: "tools-fingerprint",
  };
  return {
    baseline: {
      bundleHash: hashCharacter(index),
      canarySecret: `BLACKBOX-CANARY-baseline-${index}`,
      complete: true,
      finalizedAt: `2026-08-30T12:0${index}:01.000Z`,
      fingerprints,
      incidentId,
      missingEvidence: [],
      observedPayloads: [`BLACKBOX-CANARY-baseline-${index}`],
      runId: baselineRunId,
      timelineRunIds: [baselineRunId],
      verdict: "VULNERABLE",
    },
    control: {
      baselineRunId,
      bundleHash: hashCharacter(index + 6),
      canarySecret: `BLACKBOX-CANARY-control-${index}`,
      complete: true,
      finalizedAt: `2026-08-30T12:0${index}:03.000Z`,
      fingerprints: {
        ...fingerprints,
        policy: `protected-policy-${index}`,
        scenario: "control-scenario-fingerprint",
      },
      incidentId,
      missingEvidence: [],
      observedPayloads: [],
      result: "PASSED",
      runId: controlRunId,
      timelineRunIds: [controlRunId],
    },
    incidentId,
    remediationState: "VERIFIED",
    replay: {
      baselineRunId,
      bundleHash: hashCharacter(index + 3),
      canarySecret: `BLACKBOX-CANARY-replay-${index}`,
      complete: true,
      explicitDenial: true,
      finalizedAt: `2026-08-30T12:0${index}:02.000Z`,
      fingerprints: {
        ...fingerprints,
        policy: `protected-policy-${index}`,
      },
      incidentId,
      matchingCanaryReceipt: false,
      missingEvidence: [],
      observedPayloads: [],
      runId: replayRunId,
      timelineRunIds: [replayRunId],
      verdict: "PROTECTED",
    },
  };
}

function hashCharacter(index: number): string {
  return String.fromCharCode(96 + index).repeat(64);
}

async function successfulPreflight() {
  return {
    modelId: MODEL_ID,
    sandboxId: "sandbox-preflight",
    smokeId: "smoke-preflight",
  };
}

async function temporaryDirectory(cleanup: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "blackbox-reliability-"));
  cleanup.push(directory);
  return directory;
}
