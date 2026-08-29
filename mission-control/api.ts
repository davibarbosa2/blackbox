import {
  type MissionControlSnapshot,
  missionControlSnapshotSchema,
} from "../src/mission-control/schema.js";

export async function readMissionControl(
  signal?: AbortSignal,
): Promise<MissionControlSnapshot> {
  const request: RequestInit = { cache: "no-store" };
  if (signal !== undefined) request.signal = signal;
  const response = await fetch("/api/mission-control", request);
  if (!response.ok) {
    throw new Error(`Mission Control read failed with HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  return missionControlSnapshotSchema.parse(body);
}

export async function startIncident(): Promise<void> {
  const response = await fetch("/api/incidents", { method: "POST" });
  if (!response.ok && response.status !== 409) {
    throw new Error(`Incident start failed with HTTP ${response.status}`);
  }
}

export async function submitRemediationDecision(
  incidentId: string,
  decision: "allow" | "deny",
  pendingDecision: NonNullable<
    MissionControlSnapshot["approval"]
  >["pendingDecision"],
): Promise<void> {
  const response = await fetch(
    `/api/incidents/${incidentId}/remediation-decisions`,
    {
      body: JSON.stringify({ decision, pendingDecision }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  if (!response.ok) {
    throw new Error(
      `Remediation decision failed with HTTP ${response.status}`,
    );
  }
}
