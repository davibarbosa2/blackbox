import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { policyPatchDryRunSchema } from "../policy/capability-policy.js";
import {
  evidenceJustificationSchema,
  investigationAnalysisSchema,
  investigationDiagnosisSchema,
  pendingPolicyActionSchema,
  subagentEvidenceSchema,
} from "../trueforge/runtime.js";

const baselineSchema = z.object({
  evidenceBundleHash: z.string().length(64),
  runId: z.string(),
  verdict: z.literal("VULNERABLE"),
});

const lifecycleEventSchema = z.object({
  occurredAt: z.string(),
  state: z.enum(["DRAFTED", "DRY_RUN_PASSED", "AWAITING_APPROVAL"]),
});
const lifecycleSchema = z.array(lifecycleEventSchema);

const investigatingSchema = z.object({
  lifecycle: lifecycleSchema,
  state: z.literal("INVESTIGATING"),
});

const draftedSchema = z.object({
  lifecycle: lifecycleSchema,
  state: z.literal("DRAFTED"),
});

const dryRunPassedSchema = z.object({
  dryRun: policyPatchDryRunSchema,
  lifecycle: lifecycleSchema,
  state: z.literal("DRY_RUN_PASSED"),
});

const validationFailedSchema = z.object({
  error: z.string(),
  lifecycle: lifecycleSchema,
  state: z.literal("VALIDATION_FAILED"),
});

const awaitingApprovalSchema = z.object({
  analysis: investigationAnalysisSchema,
  diagnosis: investigationDiagnosisSchema,
  dryRun: policyPatchDryRunSchema,
  evidenceJustification: evidenceJustificationSchema,
  lifecycle: lifecycleSchema,
  pendingDecision: pendingPolicyActionSchema.omit({
    proposal: true,
  }),
  state: z.literal("AWAITING_APPROVAL"),
  subagents: z.tuple([subagentEvidenceSchema, subagentEvidenceSchema]),
});

export const durableIncidentReadSchema = z.object({
  baseline: baselineSchema,
  incidentId: z.string(),
  remediation: z.discriminatedUnion("state", [
    investigatingSchema,
    draftedSchema,
    dryRunPassedSchema,
    validationFailedSchema,
    awaitingApprovalSchema,
  ]),
});

export type DurableIncidentRead = z.infer<typeof durableIncidentReadSchema>;
export type AwaitingApprovalRemediation = z.infer<
  typeof awaitingApprovalSchema
>;

const rowSchema = z.object({ record_json: z.string() });

export class SqliteRemediationStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS incidents (
        incident_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.#database.close();
  }

  start(
    incidentId: string,
    runId: string,
    evidenceBundleHash: string,
  ): DurableIncidentRead {
    const incident = durableIncidentReadSchema.parse({
      baseline: {
        evidenceBundleHash,
        runId,
        verdict: "VULNERABLE",
      },
      incidentId,
      remediation: { lifecycle: [], state: "INVESTIGATING" },
    });
    this.#database
      .prepare(
        "INSERT OR IGNORE INTO incidents (incident_id, record_json) VALUES (?, ?)",
      )
      .run(incidentId, JSON.stringify(incident));
    return this.read(incidentId) ?? incident;
  }

  drafted(incidentId: string): DurableIncidentRead {
    const current = this.#readRequired(incidentId);
    if (current.remediation.state === "DRAFTED") return current;
    if (current.remediation.state !== "INVESTIGATING") {
      throw new Error(`Incident ${incidentId} is not being investigated`);
    }
    return this.#update(current, {
      lifecycle: appendLifecycle(current, "DRAFTED"),
      state: "DRAFTED",
    });
  }

  dryRunPassed(
    incidentId: string,
    dryRun: z.infer<typeof policyPatchDryRunSchema>,
  ): DurableIncidentRead {
    const current = this.#readRequired(incidentId);
    if (current.remediation.state !== "DRAFTED") {
      throw new Error(`Incident ${incidentId} has not reached DRAFTED`);
    }
    return this.#update(current, {
      dryRun,
      lifecycle: appendLifecycle(current, "DRY_RUN_PASSED"),
      state: "DRY_RUN_PASSED",
    });
  }

  awaitingApproval(
    incidentId: string,
    remediation: Omit<AwaitingApprovalRemediation, "lifecycle" | "state">,
  ): DurableIncidentRead {
    const current = this.#readRequired(incidentId);
    if (current.remediation.state !== "DRY_RUN_PASSED") {
      throw new Error(`Incident ${incidentId} has not passed dry-run validation`);
    }
    return this.#update(current, {
      ...remediation,
      lifecycle: appendLifecycle(current, "AWAITING_APPROVAL"),
      state: "AWAITING_APPROVAL",
    });
  }

  validationFailed(incidentId: string, error: string): DurableIncidentRead {
    const current = this.#readRequired(incidentId);
    return this.#update(current, {
      error,
      lifecycle: current.remediation.lifecycle,
      state: "VALIDATION_FAILED",
    });
  }

  read(incidentId: string): DurableIncidentRead | undefined {
    const row = this.#database
      .prepare("SELECT record_json FROM incidents WHERE incident_id = ?")
      .get(incidentId);
    if (row === undefined) return undefined;
    const parsed = rowSchema.parse(row);
    return durableIncidentReadSchema.parse(JSON.parse(parsed.record_json));
  }

  #readRequired(incidentId: string): DurableIncidentRead {
    const incident = this.read(incidentId);
    if (incident === undefined) {
      throw new Error(`Incident ${incidentId} was not found`);
    }
    return incident;
  }

  #update(
    current: DurableIncidentRead,
    remediation: DurableIncidentRead["remediation"],
  ): DurableIncidentRead {
    const incident = durableIncidentReadSchema.parse({ ...current, remediation });
    this.#database
      .prepare("UPDATE incidents SET record_json = ? WHERE incident_id = ?")
      .run(JSON.stringify(incident), current.incidentId);
    return incident;
  }
}

function appendLifecycle(
  incident: DurableIncidentRead,
  state: z.infer<typeof lifecycleEventSchema>["state"],
): z.infer<typeof lifecycleSchema> {
  return [
    ...incident.remediation.lifecycle,
    { occurredAt: new Date().toISOString(), state },
  ];
}
