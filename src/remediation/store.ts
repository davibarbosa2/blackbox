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

const replayVerificationSchema = z.object({
  bundleHash: z.string().length(64),
  complete: z.boolean(),
  runId: z.string(),
  verdict: z.enum(["PROTECTED", "INCONCLUSIVE"]),
});
const controlVerificationSchema = z.object({
  bundleHash: z.string().length(64),
  complete: z.boolean(),
  controlResult: z.enum(["PASSED", "INCONCLUSIVE"]),
  runId: z.string(),
});

const validationFailedSchema = z.object({
  decision: z.lazy(() => remediationDecisionEvidenceSchema).optional(),
  dryRun: policyPatchDryRunSchema.optional(),
  error: z.string(),
  lifecycle: lifecycleSchema,
  pendingDecision: pendingPolicyDecisionSchema.optional(),
  policyReadback: policyReadSchema.optional(),
  verification: z
    .object({
      control: controlVerificationSchema.optional(),
      replay: replayVerificationSchema.optional(),
    })
    .optional(),
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

const appliedSchema = z.object({
  decision: remediationDecisionEvidenceSchema.extend({
    decision: z.literal("allow"),
  }),
  dryRun: policyPatchDryRunSchema,
  lifecycle: lifecycleSchema,
  policyReadback: policyReadSchema,
  state: z.literal("APPLIED"),
});

const verifyingSchema = appliedSchema.extend({
  state: z.literal("VERIFYING"),
  verification: z.object({
    control: controlVerificationSchema.optional(),
    replay: replayVerificationSchema.optional(),
  }),
});

const verifiedSchema = appliedSchema.extend({
  state: z.literal("VERIFIED"),
  verification: z.object({
    control: controlVerificationSchema.extend({
      complete: z.literal(true),
      controlResult: z.literal("PASSED"),
    }),
    replay: replayVerificationSchema.extend({
      complete: z.literal(true),
      verdict: z.literal("PROTECTED"),
    }),
  }),
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
    appliedSchema,
    verifyingSchema,
    verifiedSchema,
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
const migrationRowSchema = z.object({
  incident_id: z.string(),
  record_json: z.string(),
});
const legacyIncidentSchema = z.object({
  baseline: baselineSchema,
  incidentId: z.string(),
  incidentStatus: z.enum(["OPEN", "RESOLVED"]).optional(),
  remediation: z
    .object({
      lifecycle: lifecycleSchema.optional(),
      pendingDecision: z.unknown().optional(),
      state: z.string(),
    })
    .passthrough(),
});
const remediationStoreVersionSchema = z.object({ schema_version: z.number() });
const REMEDIATION_STORE_VERSION = 2;

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
      CREATE TABLE IF NOT EXISTS remediation_schema_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      );
    `);
    migrateIncidentRecords(this.#database);
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

  applied(
    incidentId: string,
    decision: RemediationDecisionEvidence & { decision: "allow" },
    policyReadback: z.infer<typeof policyReadSchema>,
  ): DurableIncidentRead {
    const current = this.#readRequired(incidentId);
    if (
      current.remediation.state === "APPLIED" ||
      current.remediation.state === "VERIFYING" ||
      current.remediation.state === "VERIFIED"
    ) {
      return current;
    }
    if (current.remediation.state !== "AWAITING_APPROVAL") {
      throw new Error(`Incident ${incidentId} is not awaiting approval`);
    }
    return this.#update(current, {
      decision,
      dryRun: current.remediation.dryRun,
      lifecycle: appendLifecycle(current, "APPLIED"),
      policyReadback,
      state: "APPLIED",
    });
  }

  verifying(incidentId: string): DurableIncidentRead {
    const current = this.#readRequired(incidentId);
    if (current.remediation.state === "VERIFYING") return current;
    if (current.remediation.state !== "APPLIED") {
      throw new Error(`Incident ${incidentId} has not applied its Policy Patch`);
    }
    return this.#update(current, {
      ...current.remediation,
      lifecycle: appendLifecycle(current, "VERIFYING"),
      state: "VERIFYING",
      verification: {},
    });
  }

  recordReplay(
    incidentId: string,
    replay: z.infer<typeof replayVerificationSchema>,
  ): DurableIncidentRead {
    const current = this.#readRequired(incidentId);
    if (current.remediation.state !== "VERIFYING") {
      throw new Error(`Incident ${incidentId} is not verifying`);
    }
    return this.#update(current, {
      ...current.remediation,
      verification: { ...current.remediation.verification, replay },
    });
  }

  recordControl(
    incidentId: string,
    control: z.infer<typeof controlVerificationSchema>,
  ): DurableIncidentRead {
    const current = this.#readRequired(incidentId);
    if (current.remediation.state !== "VERIFYING") {
      throw new Error(`Incident ${incidentId} is not verifying`);
    }
    return this.#update(current, {
      ...current.remediation,
      verification: { ...current.remediation.verification, control },
    });
  }

  verified(incidentId: string): DurableIncidentRead {
    const current = this.#readRequired(incidentId);
    if (current.remediation.state === "VERIFIED") return current;
    if (
      current.remediation.state !== "VERIFYING" ||
      current.remediation.verification.replay?.verdict !== "PROTECTED" ||
      !current.remediation.verification.replay.complete ||
      current.remediation.verification.control?.controlResult !== "PASSED" ||
      !current.remediation.verification.control.complete
    ) {
      throw new Error(`Incident ${incidentId} has not passed verification`);
    }
    const incident = durableIncidentReadSchema.parse({
      ...current,
      incidentStatus: "RESOLVED",
      remediation: {
        ...current.remediation,
        lifecycle: appendLifecycle(current, "VERIFIED"),
        state: "VERIFIED",
      },
    });
    return this.#writeIncident(incident);
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
      current.remediation.state === "AWAITING_APPROVAL" ||
      current.remediation.state === "APPLIED" ||
      current.remediation.state === "VERIFYING"
        ? current.remediation.dryRun
        : undefined;
    const failure: z.infer<typeof validationFailedSchema> = {
      error,
      lifecycle: appendLifecycle(current, "VALIDATION_FAILED"),
      state: "VALIDATION_FAILED",
    };
    if (dryRun !== undefined) failure.dryRun = dryRun;
    if (pendingDecision !== undefined) {
      failure.pendingDecision = pendingDecision;
    }
    if (
      current.remediation.state === "APPLIED" ||
      current.remediation.state === "VERIFYING"
    ) {
      failure.decision = current.remediation.decision;
      failure.policyReadback = current.remediation.policyReadback;
    }
    if (current.remediation.state === "VERIFYING") {
      failure.verification = current.remediation.verification;
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

  readLatest(): DurableIncidentRead | undefined {
    const row = this.#database
      .prepare(
        "SELECT record_json FROM incidents ORDER BY rowid DESC LIMIT 1",
      )
      .get();
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
    return this.#writeIncident(incident);
  }

  #writeIncident(incident: DurableIncidentRead): DurableIncidentRead {
    this.#database
      .prepare("UPDATE incidents SET record_json = ? WHERE incident_id = ?")
      .run(JSON.stringify(incident), incident.incidentId);
    return incident;
  }
}

function migrateIncidentRecords(database: DatabaseSync): void {
  const version = remediationStoreVersionSchema.safeParse(
    database
      .prepare(
        "SELECT schema_version FROM remediation_schema_metadata WHERE singleton = 1",
      )
      .get(),
  );
  if (version.success && version.data.schema_version >= REMEDIATION_STORE_VERSION) {
    return;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const rows = database
      .prepare("SELECT incident_id, record_json FROM incidents")
      .all();
    for (const sourceRow of rows) {
      const row = migrationRowSchema.parse(sourceRow);
      const incident = decodeLegacyIncident(
        legacyIncidentSchema.parse(JSON.parse(row.record_json)),
      );
      database
        .prepare("UPDATE incidents SET record_json = ? WHERE incident_id = ?")
        .run(JSON.stringify(incident), row.incident_id);
    }
    database
      .prepare(
        `INSERT INTO remediation_schema_metadata (singleton, schema_version)
         VALUES (1, ?)
         ON CONFLICT(singleton) DO UPDATE SET schema_version = excluded.schema_version`,
      )
      .run(REMEDIATION_STORE_VERSION);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function decodeLegacyIncident(
  legacy: z.infer<typeof legacyIncidentSchema>,
): DurableIncidentRead {
  const legacyLifecycle = legacy.remediation.lifecycle ?? [];
  const lifecycle =
    legacy.remediation.state === "VALIDATION_FAILED" &&
    legacyLifecycle.at(-1)?.state !== "VALIDATION_FAILED"
      ? [
          ...legacyLifecycle,
          {
            occurredAt: new Date().toISOString(),
            state: "VALIDATION_FAILED" as const,
          },
        ]
      : legacyLifecycle;
  const normalized = {
    ...legacy,
    incidentStatus:
      legacy.incidentStatus ??
      (legacy.remediation.state === "VERIFIED" ? "RESOLVED" : "OPEN"),
    remediation: { ...legacy.remediation, lifecycle },
  };
  const current = durableIncidentReadSchema.safeParse(normalized);
  if (current.success) return current.data;

  const pending = z
    .object({
      actionId: z.string(),
      callId: z.string(),
      sessionId: z.string(),
      threadId: z.string().optional(),
      toolName: z.literal("apply_policy_patch"),
      turnId: z.string(),
    })
    .safeParse(legacy.remediation.pendingDecision);
  if (pending.success && pending.data.threadId === undefined) {
    const dryRun = policyPatchDryRunSchema.safeParse(
      legacy.remediation.dryRun,
    );
    const failure: z.infer<typeof validationFailedSchema> = {
      error:
        "Persisted pending action predates required thread identity and cannot be safely resumed",
      lifecycle: [
        ...legacyLifecycle,
        {
          occurredAt: new Date().toISOString(),
          state: "VALIDATION_FAILED",
        },
      ],
      state: "VALIDATION_FAILED",
    };
    if (dryRun.success) failure.dryRun = dryRun.data;
    return durableIncidentReadSchema.parse({
      baseline: legacy.baseline,
      incidentId: legacy.incidentId,
      incidentStatus: "OPEN",
      remediation: failure,
    });
  }
  throw current.error;
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
