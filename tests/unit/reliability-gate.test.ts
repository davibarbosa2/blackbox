import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeConfig } from "../../src/config.js";
import { RemediationAcceptanceError } from "../../src/cli/remediation-acceptance-client.js";
import {
  createReliabilityConfiguration,
  formatReliabilityGateSummary,
  reliabilityConfigurationFingerprint,
  reliabilityGateReportSchema,
  runReliabilityGate,
  type ReliabilityEquivalenceSetEvidence,
} from "../../src/cli/reliability-gate-client.js";
import { RuntimeSmokeClientError } from "../../src/cli/runtime-smoke-client.js";
import { createModelFingerprint } from "../../src/scenario/definition.js";

const MODEL_ID = "vendor/tool-model";
const MODEL_ALIAS = "tool-model";
const MODEL_FINGERPRINT = createModelFingerprint(MODEL_ALIAS, MODEL_ID);
const EXPECTED_CONFIGURATION = createReliabilityConfiguration(config("/runtime"));

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
    const evidenceByDirectory = new Map<string, ReliabilityEquivalenceSetEvidence>();
    let preflights = 0;
    let sets = 0;

    const first = await runReliabilityGate({
      config: config(runtimeDirectory),
      async executeSet(attempt) {
        observedDirectories.push(attempt.runtimeDirectory);
        sets += 1;
        const evidence = equivalenceSet(sets);
        evidenceByDirectory.set(attempt.runtimeDirectory, evidence);
        return evidence;
      },
      async preflight() {
        preflights += 1;
        return {
          modelId: MODEL_ID,
          sandboxId: "sandbox-preflight",
          smokeId: "smoke-preflight",
        };
      },
      revalidateSet: unexpectedRevalidation,
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
      async revalidateSet(attempt) {
        const evidence = evidenceByDirectory.get(attempt.runtimeDirectory);
        if (evidence === undefined) throw new Error("evidence unavailable");
        return evidence;
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
        revalidateSet: unexpectedRevalidation,
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
      revalidateSet: unexpectedRevalidation,
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
        revalidateSet: unexpectedRevalidation,
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
    expect(formatReliabilityGateSummary(report)).toContain("duration_ms=");

    inconclusive.replay.verdict = "PROTECTED";
    inconclusive.replay.missingEvidence = [];
    await expect(
      runReliabilityGate({
        config: config(runtimeDirectory),
        executeSet: async () => inconclusive,
        preflight: successfulPreflight,
        revalidateSet: unexpectedRevalidation,
      }),
    ).rejects.toThrow(
      "attempt.duplicate: Run id or Evidence Bundle hash was already counted",
    );
  });

  it("classifies real preflight and Remediation failures by their evidence gate", async () => {
    const sandboxDirectory = await temporaryDirectory(cleanup);
    await expect(
      runReliabilityGate({
        config: config(sandboxDirectory),
        executeSet: async () => equivalenceSet(1),
        preflight: async () => {
          throw new RuntimeSmokeClientError(
            "sandbox-smoke",
            "Daytona marker was missing",
          );
        },
        revalidateSet: unexpectedRevalidation,
      }),
    ).rejects.toMatchObject({ failedGate: "preflight.sandbox" });

    const controlDirectory = await temporaryDirectory(cleanup);
    await expect(
      runReliabilityGate({
        config: config(controlDirectory),
        executeSet: async () => {
          throw new RemediationAcceptanceError(
            "control",
            "BLACKBOX Remediation validation failed: Remediation verification evidence gates did not pass: replay=complete; control=control.trusted_workflow_delivered",
          );
        },
        preflight: successfulPreflight,
        revalidateSet: unexpectedRevalidation,
      }),
    ).rejects.toMatchObject({ failedGate: "control.evidence" });
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
        revalidateSet: unexpectedRevalidation,
      }),
    ).rejects.toThrow(
      "evidence.cross_run_leak: Canary evidence appeared in another Run",
    );
  });

  it("does not reuse evidence from a superseded sequence", async () => {
    const runtimeDirectory = await temporaryDirectory(cleanup);
    const firstSet = equivalenceSet(1);
    let firstInvocation = 0;

    await expect(
      runReliabilityGate({
        config: config(runtimeDirectory),
        async executeSet() {
          firstInvocation += 1;
          if (firstInvocation === 1) return firstSet;
          throw new Error("second set failed");
        },
        preflight: successfulPreflight,
        revalidateSet: unexpectedRevalidation,
      }),
    ).rejects.toThrow("execution.runtime: second set failed");

    const leaked = equivalenceSet(2);
    leaked.replay.observedPayloads.push(firstSet.baseline.canarySecret);
    let resumedAttempts = 0;
    await expect(
      runReliabilityGate({
        config: config(runtimeDirectory),
        async executeSet() {
          resumedAttempts += 1;
          return leaked;
        },
        preflight: successfulPreflight,
        revalidateSet: unexpectedRevalidation,
      }),
    ).rejects.toThrow(
      "evidence.cross_run_leak: Canary evidence appeared in another Run",
    );
    expect(resumedAttempts).toBe(1);
  });

  it("rereads durable evidence before trusting a completed report", async () => {
    const runtimeDirectory = await temporaryDirectory(cleanup);
    const evidenceByDirectory = new Map<string, ReliabilityEquivalenceSetEvidence>();
    let sets = 0;
    await runReliabilityGate({
      config: config(runtimeDirectory),
      async executeSet(attempt) {
        sets += 1;
        const evidence = equivalenceSet(sets);
        evidenceByDirectory.set(attempt.runtimeDirectory, evidence);
        return evidence;
      },
      preflight: successfulPreflight,
      revalidateSet: unexpectedRevalidation,
    });
    const stale = evidenceByDirectory.values().next().value;
    if (stale === undefined) throw new Error("accepted evidence unavailable");
    stale.replay.verdict = "INCONCLUSIVE";
    stale.replay.missingEvidence = ["replay.policy_denied:send_external_message"];

    await expect(
      runReliabilityGate({
        config: config(runtimeDirectory),
        executeSet: async () => {
          throw new Error("completed gate must not execute another set");
        },
        preflight: async () => {
          throw new Error("completed gate must not preflight again");
        },
        async revalidateSet(attempt) {
          const evidence = evidenceByDirectory.get(attempt.runtimeDirectory);
          if (evidence === undefined) throw new Error("evidence unavailable");
          return evidence;
        },
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
          join(
            runtimeDirectory,
            "reliability",
            configurationFingerprint,
            "result.json",
          ),
          "utf8",
        ),
      ),
    );
    expect(report.status).toBe("FAILED");
    expect(report.completedAt).toBeUndefined();
    expect(report.acceptedSets).toEqual([]);
    expect(report.supersededSets).toHaveLength(3);
    expect(report.rejectedAttempts.at(-1)).toEqual(
      expect.objectContaining({
        failedGate: "replay.verdict",
        status: "REJECTED",
      }),
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
  const fingerprints = { ...EXPECTED_CONFIGURATION.baselineFingerprints };
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
        ...EXPECTED_CONFIGURATION.controlFingerprints,
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
        ...EXPECTED_CONFIGURATION.replayFingerprints,
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

async function unexpectedRevalidation(): Promise<never> {
  throw new Error("no accepted set should require revalidation");
}

async function temporaryDirectory(cleanup: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "blackbox-reliability-"));
  cleanup.push(directory);
  return directory;
}
