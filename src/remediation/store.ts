import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import {
  policyPatchDryRunSchema,
  policyReadSchema,
} from "../policy/capability-policy.js";
import {
  evidenceJustificationSchema,
  investigationAnalysisSchema,
  investigationDiagnosisSchema,
  pendingPolicyDecisionSchema,
  subagentEvidenceSchema,
} from "../trueforge/runtime.js";

const baselineSchema = z.object({
  evidenceBundleHash: z.string().length(64),
  runId: z.string(),
  verdict: z.literal("VULNERABLE"),
});

const lifecycleEventSchema = z.object({
  occurredAt: z.string(),
  state: z.enum([
    "DRAFTED",
    "DRY_RUN_PASSED",
    "AWAITING_APPROVAL",
    "DENIED",
    "STALE",
    "APPLIED",
    "VERIFYING",
    "VERIFIED",
    "VALIDATION_FAILED",
  ]),
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
  dryRun: policyPatchDryRunSchema.optional(),
  error: z.string(),
  lifecycle: lifecycleSchema,
  pendingDecision: pendingPolicyDecisionSchema.optional(),
  state: z.literal("VALIDATION_FAILED"),
});

const awaitingApprovalSchema = z.object({
  analysis: investigationAnalysisSchema,
  diagnosis: investigationDiagnosisSchema,
  dryRun: policyPatchDryRunSchema,
  evidenceJustification: evidenceJustificationSchema,
  lifecycle: lifecycleSchema,
  pendingDecision: pendingPolicyDecisionSchema,
  state: z.literal("AWAITING_APPROVAL"),
  subagents: z.tuple([subagentEvidenceSchema, subagentEvidenceSchema]),
});

export const remediationDecisionEvidenceSchema =
  pendingPolicyDecisionSchema.extend({
    decidedAt: z.string(),
    decision: z.enum(["allow", "deny"]),
  });

export const remediationDecisionRequestSchema = z.strictObject({
  decision: z.enum(["allow", "deny"]),
  pendingDecision: pendingPolicyDecisionSchema,
});

export type RemediationDecisionRequest = z.infer<
  typeof remediationDecisionRequestSchema
>;

const deniedSchema = z.object({
  decision: remediationDecisionEvidenceSchema.extend({
    decision: z.literal("deny"),
  }),
  dryRun: policyPatchDryRunSchema,
  lifecycle: lifecycleSchema,
  policyReadback: policyReadSchema,
  state: z.literal("DENIED"),
});

const staleSchema = z.object({
  decision: remediationDecisionEvidenceSchema.extend({
    decision: z.literal("allow"),
  }),
  dryRun: policyPatchDryRunSchema,
  lifecycle: lifecycleSchema,
  policyReadback: policyReadSchema,
  state: z.literal("STALE"),
});

export const durableIncidentReadSchema = z.object({
  baseline: baselineSchema,
  incidentId: z.string(),
  incidentStatus: z.enum(["OPEN", "RESOLVED"]),
  remediation: z.discriminatedUnion("state", [
    investigatingSchema,
    draftedSchema,
    dryRunPassedSchema,
    validationFailedSchema,
    awaitingApprovalSchema,
    deniedSchema,
    staleSchema,
  ]),
});

export type DurableIncidentRead = z.infer<typeof durableIncidentReadSchema>;
export type AwaitingApprovalRemediation = z.infer<
  typeof awaitingApprovalSchema
>;
export type PendingPolicyDecision = z.infer<typeof pendingPolicyDecisionSchema>;
export type RemediationDecisionEvidence = z.infer<
  typeof remediationDecisionEvidenceSchema
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
      CREATE TABLE IF NOT EXISTS incident_runtime (
        incident_id TEXT PRIMARY KEY REFERENCES incidents(incident_id),
        mcp_authorization TEXT NOT NULL
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
    mcpAuthorization?: string,
  ): DurableIncidentRead {
    const incident = durableIncidentReadSchema.parse({
      baseline: {
        evidenceBundleHash,
        runId,
        verdict: "VULNERABLE",
      },
      incidentId,
      incidentStatus: "OPEN",
      remediation: { lifecycle: [], state: "INVESTIGATING" },
    });
    this.#database
      .prepare(
        "INSERT OR IGNORE INTO incidents (incident_id, record_json) VALUES (?, ?)",
      )
      .run(incidentId, JSON.stringify(incident));
    if (mcpAuthorization !== undefined) {
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO incident_runtime
            (incident_id, mcp_authorization) VALUES (?, ?)`,
        )
        .run(incidentId, mcpAuthorization);
    }
    return this.read(incidentId) ?? incident;
  }

  readMcpAuthorization(incidentId: string): string {
    const row = this.#database
      .prepare(
        "SELECT mcp_authorization FROM incident_runtime WHERE incident_id = ?",
      )
      .get(incidentId);
    const parsed = z
      .object({ mcp_authorization: z.string().min(1) })
      .safeParse(row);
    if (!parsed.success) {
      throw new Error(`Incident ${incidentId} has no persisted MCP authorization`);
    }
    return parsed.data.mcp_authorization;
  }

  denied(
    incidentId: string,
    decision: RemediationDecisionEvidence & { decision: "deny" },
    policyReadback: z.infer<typeof policyReadSchema>,
  ): DurableIncidentRead {
    const current = this.#readRequired(incidentId);
    if (current.remediation.state === "DENIED") return current;
    if (current.remediation.state !== "AWAITING_APPROVAL") {
      throw new Error(`Incident ${incidentId} is not awaiting approval`);
    }
    return this.#update(current, {
      decision,
      dryRun: current.remediation.dryRun,
      lifecycle: appendLifecycle(current, "DENIED"),
      policyReadback,
      state: "DENIED",
    });
  }

  stale(
    incidentId: string,
    decision: RemediationDecisionEvidence & { decision: "allow" },
    policyReadback: z.infer<typeof policyReadSchema>,
  ): DurableIncidentRead {
    const current = this.#readRequired(incidentId);
    if (current.remediation.state === "STALE") return current;
    if (current.remediation.state !== "AWAITING_APPROVAL") {
      throw new Error(`Incident ${incidentId} is not awaiting approval`);
    }
    return this.#update(current, {
      decision,
      dryRun: current.remediation.dryRun,
      lifecycle: appendLifecycle(current, "STALE"),
      policyReadback,
      state: "STALE",
    });
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

  validationFailed(
    incidentId: string,
    error: string,
    pendingDecision?: PendingPolicyDecision,
  ): DurableIncidentRead {
    const current = this.#readRequired(incidentId);
    const dryRun =
      current.remediation.state === "DRY_RUN_PASSED" ||
      current.remediation.state === "AWAITING_APPROVAL"
        ? current.remediation.dryRun
        : undefined;
    const failure: z.infer<typeof validationFailedSchema> = {
      error,
      lifecycle: current.remediation.lifecycle,
      state: "VALIDATION_FAILED",
    };
    if (dryRun !== undefined) failure.dryRun = dryRun;
    if (pendingDecision !== undefined) {
      failure.pendingDecision = pendingDecision;
    }
    return this.#update(current, failure);
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
