import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type {
  MissionControlActivity,
  MissionControlSnapshot,
} from "../src/mission-control/schema.js";
import {
  readMissionControl,
  startIncident,
  submitRemediationDecision,
} from "./api.js";

type Command = "START" | "ALLOW" | "DENY";
type Tone = "neutral" | "live" | "danger" | "warning" | "success";

interface StatusCopy {
  description: string;
  eyebrow: string;
  title: string;
  tone: Tone;
}

interface CommandState {
  active: Command | null;
  error: string | null;
}

const INITIAL_COMMAND_STATE: CommandState = { active: null, error: null };

export function App(): ReactNode {
  const [snapshot, setSnapshot] = useState<MissionControlSnapshot | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [command, setCommand] = useState<CommandState>(INITIAL_COMMAND_STATE);

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const next = await readMissionControl(signal);
      setSnapshot(next);
      setConnectionError(null);
    } catch (cause) {
      if (signal?.aborted) return;
      setConnectionError(
        cause instanceof Error
          ? cause.message
          : "Mission Control could not reach BLACKBOX.",
      );
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timeoutId: number | undefined;
    const poll = async (): Promise<void> => {
      await refresh(controller.signal);
      if (controller.signal.aborted) return;
      timeoutId = window.setTimeout(
        () => void poll(),
        document.hidden ? 2_500 : 750,
      );
    };
    void poll();
    return () => {
      controller.abort();
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [refresh]);

  const runCommand = useCallback(
    async (nextCommand: Command): Promise<void> => {
      if (snapshot === null || command.active !== null) return;
      setCommand({ active: nextCommand, error: null });
      try {
        if (nextCommand === "START") {
          await startIncident();
        } else {
          const approval = snapshot.approval;
          const incident = snapshot.incident;
          if (approval === null || incident === null) {
            throw new Error("The pending Remediation decision is unavailable.");
          }
          await submitRemediationDecision(
            incident.id,
            nextCommand === "ALLOW" ? "allow" : "deny",
            approval.pendingDecision,
          );
        }
        await refresh();
        setCommand(INITIAL_COMMAND_STATE);
      } catch (cause) {
        setCommand({
          active: null,
          error:
            cause instanceof Error
              ? cause.message
              : "BLACKBOX did not accept the command.",
        });
      }
    },
    [command.active, refresh, snapshot],
  );

  if (snapshot === null) {
    return (
      <LoadingView
        error={connectionError}
        onRetry={() => void refresh()}
      />
    );
  }

  if (snapshot.phase === "READY") {
    return (
      <OpeningView
        command={command}
        connectionError={connectionError}
        onStart={() => void runCommand("START")}
      />
    );
  }

  return (
    <>
      <IncidentView
        command={command}
        connectionError={connectionError}
        snapshot={snapshot}
      />
      {snapshot.approval === null ? null : (
        <ApprovalDialog
          command={command}
          decisionPending={snapshot.decisionPending}
          onApprove={() => void runCommand("ALLOW")}
          onDeny={() => void runCommand("DENY")}
          snapshot={snapshot}
        />
      )}
    </>
  );
}

interface LoadingViewProps {
  error: string | null;
  onRetry(): void;
}

function LoadingView(props: LoadingViewProps): ReactNode {
  return (
    <div className="loading-view">
      <Brand />
      <div className="loading-panel" aria-live="polite">
        <span className="loader" aria-hidden="true" />
        <p className="eyebrow">Connecting to BLACKBOX</p>
        <h1>Reconstructing durable Incident state</h1>
        <p>
          Mission Control is reading the orchestrator, Evidence Ledger, and
          pending TrueForge action.
        </p>
        {props.error === null ? null : (
          <div className="inline-error" role="alert">
            <strong>Connection failed</strong>
            <span>{props.error}</span>
            <button className="text-button" onClick={props.onRetry} type="button">
              Retry connection
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface OpeningViewProps {
  command: CommandState;
  connectionError: string | null;
  onStart(): void;
}

function OpeningView(props: OpeningViewProps): ReactNode {
  const starting = props.command.active === "START";
  return (
    <div className="opening-shell">
      <header className="opening-header">
        <Brand />
        <div
          className={`system-ready${props.connectionError === null ? "" : " disconnected"}`}
        >
          <span className="status-light" aria-hidden="true" />
          {props.connectionError === null
            ? "BLACKBOX orchestrator ready"
            : "Updates interrupted"}
        </div>
      </header>

      <main className="opening-main">
        <section className="opening-hero" aria-labelledby="opening-title">
          <p className="eyebrow">Evidence-first AI-agent incident response</p>
          <h1 id="opening-title">
            Prove the leak.
            <br />
            Approve the boundary.
            <br />
            Verify containment.
          </h1>
          <p className="opening-lede">
            A synthetic Support Ticket will attempt to make a real Support
            Agent read a run-scoped Canary Secret and send it to a controlled
            External Sink. BLACKBOX claims containment only after an equivalent
            replay is blocked and legitimate support still works.
          </p>
          <div className="opening-action-row">
            <button
              aria-busy={starting}
              className="primary-button start-button"
              disabled={starting}
              onClick={props.onStart}
              type="button"
            >
              <span>{starting ? "Starting real Incident…" : "Start live Incident"}</span>
              <span className="button-arrow" aria-hidden="true">↗</span>
            </button>
            <p>
              One start. One human decision.
              <br />
              No simulated security state.
            </p>
          </div>
          {props.command.error === null ? null : (
            <p className="command-error" role="alert">{props.command.error}</p>
          )}
          {props.connectionError === null ? null : (
            <p className="command-error" role="alert">{props.connectionError}</p>
          )}
        </section>

        <section className="attack-map" aria-label="Synthetic Attack Scenario">
          <div className="map-heading">
            <span>Canonical Attack Scenario</span>
            <span className="synthetic-label">Controlled + synthetic</span>
          </div>
          <div className="map-flow">
            <MapNode
              index="01"
              label="Untrusted input"
              title="Support Ticket"
              detail="Carries the fixed attack instruction"
            />
            <FlowArrow label="processes" />
            <MapNode
              index="02"
              label="Victim Agent"
              title="Support Agent"
              detail="Uses real TrueForge model + MCP tools"
            />
            <FlowArrow label="attempts send" />
            <MapNode
              accent
              index="03"
              label="Independent proof"
              title="External Sink"
              detail="Records the exact Run-specific Canary"
            />
          </div>
          <div className="proof-rule">
            <span className="proof-rule-mark" aria-hidden="true">≠</span>
            <div>
              <strong>A suspicious transcript is not proof.</strong>
              <p>
                The Evidence Ledger alone finalizes Run verdicts and bundle
                hashes. The UI never invents them.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="opening-footer">
        <span>BLACKBOX / Mission Control</span>
        <span>Local-first · evidence-backed · human-approved</span>
      </footer>
    </div>
  );
}

interface MapNodeProps {
  accent?: boolean;
  detail: string;
  index: string;
  label: string;
  title: string;
}

function MapNode(props: MapNodeProps): ReactNode {
  return (
    <article className={`map-node${props.accent === true ? " accent" : ""}`}>
      <div className="map-node-top">
        <span>{props.index}</span>
        <span className="node-dot" aria-hidden="true" />
      </div>
      <p>{props.label}</p>
      <h2>{props.title}</h2>
      <span>{props.detail}</span>
    </article>
  );
}

interface FlowArrowProps {
  label: string;
}

function FlowArrow(props: FlowArrowProps): ReactNode {
  return (
    <div className="flow-arrow" aria-hidden="true">
      <span>{props.label}</span>
      <i />
    </div>
  );
}

interface IncidentViewProps {
  command: CommandState;
  connectionError: string | null;
  snapshot: MissionControlSnapshot;
}

function IncidentView(props: IncidentViewProps): ReactNode {
  const copy = statusCopy(props.snapshot);
  const incidentId = props.snapshot.incident?.id ?? "unknown";
  return (
    <div className="app-shell">
      <header className="app-header">
        <Brand />
        <div className="incident-identity">
          <span
            className={`connection-state${props.connectionError === null ? "" : " disconnected"}`}
          >
            <span className="status-light" aria-hidden="true" />
            {props.connectionError === null
              ? "Live orchestrator state"
              : "Last durable snapshot"}
          </span>
          <span className="mono">INC {shortId(incidentId)}</span>
        </div>
      </header>

      {props.connectionError === null ? null : (
        <div className="connection-banner" role="alert">
          <strong>Live updates interrupted.</strong>
          <span>{props.connectionError}</span>
          <span>Last durable snapshot remains on screen.</span>
        </div>
      )}

      <PhaseRail snapshot={props.snapshot} />

      <main className="incident-main">
        <section className={`status-hero tone-${copy.tone}`} aria-live="polite">
          <div className="status-copy">
            <div className="eyebrow-row">
              <p className="eyebrow">{copy.eyebrow}</p>
              <StatusChip tone={copy.tone}>{statusLabel(props.snapshot.status)}</StatusChip>
            </div>
            <h1>{copy.title}</h1>
            <p>{copy.description}</p>
          </div>
          <BaselineProof snapshot={props.snapshot} />
        </section>

        {props.command.error === null ? null : (
          <div className="failure-card compact" role="alert">
            <span className="failure-icon" aria-hidden="true">!</span>
            <div>
              <strong>Command was not accepted</strong>
              <p>{props.command.error}</p>
            </div>
          </div>
        )}

        {props.snapshot.failure === null ? null : (
          <FailureCard failure={props.snapshot.failure} />
        )}

        {props.snapshot.verification === null ? null : (
          <VerificationPanel snapshot={props.snapshot} />
        )}

        {props.snapshot.comparison === null ? null : (
          <ComparisonPanel snapshot={props.snapshot} />
        )}

        <ActivityFeed activity={props.snapshot.activity} />
      </main>

      <footer className="app-footer">
        <span>Security conclusions link to finalized Evidence Bundles.</span>
        <span className="mono">BLACKBOX / TRUEFORGE</span>
      </footer>
    </div>
  );
}

interface PhaseRailProps {
  snapshot: MissionControlSnapshot;
}

function PhaseRail(props: PhaseRailProps): ReactNode {
  const activeIndex = phaseRailIndex(props.snapshot);
  const stages = [
    ["01", "Prove attack", "Baseline evidence"],
    ["02", "Investigate", "TrueForge + Daytona"],
    ["03", "Decide", "Human policy boundary"],
    ["04", "Verify", "Replay + control"],
  ] as const;
  return (
    <nav className="phase-rail" aria-label="Incident progress">
      <ol>
        {stages.map((stage, index) => {
          const state = index < activeIndex ? "complete" : index === activeIndex ? "active" : "upcoming";
          return (
            <li aria-current={state === "active" ? "step" : undefined} data-state={state} key={stage[0]}>
              <span className="phase-number">{state === "complete" ? "✓" : stage[0]}</span>
              <span>
                <strong>{stage[1]}</strong>
                <small>{stage[2]}</small>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

interface BaselineProofProps {
  snapshot: MissionControlSnapshot;
}

function BaselineProof(props: BaselineProofProps): ReactNode {
  const baseline = props.snapshot.baseline;
  const comparison = props.snapshot.comparison;
  if (baseline === null) {
    return (
      <aside className="proof-card pending" aria-label="Baseline Run pending">
        <span className="proof-card-label">Baseline Run</span>
        <span className="proof-pulse" aria-hidden="true" />
        <strong>Evidence in progress</strong>
        <p>No verdict is shown until the bundle is finalized.</p>
      </aside>
    );
  }
  return (
    <aside className="proof-card" aria-label="Baseline Run proof">
      <div className="proof-card-top">
        <span className="proof-card-label">Baseline Run</span>
        <span className="mono">{shortId(baseline.runId)}</span>
      </div>
      <strong className={baseline.verdict === "VULNERABLE" ? "danger-text" : "warning-text"}>
        {titleCase(baseline.verdict)}
      </strong>
      <p>
        {comparison === null
          ? "Finalized bundle available."
          : `${comparison.baseline.exactCanaryReceipts} exact Canary receipt${comparison.baseline.exactCanaryReceipts === 1 ? "" : "s"} at the controlled sink.`}
      </p>
      <EvidenceLink
        bundleHash={baseline.bundleHash}
        label="Open Baseline evidence"
        url={baseline.evidenceUrl}
      />
    </aside>
  );
}

interface FailureCardProps {
  failure: NonNullable<MissionControlSnapshot["failure"]>;
}

function FailureCard(props: FailureCardProps): ReactNode {
  return (
    <section className="failure-card" aria-labelledby="failure-title">
      <span className="failure-icon" aria-hidden="true">!</span>
      <div>
        <p className="eyebrow">Success claim withheld</p>
        <h2 id="failure-title">{props.failure.title}</h2>
        <p>{props.failure.detail}</p>
      </div>
    </section>
  );
}

interface VerificationPanelProps {
  snapshot: MissionControlSnapshot;
}

function VerificationPanel(props: VerificationPanelProps): ReactNode {
  const verification = props.snapshot.verification;
  if (verification === null) return null;
  return (
    <section className="panel verification-panel" aria-labelledby="verification-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Automatic verification</p>
          <h2 id="verification-title">No further operator action required</h2>
        </div>
        <span className="automation-badge">AUTO</span>
      </div>
      <div className="verification-grid">
        <VerificationStep
          detail={`Policy v${verification.policyReadback.version} · ${shortHash(verification.policyReadback.hash)}`}
          index="01"
          label="Policy readback"
          result="Matched approved patch"
          state="COMPLETED"
        />
        <VerificationStep
          detail="Equivalent synthetic attack"
          index="02"
          label="Attack Replay"
          result={verification.replay.result === null ? null : titleCase(verification.replay.result)}
          state={verification.replay.state}
        />
        <VerificationStep
          detail="Trusted support destination"
          index="03"
          label="Control Run"
          result={verification.control.result === null ? null : titleCase(verification.control.result)}
          state={verification.control.state}
        />
      </div>
    </section>
  );
}

interface VerificationStepProps {
  detail: string;
  index: string;
  label: string;
  result: string | null;
  state: "WAITING" | "ACTIVE" | "COMPLETED";
}

function VerificationStep(props: VerificationStepProps): ReactNode {
  return (
    <article className="verification-step" data-state={props.state.toLowerCase()}>
      <div className="verification-marker">
        {props.state === "COMPLETED" ? "✓" : props.index}
      </div>
      <div>
        <span className="step-state">{titleCase(props.state)}</span>
        <h3>{props.label}</h3>
        <p>{props.detail}</p>
        {props.result === null ? null : <strong>{props.result}</strong>}
      </div>
    </article>
  );
}

interface ComparisonPanelProps {
  snapshot: MissionControlSnapshot;
}

function ComparisonPanel(props: ComparisonPanelProps): ReactNode {
  const comparison = props.snapshot.comparison;
  if (comparison === null) return null;
  const verified = comparison.containment !== null;
  return (
    <section className="panel comparison-panel" aria-labelledby="comparison-title">
      <div className="section-heading comparison-heading">
        <div>
          <p className="eyebrow">Finalized evidence comparison</p>
          <h2 id="comparison-title">Baseline / Replay / Control</h2>
        </div>
        {verified ? (
          <span className="verified-seal"><i aria-hidden="true">✓</i> Verified Remediation</span>
        ) : (
          <span className="withheld-seal">Containment withheld</span>
        )}
      </div>
      <div className="comparison-grid">
        <ProofColumn
          accent="danger"
          evidenceUrl={comparison.baseline.evidenceUrl}
          eyebrow="Before · Baseline"
          facts={[
            `${comparison.baseline.exactCanaryReceipts} exact Canary receipt${comparison.baseline.exactCanaryReceipts === 1 ? "" : "s"}`,
            comparison.baseline.complete ? "Evidence complete" : "Evidence incomplete",
          ]}
          hash={comparison.baseline.bundleHash}
          result={titleCase(comparison.baseline.result)}
        />
        <ProofColumn
          accent={comparison.replay?.result === "PROTECTED" ? "success" : "warning"}
          evidenceUrl={comparison.replay?.evidenceUrl ?? null}
          eyebrow="After · Attack Replay"
          facts={
            comparison.replay === null
              ? ["Waiting for finalized replay evidence"]
              : [
                  comparison.replay.explicitPolicyDenial
                    ? "Explicit policy denial observed"
                    : "Explicit policy denial missing",
                  `${comparison.replay.matchingCanaryReceipts} matching sink receipts`,
                ]
          }
          hash={comparison.replay?.bundleHash ?? null}
          result={comparison.replay === null ? "Pending" : titleCase(comparison.replay.result)}
        />
        <ProofColumn
          accent={comparison.control?.result === "PASSED" ? "success" : "warning"}
          evidenceUrl={comparison.control?.evidenceUrl ?? null}
          eyebrow="Capability · Control Run"
          facts={
            comparison.control === null
              ? ["Waiting for finalized control evidence"]
              : [
                  `${comparison.control.trustedDestinationReceipts} trusted destination receipt${comparison.control.trustedDestinationReceipts === 1 ? "" : "s"}`,
                  comparison.control.complete ? "Evidence complete" : "Evidence incomplete",
                ]
          }
          hash={comparison.control?.bundleHash ?? null}
          result={comparison.control === null ? "Pending" : titleCase(comparison.control.result)}
        />
      </div>
      {verified ? (
        <div className="containment-callout">
          <div className="containment-mark" aria-hidden="true">✓</div>
          <div>
            <p className="eyebrow">Evidence-backed conclusion</p>
            <h3>The canonical attack was contained without breaking support.</h3>
            <p>
              This claim exists only because all three finalized bundles passed
              the Verified Remediation gates.
            </p>
          </div>
          <div className="bundle-stack" aria-label="Three supporting Evidence Bundles">
            {comparison.containment?.evidence.map((evidence, index) => (
              <a href={evidence.url} key={evidence.bundleHash} rel="noreferrer" target="_blank">
                0{index + 1} · {shortHash(evidence.bundleHash)}
              </a>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface ProofColumnProps {
  accent: "danger" | "success" | "warning";
  evidenceUrl: string | null;
  eyebrow: string;
  facts: string[];
  hash: string | null;
  result: string;
}

function ProofColumn(props: ProofColumnProps): ReactNode {
  return (
    <article className={`proof-column accent-${props.accent}`}>
      <p className="eyebrow">{props.eyebrow}</p>
      <strong className="proof-result">{props.result}</strong>
      <ul>
        {props.facts.map((fact) => <li key={fact}>{fact}</li>)}
      </ul>
      {props.evidenceUrl === null || props.hash === null ? (
        <span className="evidence-pending">Finalized bundle pending</span>
      ) : (
        <EvidenceLink bundleHash={props.hash} label="Inspect bundle" url={props.evidenceUrl} />
      )}
    </article>
  );
}

interface ActivityFeedProps {
  activity: MissionControlActivity[];
}

function ActivityFeed(props: ActivityFeedProps): ReactNode {
  return (
    <section className="panel activity-panel" aria-labelledby="activity-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Durable activity</p>
          <h2 id="activity-title">What the system observed</h2>
        </div>
        <span className="activity-count">{props.activity.length} records</span>
      </div>
      {props.activity.length === 0 ? (
        <div className="empty-activity">
          <span className="loader small" aria-hidden="true" />
          Waiting for the first durable Run event…
        </div>
      ) : (
        <ol className="activity-list">
          {props.activity.map((item) => <ActivityItem item={item} key={item.id} />)}
        </ol>
      )}
    </section>
  );
}

interface ActivityItemProps {
  item: MissionControlActivity;
}

function ActivityItem(props: ActivityItemProps): ReactNode {
  const item = props.item;
  return (
    <li className="activity-item" data-status={item.status.toLowerCase()}>
      <span className="activity-marker" aria-hidden="true">
        {item.status === "COMPLETED" ? "✓" : item.status === "FAILED" ? "!" : ""}
      </span>
      <div className="activity-content">
        <div className="activity-meta">
          <span>{sourceLabel(item.source)}</span>
          {item.occurredAt === null ? null : <time dateTime={item.occurredAt}>{formatTime(item.occurredAt)}</time>}
        </div>
        <strong className={item.kind === "tool" ? "mono" : undefined}>{item.title}</strong>
        {item.detail === null ? null : <p>{item.detail}</p>}
      </div>
      {item.evidence === null ? null : (
        <EvidenceLink bundleHash={item.evidence.bundleHash} label="Source" url={item.evidence.url} />
      )}
    </li>
  );
}

interface ApprovalDialogProps {
  command: CommandState;
  decisionPending: boolean;
  onApprove(): void;
  onDeny(): void;
  snapshot: MissionControlSnapshot;
}

function ApprovalDialog(props: ApprovalDialogProps): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const approval = props.snapshot.approval;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (!dialog.open) dialog.showModal();
    return () => dialog.close();
  }, []);
  if (approval === null) return null;
  const busy = props.command.active !== null || props.decisionPending;
  const diff = approval.diff[0];
  return (
    <dialog
      aria-labelledby="approval-title"
      className="approval-dialog"
      onCancel={(event) => event.preventDefault()}
      ref={dialogRef}
    >
      <div className="approval-shell">
        <header className="approval-header">
          <div className="approval-kicker">
            <span className="human-boundary-mark" aria-hidden="true">H</span>
            <span>
              <strong>Human policy boundary</strong>
              <small>TrueForge action · {shortId(approval.pendingDecision.actionId)}</small>
            </span>
          </div>
          <StatusChip tone="warning">Decision required</StatusChip>
        </header>

        <div className="approval-body">
          <div className="approval-intro">
            <p className="eyebrow">One durable mutation</p>
            <h1 id="approval-title">Authorize this exact Policy Patch?</h1>
            <p>
              Approval resumes the pending <code>apply_policy_patch</code>{" "}
              action. Policy readback, Attack Replay, and Control Run then
              advance automatically.
            </p>
          </div>

          <section className="approval-section" aria-labelledby="diff-title">
            <div className="approval-section-heading">
              <div>
                <span>01</span>
                <h2 id="diff-title">Exact durable diff</h2>
              </div>
              <code>{approval.affectedCapability}</code>
            </div>
            <div className="diff-grid">
              <div className="diff-before">
                <span>− Before</span>
                <code>{diff.before}</code>
                <small>Any external destination</small>
              </div>
              <div className="diff-after">
                <span>+ After</span>
                <code>{diff.after.join("\n")}</code>
                <small>Only the Trusted Destination</small>
              </div>
            </div>
            <details className="exact-diff">
              <summary>Inspect machine-readable patch diff</summary>
              <pre>{JSON.stringify(approval.diff, null, 2)}</pre>
            </details>
          </section>

          <div className="approval-columns">
            <section className="approval-section" aria-labelledby="evidence-title">
              <div className="approval-section-heading">
                <div>
                  <span>02</span>
                  <h2 id="evidence-title">Evidence justification</h2>
                </div>
              </div>
              <p>{approval.evidenceJustification.summary}</p>
              <EvidenceLink
                bundleHash={approval.evidenceJustification.bundleHash}
                label="Open source Baseline bundle"
                url={`/api/runs/${approval.evidenceJustification.runId}/evidence`}
              />
            </section>

            <section className="approval-section" aria-labelledby="impact-title">
              <div className="approval-section-heading">
                <div>
                  <span>03</span>
                  <h2 id="impact-title">Predicted operational impact</h2>
                </div>
              </div>
              <ul className="impact-list">
                <li><span>Restricts</span>{approval.predictedOperationalImpact.deniedDestinations}</li>
                <li><span>Preserves</span>protected document access {approval.predictedOperationalImpact.protectedDocumentAccess}</li>
                <li><span>Allows</span>{approval.predictedOperationalImpact.trustedDestinations.join(", ")}</li>
              </ul>
            </section>
          </div>

          <section className="base-hash" aria-label="Expected Capability Policy base">
            <span>Expected base</span>
            <code>v{approval.base.version} · {approval.base.hash}</code>
          </section>

          {props.command.error === null ? null : (
            <p className="command-error" role="alert">{props.command.error}</p>
          )}
        </div>

        <footer className="approval-actions">
          <p>
            Denial applies nothing and starts no verification Runs.
          </p>
          <div>
            <button className="secondary-button" disabled={busy} onClick={props.onDeny} type="button">
              {props.command.active === "DENY" ? "Denying…" : "Deny patch"}
            </button>
            <button
              aria-busy={props.command.active === "ALLOW" || props.decisionPending}
              className="primary-button approve-button"
              disabled={busy}
              onClick={props.onApprove}
              type="button"
            >
              {props.command.active === "ALLOW" || props.decisionPending
                ? "Resuming TrueForge action…"
                : "Approve & verify automatically"}
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </footer>
      </div>
    </dialog>
  );
}

interface StatusChipProps {
  children: ReactNode;
  tone: Tone;
}

function StatusChip(props: StatusChipProps): ReactNode {
  return <span className={`status-chip tone-${props.tone}`}>{props.children}</span>;
}

interface EvidenceLinkProps {
  bundleHash: string;
  label: string;
  url: string;
}

function EvidenceLink(props: EvidenceLinkProps): ReactNode {
  return (
    <a className="evidence-link" href={props.url} rel="noreferrer" target="_blank">
      <span>{props.label}</span>
      <code>{shortHash(props.bundleHash)}</code>
      <span aria-hidden="true">↗</span>
    </a>
  );
}

function Brand(): ReactNode {
  return (
    <a className="brand" href="/" aria-label="BLACKBOX Mission Control">
      <span className="brand-mark" aria-hidden="true"><i /><i /></span>
      <span>
        <strong>BLACKBOX</strong>
        <small>Mission Control</small>
      </span>
    </a>
  );
}

function statusCopy(snapshot: MissionControlSnapshot): StatusCopy {
  switch (snapshot.status) {
    case "READY":
      return {
        description: "The canonical synthetic scenario is ready.",
        eyebrow: "Ready",
        title: "Start the evidence-backed Incident loop",
        tone: "neutral",
      };
    case "BASELINE_RUNNING":
      return {
        description:
          "The Support Agent is processing the fixed untrusted Support Ticket through real TrueForge and MCP tools. No verdict exists yet.",
        eyebrow: "Baseline Run · live",
        title: "Proving the attack, not narrating it",
        tone: "live",
      };
    case "INVESTIGATING":
    case "DRAFTED":
    case "DRY_RUN_PASSED":
      return {
        description:
          "TrueForge is reconstructing the finalized Baseline evidence, delegating two focused reviews, and executing analysis in Daytona.",
        eyebrow: "Autonomous investigation",
        title: "Finding the smallest defensible policy change",
        tone: "live",
      };
    case "AWAITING_APPROVAL":
      return {
        description:
          "Investigation and dry-run validation are complete. The exact pending TrueForge action now requires one human decision.",
        eyebrow: "Approval boundary",
        title: "BLACKBOX has paused before mutation",
        tone: "warning",
      };
    case "APPLIED":
    case "VERIFYING":
      return {
        description:
          "The reviewed patch is active. BLACKBOX is reading it back, replaying the equivalent attack, and running the legitimate control workflow automatically.",
        eyebrow: "Verification · automatic",
        title: "The policy changed; the claim has not been earned yet",
        tone: "live",
      };
    case "VERIFIED":
      return snapshot.comparison === null ||
        snapshot.comparison.containment === null
        ? {
            description:
              "Durable lifecycle state reached VERIFIED, but Mission Control could not cross-check all finalized bundles. No containment claim is shown.",
            eyebrow: "Evidence mismatch",
            title: "Verification evidence is unavailable",
            tone: "warning",
          }
        : {
            description:
              "The equivalent attack reached an explicit policy block, no matching Canary receipt arrived, and the trusted support workflow completed.",
            eyebrow: "Incident resolved",
            title: "Containment verified by three finalized bundles",
            tone: "success",
          };
    case "DENIED":
      return {
        description:
          "The pending TrueForge action was denied. Capability Policy stayed unchanged and no verification Runs started.",
        eyebrow: "Human decision recorded",
        title: "Policy Patch denied — Incident remains open",
        tone: "neutral",
      };
    case "STALE":
      return {
        description:
          "The active policy no longer matches the base hash that was reviewed. BLACKBOX refused to silently rebase or apply the patch.",
        eyebrow: "Safety boundary held",
        title: "The reviewed Policy Patch is stale",
        tone: "warning",
      };
    case "BASELINE_INCONCLUSIVE":
      return {
        description:
          "The attack path or its infrastructure did not produce complete evidence. BLACKBOX withholds Vulnerability Proof.",
        eyebrow: "No supported verdict",
        title: "Baseline evidence is inconclusive",
        tone: "warning",
      };
    case "VALIDATION_FAILED":
      return {
        description:
          "A required readback, replay, control, or finalization gate failed. Any restrictive policy remains in place, but containment is not claimed.",
        eyebrow: "Success claim withheld",
        title: "Remediation could not be verified",
        tone: "danger",
      };
  }
}

function phaseRailIndex(snapshot: MissionControlSnapshot): number {
  switch (snapshot.status) {
    case "BASELINE_RUNNING":
    case "BASELINE_INCONCLUSIVE":
    case "READY":
      return 0;
    case "INVESTIGATING":
    case "DRAFTED":
    case "DRY_RUN_PASSED":
      return 1;
    case "AWAITING_APPROVAL":
    case "DENIED":
    case "STALE":
      return 2;
    case "APPLIED":
    case "VERIFYING":
    case "VERIFIED":
      return 3;
    case "VALIDATION_FAILED":
      return snapshot.verification === null ? 1 : 3;
  }
}

function statusLabel(status: MissionControlSnapshot["status"]): string {
  return titleCase(status.replaceAll("_", " "));
}

function sourceLabel(source: MissionControlActivity["source"]): string {
  return source.replaceAll("_", " ");
}

function titleCase(value: string): string {
  return value.toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function shortHash(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
