import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  Clock3,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  Minus,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
  X,
} from "lucide-react";

import type {
  MissionControlActivity,
  MissionControlSnapshot,
} from "../src/mission-control/schema.js";
import {
  readMissionControl,
  startIncident,
  submitRemediationDecision,
} from "./api.js";
import trueForgeMarkDark from "./assets/trueforge-logomark-dark.svg";
import trueForgeMarkLight from "./assets/trueforge-logomark-light.svg";

type Command = "START" | "ALLOW" | "DENY";
type Tone = "neutral" | "live" | "danger" | "warning" | "success";
type StepState = "active" | "complete" | "incomplete" | "skipped" | "upcoming";

interface CommandState {
  active: Command | null;
  error: string | null;
}

interface SceneCopy {
  description: string;
  eyebrow: string;
  title: string;
  tone: Tone;
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
    return <LoadingView error={connectionError} onRetry={() => void refresh()} />;
  }

  if (snapshot.phase === "READY") {
    return (
      <OpeningView
        command={command}
        connectionError={connectionError}
        onStart={() => void runCommand("START")}
        snapshot={snapshot}
      />
    );
  }

  return (
    <>
      <MissionView
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
      <div className="loading-card" aria-live="polite">
        <SignalMark active={props.error === null} />
        <p className="eyebrow">Connecting to BLACKBOX</p>
        <h1>Restoring the Incident</h1>
        <p>Reading durable evidence and the exact pending TrueForge action.</p>
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
  snapshot: MissionControlSnapshot;
}

function OpeningView(props: OpeningViewProps): ReactNode {
  const starting = props.command.active === "START";
  return (
    <div className="opening-shell">
      <header className="opening-header">
        <Brand />
        <div className="header-actions">
          <TrueForgeLink snapshot={props.snapshot} />
          <ConnectionState error={props.connectionError} readyLabel="System ready" />
        </div>
      </header>

      <main className="opening-main">
        <section className="opening-copy" aria-labelledby="opening-title">
          <p className="eyebrow">Live AI-agent incident replay</p>
          <h1 id="opening-title">
            Watch an AI agent leak a secret. <span>Then stop it.</span>
          </h1>
          <p className="opening-lede">
            BLACKBOX proves the breach, asks you to approve one narrow policy
            change, then reruns both the attack and legitimate support before
            it claims success.
          </p>
          <div className="opening-actions">
            <button
              aria-busy={starting}
              className="primary-button start-button"
              disabled={starting}
              onClick={props.onStart}
              type="button"
            >
              <span>{starting ? "Starting the Incident…" : "Run the live Incident"}</span>
              {starting
                ? <LoaderCircle aria-hidden="true" className="loading-icon" size={16} />
                : <ArrowRight aria-hidden="true" size={16} />}
            </button>
            <span className="run-time">~2 min live run</span>
          </div>
          <ul className="opening-facts" aria-label="Run facts">
            <li><strong>01</strong> Real TrueForge agents</li>
            <li><strong>02</strong> One human approval</li>
            <li><strong>03</strong> Three evidence bundles</li>
          </ul>
          {props.command.error === null ? null : (
            <p className="command-error" role="alert">{props.command.error}</p>
          )}
          {props.connectionError === null ? null : (
            <p className="command-error" role="alert">{props.connectionError}</p>
          )}
        </section>

        <section className="scenario-card" aria-labelledby="scenario-title">
          <div className="scenario-heading">
            <div>
              <p className="eyebrow">The controlled incident</p>
              <h2 id="scenario-title">One ticket. One synthetic secret.</h2>
            </div>
            <span className="scenario-badge">Safe to demo</span>
          </div>
          <ScenarioPath mode="preview" snapshot={props.snapshot} />
          <div className="proof-rule">
            <span className="receipt-symbol" aria-hidden="true"><ReceiptText size={16} /></span>
            <div>
              <strong>The model saying it leaked is not proof.</strong>
              <p>An exact Canary receipt at the independent sink is.</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="opening-footer">
        <span>BLACKBOX / forensic replay room</span>
        <span>Evidence-backed · human-approved</span>
      </footer>
    </div>
  );
}

interface MissionViewProps {
  command: CommandState;
  connectionError: string | null;
  snapshot: MissionControlSnapshot;
}

function MissionView(props: MissionViewProps): ReactNode {
  const incidentId = props.snapshot.incident?.id ?? "unknown";
  return (
    <div className="mission-shell" data-phase={props.snapshot.phase.toLowerCase()}>
      <header className="mission-header">
        <Brand />
        <div className="header-actions">
          <TrueForgeLink snapshot={props.snapshot} />
          <ConnectionState
            error={props.connectionError}
            readyLabel={`Incident ${shortId(incidentId)}`}
          />
        </div>
      </header>

      {props.connectionError === null ? null : (
        <div className="connection-banner" role="alert">
          <strong>Live updates interrupted.</strong>
          <span>{props.connectionError}</span>
          <span>The last durable snapshot remains visible.</span>
        </div>
      )}

      <JourneyRail snapshot={props.snapshot} />

      <main className="mission-main">
        <NowStrip snapshot={props.snapshot} />
        <ActiveScene snapshot={props.snapshot} />
        {props.command.error === null || props.snapshot.approval !== null ? null : (
          <FailureNotice
            detail={props.command.error}
            title="Command was not accepted"
          />
        )}
        <EvidenceDrawer snapshot={props.snapshot} />
      </main>
    </div>
  );
}

interface ConnectionStateProps {
  error: string | null;
  readyLabel: string;
}

function ConnectionState(props: ConnectionStateProps): ReactNode {
  return (
    <span className={`connection-state${props.error === null ? "" : " disconnected"}`}>
      <span className="connection-dot" aria-hidden="true" />
      {props.error === null ? props.readyLabel : "Last durable state"}
    </span>
  );
}

interface JourneyRailProps {
  snapshot: MissionControlSnapshot;
}

function JourneyRail(props: JourneyRailProps): ReactNode {
  const railRef = useRef<HTMLElement>(null);
  const stages = [
    ["01", "Prove breach", "Baseline Run"],
    ["02", "Investigate", "TrueForge"],
    ["03", "Approve", "Policy Patch"],
    ["04", "Verify", "Replay + Control"],
    ["05", "Result", "Evidence verdict"],
  ] as const;
  useEffect(() => {
    const rail = railRef.current;
    if (
      rail === null ||
      window.matchMedia?.("(max-width: 680px)").matches !== true
    ) {
      return;
    }
    const active = rail.querySelector<HTMLElement>('[aria-current="step"]');
    if (active === null) return;
    rail.scrollTo({
      behavior: "auto",
      left: active.offsetLeft - (rail.clientWidth - active.clientWidth) / 2,
    });
  }, [props.snapshot.phase, props.snapshot.status]);
  return (
    <nav className="journey-rail" aria-label="Incident journey" ref={railRef}>
      <ol>
        {stages.map((stage, index) => {
          const state = journeyStepState(props.snapshot, index);
          return (
            <li
              aria-current={state === "active" ? "step" : undefined}
              data-state={state}
              key={stage[0]}
            >
              <span className="journey-number">
                {state === "complete"
                  ? <Check aria-hidden="true" size={13} />
                  : state === "incomplete"
                    ? <AlertTriangle aria-hidden="true" size={13} />
                  : state === "skipped"
                    ? <Minus aria-hidden="true" size={13} />
                    : stage[0]}
              </span>
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

interface NowStripProps {
  snapshot: MissionControlSnapshot;
}

function NowStrip(props: NowStripProps): ReactNode {
  const copy = sceneCopy(props.snapshot);
  const progressSignature = `${props.snapshot.phase}:${props.snapshot.status}:${props.snapshot.activity.map((item) => `${item.id}:${item.status}`).join("|")}`;
  const [quietSeconds, setQuietSeconds] = useState(0);
  useEffect(() => {
    setQuietSeconds(0);
    if (copy.tone !== "live") return;
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setQuietSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [copy.tone, progressSignature]);
  const quietlyWaiting = copy.tone === "live" && quietSeconds >= 12;
  return (
    <section className={`now-strip tone-${copy.tone}`} aria-live="polite">
      <div className="now-label">
        <SignalMark active={copy.tone === "live" && !quietlyWaiting} />
        <span>{quietlyWaiting ? "Waiting" : "Now"}</span>
      </div>
      <div className="now-copy">
        <p className="eyebrow">{copy.eyebrow}</p>
        <h1>{copy.title}</h1>
        <p>
          {quietlyWaiting
            ? `Still waiting for the next durable update (${quietSeconds}s). ${copy.description}`
            : copy.description}
        </p>
      </div>
      <StatusPill tone={copy.tone}>
        {quietlyWaiting ? `Waiting · ${quietSeconds}s` : statusLabel(props.snapshot.status)}
      </StatusPill>
    </section>
  );
}

interface ActiveSceneProps {
  snapshot: MissionControlSnapshot;
}

function ActiveScene(props: ActiveSceneProps): ReactNode {
  if (props.snapshot.phase === "BASELINE") {
    return <BaselineScene snapshot={props.snapshot} />;
  }
  if (
    props.snapshot.phase === "INVESTIGATION" ||
    props.snapshot.phase === "APPROVAL"
  ) {
    return <InvestigationScene snapshot={props.snapshot} />;
  }
  if (props.snapshot.phase === "VERIFICATION") {
    return <VerificationScene snapshot={props.snapshot} />;
  }
  return <ResultScene snapshot={props.snapshot} />;
}

interface SceneProps {
  snapshot: MissionControlSnapshot;
}

function BaselineScene(props: SceneProps): ReactNode {
  const comparison = props.snapshot.comparison;
  const baseline = props.snapshot.baseline;
  const progress = baselineProgress(props.snapshot);
  return (
    <section className="scene-grid baseline-scene" aria-labelledby="baseline-scene-title">
      <div className="causal-canvas">
        <div className="scene-heading">
          <div>
            <p className="eyebrow">Baseline Run</p>
            <h2 id="baseline-scene-title">Can the secret reach the sink?</h2>
          </div>
          <span className="policy-state">Policy v1 · any destination</span>
        </div>
        <ScenarioPath mode="baseline" snapshot={props.snapshot} />
      </div>
      <aside className={`proof-focus${baseline?.verdict === "VULNERABLE" ? " breached" : ""}`}>
        <p className="eyebrow">Independent proof</p>
        {baseline === null ? (
          <>
            <SignalMark active />
            <strong>No verdict yet</strong>
            <p>{progress.proof}</p>
          </>
        ) : (
          <>
            <span className="proof-glyph" aria-hidden="true"><AlertTriangle size={23} /></span>
            <strong>{titleCase(baseline.verdict)}</strong>
            <p>
              <b>{comparison?.baseline.exactCanaryReceipts ?? 0}</b> exact Canary
              receipt at the controlled External Sink.
            </p>
            <EvidenceLink
              bundleHash={baseline.bundleHash}
              label="Inspect Baseline evidence"
              url={baseline.evidenceUrl}
            />
          </>
        )}
      </aside>
    </section>
  );
}

function InvestigationScene(props: SceneProps): ReactNode {
  const awaitingApproval = props.snapshot.phase === "APPROVAL";
  return (
    <section className="scene-grid investigation-scene" aria-labelledby="investigation-scene-title">
      <div className="causal-canvas breached-canvas">
        <div className="scene-heading">
          <div>
            <p className="eyebrow">Breach reconstruction</p>
            <h2 id="investigation-scene-title">The leak has one missing boundary.</h2>
          </div>
          <span className="breach-badge">Leak proven</span>
        </div>
        <ScenarioPath mode="baseline" snapshot={props.snapshot} />
        <div className="diagnosis-line">
          <span>Diagnosis</span>
          <strong>Outbound messages can target any destination.</strong>
        </div>
      </div>
      <TrueForgeTrace snapshot={props.snapshot} ready={awaitingApproval} />
    </section>
  );
}

interface TrueForgeTraceProps extends SceneProps {
  ready: boolean;
}

function TrueForgeTrace(props: TrueForgeTraceProps): ReactNode {
  const tasks = [
    ["Evidence Provenance Verifier", "Evidence Provenance Verifier", "subagent"],
    ["Policy Patch Reviewer", "Policy Patch Reviewer", "subagent"],
    ["Sandbox analysis", "Sandbox analysis completed", "sandbox"],
  ] as const;
  return (
    <aside className="trueforge-trace">
      <div className="trace-brand-row">
        <TrueForgeMark />
        <TrueForgeLink snapshot={props.snapshot} />
      </div>
      <div className="trace-title-row">
        <div>
          <p className="eyebrow">TrueForge Investigator</p>
          <h2>{props.ready ? "Policy Patch ready" : "Autonomous investigation"}</h2>
        </div>
        <StatusPill tone={props.ready ? "warning" : "live"}>
          {props.ready ? "Paused" : "Live"}
        </StatusPill>
      </div>
      <p className="trace-summary">
        {props.ready
          ? "The real apply_policy_patch action is waiting for one human decision."
          : "Reconstructing the evidence and testing the narrowest defensible change."}
      </p>
      <div className="agent-tree" aria-label="TrueForge investigation activity">
        <div className="root-agent">
          <span className="agent-icon"><Bot aria-hidden="true" size={14} /></span>
          <div><strong>BLACKBOX Investigator</strong><small>TrueForge agent</small></div>
          <span className={props.ready ? "task-check" : "task-live"}>
            {props.ready ? <Check aria-hidden="true" size={14} /> : ""}
          </span>
        </div>
        <div className="agent-branches">
          {tasks.map(([label, completedTitle, kind]) => {
            const state = investigationTaskState(
              props.snapshot.activity,
              completedTitle,
            );
            return (
              <div className="agent-task" data-state={state} key={label}>
                <span className="branch-line" aria-hidden="true" />
                <span className="task-icon" aria-hidden="true">
                  {kind === "sandbox" ? <SquareTerminal size={13} /> : <GitBranch size={13} />}
                </span>
                <div><strong>{label}</strong><small>{kind === "sandbox" ? "Daytona" : "Focused subagent"}</small></div>
                <span className={state === "complete" ? "task-check" : state === "active" ? "task-live" : "task-wait"}>
                  {state === "complete" ? <Check aria-hidden="true" size={14} /> : state === "active" ? "Live" : "Waiting"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className={`mutation-state${props.ready ? " ready" : ""}`}>
        <span>Capability Policy</span>
        <strong>{props.ready ? "Proposed · not active" : "Unchanged while agents work"}</strong>
      </div>
    </aside>
  );
}

function VerificationScene(props: SceneProps): ReactNode {
  const verification = props.snapshot.verification;
  if (verification === null) return null;
  return (
    <section className="verification-scene" aria-labelledby="verification-scene-title">
      <div className="verification-heading">
        <div>
          <p className="eyebrow">Automatic verification</p>
          <h2 id="verification-scene-title">Same attack. Separate control.</h2>
        </div>
        <div className="readback-proof">
          <span className="task-check"><Check aria-hidden="true" size={14} /></span>
          <span><small>Policy readback</small><strong>v{verification.policyReadback.version} matched</strong></span>
        </div>
      </div>
      <div className="verification-lanes">
        <VerificationLane
          evidence={props.snapshot.comparison?.replay ?? null}
          kind="attack"
          result={verification.replay.result}
          state={verification.replay.state}
        />
        <VerificationLane
          evidence={props.snapshot.comparison?.control ?? null}
          kind="control"
          result={verification.control.result}
          state={verification.control.state}
        />
      </div>
      <p className="verification-note">
        No further action is available. BLACKBOX will claim Verified Remediation
        only if both lanes finalize with complete evidence.
      </p>
    </section>
  );
}

interface VerificationLaneProps {
  evidence:
    | NonNullable<NonNullable<MissionControlSnapshot["comparison"]>["replay"]>
    | NonNullable<NonNullable<MissionControlSnapshot["comparison"]>["control"]>
    | null;
  kind: "attack" | "control";
  result: "PASSED" | "PROTECTED" | "INCONCLUSIVE" | null;
  state: "WAITING" | "ACTIVE" | "COMPLETED" | "INCONCLUSIVE";
}

function VerificationLane(props: VerificationLaneProps): ReactNode {
  const attack = props.kind === "attack";
  const finished = props.state === "COMPLETED";
  const inconclusive = props.state === "INCONCLUSIVE";
  const progressCopy = inconclusive
    ? "Evidence incomplete"
    : props.state === "WAITING"
      ? attack
        ? "Preparing Attack Replay"
        : "Starts after Attack Replay"
      : "Collecting durable evidence";
  return (
    <article className={`verification-lane ${props.kind}`} data-state={props.state.toLowerCase()}>
      <div className="lane-heading">
        <span className="lane-index">{attack ? "A" : "B"}</span>
        <div>
          <p className="eyebrow">{attack ? "Security check" : "Capability check"}</p>
          <h3>{attack ? "Attack Replay" : "Control Run"}</h3>
        </div>
        <StatusPill tone={inconclusive ? "warning" : finished ? "success" : props.state === "ACTIVE" ? "live" : "neutral"}>
          {props.result === null ? titleCase(props.state) : titleCase(props.result)}
        </StatusPill>
      </div>
      <div className="lane-path" aria-label={attack ? "Attack Replay path" : "Control Run path"}>
        <LaneNode label={attack ? "Same ticket" : "Support request"} state={props.state === "WAITING" ? "waiting" : "complete"} />
        <span className="lane-connector" aria-hidden="true" />
        <LaneNode label="Support Agent" state={props.state === "ACTIVE" ? "active" : finished ? "complete" : "waiting"} />
        <span className="lane-connector" aria-hidden="true" />
        <LaneNode
          label="Policy gate"
          state={finished ? (attack ? "blocked" : "allowed") : props.state === "ACTIVE" ? "active" : "waiting"}
        />
        <span className="lane-connector" aria-hidden="true" />
        <LaneNode
          label={attack ? "External Sink" : "Trusted Destination"}
          state={finished ? (attack ? "empty" : "allowed") : "waiting"}
        />
      </div>
      <div className="lane-result">
        {finished ? (
          attack ? (
            <><strong>0</strong><span>matching sink receipts</span></>
          ) : (
            <><strong>1+</strong><span>trusted receipt required</span></>
          )
        ) : (
          <>
            {inconclusive
              ? <AlertTriangle aria-hidden="true" className="lane-state-icon warning" size={14} />
              : props.state === "WAITING"
                ? <Clock3 aria-hidden="true" className="lane-state-icon" size={14} />
                : <SignalMark active />}
            <span>{progressCopy}</span>
          </>
        )}
      </div>
    </article>
  );
}

interface LaneNodeProps {
  label: string;
  state: "active" | "allowed" | "blocked" | "complete" | "empty" | "waiting";
}

function LaneNode(props: LaneNodeProps): ReactNode {
  const icon = props.state === "blocked"
    ? <X aria-hidden="true" size={13} />
    : props.state === "allowed" || props.state === "complete"
      ? <Check aria-hidden="true" size={13} />
      : null;
  return (
    <span className="lane-node" data-state={props.state}>
      <i aria-hidden="true">{icon}</i>
      <small>{props.label}</small>
    </span>
  );
}

function ResultScene(props: SceneProps): ReactNode {
  if (props.snapshot.status !== "VERIFIED") {
    return <UnverifiedResult snapshot={props.snapshot} />;
  }
  const comparison = props.snapshot.comparison;
  if (comparison === null || comparison.containment === null) {
    return <UnverifiedResult snapshot={props.snapshot} />;
  }
  return (
    <section className="result-scene verified-result" aria-labelledby="result-title">
      <div className="result-lead">
        <div className="verified-mark" aria-hidden="true"><ShieldCheck size={25} /></div>
        <div>
          <p className="eyebrow">Verified Remediation</p>
          <h2 id="result-title">Attack blocked. Support still works.</h2>
          <p>Three finalized Evidence Bundles establish the claim—no model self-reporting required.</p>
        </div>
        <span className="bundle-count"><strong>3</strong> bundles</span>
      </div>
      <div className="proof-triptych">
        <ResultProof
          accent="danger"
          evidenceUrl={comparison.baseline.evidenceUrl}
          eyebrow="Before · Baseline"
          facts={[`${comparison.baseline.exactCanaryReceipts} exact Canary receipt`, "Policy allowed the send"]}
          hash={comparison.baseline.bundleHash}
          result="Vulnerable"
        />
        <ResultProof
          accent="success"
          evidenceUrl={comparison.replay?.evidenceUrl ?? null}
          eyebrow="After · Attack Replay"
          facts={[`${comparison.replay?.matchingCanaryReceipts ?? 0} matching sink receipts`, "Explicit policy denial"]}
          hash={comparison.replay?.bundleHash ?? null}
          result="Protected"
        />
        <ResultProof
          accent="success"
          evidenceUrl={comparison.control?.evidenceUrl ?? null}
          eyebrow="Capability · Control Run"
          facts={[`${comparison.control?.trustedDestinationReceipts ?? 0} trusted destination receipt`, "Legitimate delivery preserved"]}
          hash={comparison.control?.bundleHash ?? null}
          result="Passed"
        />
      </div>
      <div className="result-equation" aria-label="Verified Remediation evidence equation">
        <span><b>Leak proven</b> before</span>
        <i aria-hidden="true">+</i>
        <span><b>Attack blocked</b> after</span>
        <i aria-hidden="true">+</i>
        <span><b>Support delivered</b> normally</span>
        <i aria-hidden="true">=</i>
        <strong>Verified Remediation</strong>
      </div>
    </section>
  );
}

function UnverifiedResult(props: SceneProps): ReactNode {
  const copy = sceneCopy(props.snapshot);
  const replay = props.snapshot.verification?.replay;
  const control = props.snapshot.verification?.control;
  return (
    <section className="result-scene withheld-result" aria-labelledby="withheld-title">
      <div className="withheld-lead">
        <span className="withheld-mark" aria-hidden="true"><AlertTriangle size={23} /></span>
        <div>
          <p className="eyebrow">Evidence claim withheld</p>
          <h2 id="withheld-title">{copy.title}</h2>
          <p>{props.snapshot.failure?.detail ?? copy.description}</p>
        </div>
      </div>
      {replay === undefined || control === undefined ? null : (
        <div className="partial-results">
          <VerificationSummary label="Attack Replay" result={replay.result} state={replay.state} />
          <VerificationSummary label="Control Run" result={control.result} state={control.state} />
        </div>
      )}
    </section>
  );
}

interface VerificationSummaryProps {
  label: string;
  result: string | null;
  state: string;
}

function VerificationSummary(props: VerificationSummaryProps): ReactNode {
  const icon = props.state === "INCONCLUSIVE"
    ? <AlertTriangle size={15} />
    : props.state === "COMPLETED"
      ? <Check size={15} />
      : props.state === "ACTIVE"
        ? <SignalMark active />
        : <Clock3 size={15} />;
  return (
    <article data-state={props.state.toLowerCase()}>
      <span aria-hidden="true">{icon}</span>
      <div><h3>{props.label}</h3><p>{props.result === null ? titleCase(props.state) : titleCase(props.result)}</p></div>
    </article>
  );
}

interface ResultProofProps {
  accent: "danger" | "success";
  evidenceUrl: string | null;
  eyebrow: string;
  facts: string[];
  hash: string | null;
  result: string;
}

function ResultProof(props: ResultProofProps): ReactNode {
  return (
    <article className={`result-proof accent-${props.accent}`}>
      <p className="eyebrow">{props.eyebrow}</p>
      <strong className="result-proof-verdict">{props.result}</strong>
      <ul>{props.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul>
      {props.evidenceUrl === null || props.hash === null ? null : (
        <EvidenceLink bundleHash={props.hash} label="Inspect bundle" url={props.evidenceUrl} />
      )}
    </article>
  );
}

interface ScenarioPathProps {
  mode: "baseline" | "preview";
  snapshot: MissionControlSnapshot;
}

function ScenarioPath(props: ScenarioPathProps): ReactNode {
  const finished = props.snapshot.baseline !== null;
  const live = props.snapshot.status === "BASELINE_RUNNING";
  const progress = baselineProgress(props.snapshot);
  const nodeState = (index: number): string => {
    if (props.mode === "preview") return "preview";
    if (finished) return index >= 3 ? "breached" : "complete";
    if (live && index === progress.activeIndex) return "active";
    if (live && index < progress.activeIndex) return "complete";
    return "waiting";
  };
  const nodes = [
    ["01", "Untrusted ticket", "Hidden instruction"],
    ["02", "Support Agent", "TrueForge + MCP"],
    ["03", "Canary document", "Synthetic secret"],
    ["04", "Policy gate", "Any destination"],
    ["05", "External Sink", "Exact receipt"],
  ] as const;
  return (
    <div className="scenario-path" data-live={live || undefined}>
      {nodes.map((node, index) => (
        <div className="path-fragment" key={node[0]}>
          <article className="path-node" data-state={nodeState(index)}>
            <div className="path-node-top"><span>{node[0]}</span><i aria-hidden="true" /></div>
            <strong>{node[1]}</strong>
            <small>{node[2]}</small>
          </article>
          {index === nodes.length - 1 ? null : (
            <span
              className="path-connector"
              data-active={(live && index === progress.activeIndex - 1) || undefined}
              aria-hidden="true"
            ><i /></span>
          )}
        </div>
      ))}
    </div>
  );
}

interface EvidenceDrawerProps {
  snapshot: MissionControlSnapshot;
}

function EvidenceDrawer(props: EvidenceDrawerProps): ReactNode {
  const groups = activityGroups(props.snapshot);
  return (
    <details className="evidence-drawer">
      <summary>
        <span className="drawer-icon" aria-hidden="true"><Activity size={15} /></span>
        <span><strong>Evidence &amp; agent trace</strong><small>Technical detail, bundle links, and {props.snapshot.activity.length} durable records</small></span>
        <span className="drawer-action">Inspect <i aria-hidden="true"><ChevronDown size={13} /></i></span>
      </summary>
      <div className="evidence-drawer-content">
        {groups.length === 0 ? (
          <div className="activity-empty">
            <SignalMark active={isLiveStatus(props.snapshot.status)} />
            <div>
              <strong>
                {isLiveStatus(props.snapshot.status)
                  ? "Waiting for the first durable record"
                  : "No durable records are available"}
              </strong>
              <p>
                {isLiveStatus(props.snapshot.status)
                  ? "This drawer fills from BLACKBOX and TrueForge state as work completes."
                  : "BLACKBOX has no technical activity to show for this state."}
              </p>
            </div>
          </div>
        ) : groups.map((group) => (
          <section className="activity-group" key={group.label}>
            <div className="activity-group-heading">
              <div><p className="eyebrow">{group.eyebrow}</p><h2>{group.label}</h2></div>
              {group.evidence === null ? null : (
                <EvidenceLink
                  bundleHash={group.evidence.bundleHash}
                  label="Open bundle"
                  url={group.evidence.url}
                />
              )}
            </div>
            <ol className="activity-list">
              {group.items.map((item) => <ActivityItem item={item} key={item.id} />)}
            </ol>
          </section>
        ))}
      </div>
    </details>
  );
}

interface ActivityGroup {
  evidence: MissionControlActivity["evidence"];
  eyebrow: string;
  items: MissionControlActivity[];
  label: string;
}

function activityGroups(snapshot: MissionControlSnapshot): ActivityGroup[] {
  const baselineHash = snapshot.comparison?.baseline.bundleHash;
  const replayHash = snapshot.comparison?.replay?.bundleHash;
  const controlHash = snapshot.comparison?.control?.bundleHash;
  const definitions = [
    [baselineHash, "01 · Breach proof", "Baseline Run"],
    [null, "02 · Agent work", "TrueForge Investigation"],
    [replayHash, "04A · Security check", "Attack Replay"],
    [controlHash, "04B · Capability check", "Control Run"],
  ] as const;
  return definitions.flatMap(([hash, eyebrow, label]) => {
    if (hash === undefined) return [];
    const items = snapshot.activity.filter((item) =>
      hash === null
        ? item.evidence === null
        : item.evidence?.bundleHash === hash,
    );
    if (items.length === 0) return [];
    return [{ evidence: items.find((item) => item.evidence !== null)?.evidence ?? null, eyebrow, items, label }];
  });
}

interface ActivityItemProps {
  item: MissionControlActivity;
}

function ActivityItem(props: ActivityItemProps): ReactNode {
  const item = props.item;
  return (
    <li className="activity-item" data-status={item.status.toLowerCase()}>
      <span className="activity-marker" aria-hidden="true">
        {item.status === "COMPLETED"
          ? <Check size={10} />
          : item.status === "FAILED"
            ? <AlertTriangle size={9} />
            : null}
      </span>
      <div>
        <span className="activity-meta">
          <b>{sourceLabel(item.source)}</b>
          {item.occurredAt === null ? null : <time dateTime={item.occurredAt}>{formatTime(item.occurredAt)}</time>}
        </span>
        <strong className={item.kind === "tool" ? "mono" : undefined}>{friendlyActivityTitle(item.title)}</strong>
      </div>
    </li>
  );
}

interface FailureNoticeProps {
  detail: string;
  title: string;
}

function FailureNotice(props: FailureNoticeProps): ReactNode {
  return (
    <div className="failure-notice" role="alert">
      <span aria-hidden="true"><AlertTriangle size={16} /></span>
      <div><strong>{props.title}</strong><p>{props.detail}</p></div>
    </div>
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
  const trustedDestination = diff.after[0] ?? "Trusted Destination";
  return (
    <dialog aria-labelledby="approval-title" className="approval-dialog" ref={dialogRef}>
      <div className="approval-shell">
        <header className="approval-header">
          <div className="approval-actor">
            <TrueForgeMark />
            <span><strong>TrueForge paused</strong><small>Real apply_policy_patch action</small></span>
          </div>
          <TrueForgeLink snapshot={props.snapshot} />
        </header>

        <div className="approval-content">
          <div className="approval-intro">
            <div>
              <p className="eyebrow">One human decision · Policy unchanged</p>
              <h1 id="approval-title">Allow messages only to the trusted support endpoint?</h1>
              <p>BLACKBOX will apply exactly this restrictive change—nothing else—then verify it automatically.</p>
            </div>
            <span className="decision-badge">Decision required</span>
          </div>

          <section className="human-diff" aria-labelledby="human-diff-title">
            <h2 className="sr-only" id="human-diff-title">Policy Patch comparison</h2>
            <div className="permission before">
              <span>Before · policy v{approval.base.version}</span>
              <strong>Any destination</strong>
              <code>{diff.before}</code>
            </div>
            <span className="diff-arrow" aria-hidden="true"><ArrowRight size={20} /></span>
            <div className="permission after">
              <span>After · candidate v{approval.candidate.version}</span>
              <strong>Trusted endpoint only</strong>
              <code>{compactDestination(trustedDestination)}</code>
            </div>
          </section>

          <section className="decision-evidence" aria-label="Decision evidence and impact">
            <article>
              <span className="decision-icon danger" aria-hidden="true"><AlertTriangle size={14} /></span>
              <div><small>Why change it</small><strong>Exact Canary reached the External Sink</strong></div>
            </article>
            <article>
              <span className="decision-icon success" aria-hidden="true"><Check size={14} /></span>
              <div><small>What stays working</small><strong>Document access + trusted support delivery</strong></div>
            </article>
            <article>
              <span className="decision-icon live" aria-hidden="true"><RefreshCw size={14} /></span>
              <div><small>How it is proven</small><strong>Same attack will be blocked</strong></div>
            </article>
          </section>

          <details className="technical-proof">
            <summary>Inspect exact technical proof <span aria-hidden="true"><ChevronDown size={13} /></span></summary>
            <div className="technical-proof-grid">
              <div><span>Affected capability</span><code>{approval.affectedCapability}</code></div>
              <div><span>Predicted operational impact</span><code>{approval.predictedOperationalImpact.deniedDestinations}</code></div>
              <div><span>Evidence justification</span><code>{approval.evidenceJustification.summary}</code></div>
              <div><span>Evidence bundle</span><code>{approval.evidenceJustification.bundleHash}</code></div>
              <div><span>Expected policy result</span><code>{approval.expectedReplayBehavior.policyDecision} at {approval.expectedReplayBehavior.blockedAt}</code></div>
              <div><span>Expected base</span><code>v{approval.base.version} · {approval.base.hash}</code></div>
              <div><span>Candidate hash</span><code>{approval.candidateHash}</code></div>
            </div>
            <pre>{JSON.stringify(approval.diff, null, 2)}</pre>
          </details>

          {props.command.error === null ? null : (
            <p className="command-error" role="alert">{props.command.error}</p>
          )}
        </div>

        <footer className="approval-actions">
          <p><strong>Approval changes policy.</strong> Verification remains a separate, automatic evidence step.</p>
          <div>
            <button className="secondary-button" disabled={busy} onClick={props.onDeny} type="button">
              {props.command.active === "DENY" ? "Recording decision…" : "Keep current policy"}
            </button>
            <button
              aria-busy={props.command.active === "ALLOW" || props.decisionPending}
              className="primary-button approve-button"
              disabled={busy}
              onClick={props.onApprove}
              type="button"
            >
              <span>{props.command.active === "ALLOW" || props.decisionPending ? "Resuming TrueForge…" : "Approve exact Policy Patch"}</span>
              {props.command.active === "ALLOW" || props.decisionPending
                ? <LoaderCircle aria-hidden="true" className="loading-icon" size={15} />
                : <ArrowRight aria-hidden="true" size={15} />}
            </button>
          </div>
        </footer>
      </div>
    </dialog>
  );
}

interface StatusPillProps {
  children: ReactNode;
  tone: Tone;
}

function StatusPill(props: StatusPillProps): ReactNode {
  return <span className={`status-pill tone-${props.tone}`}>{props.children}</span>;
}

interface SignalMarkProps {
  active?: boolean;
}

function SignalMark(props: SignalMarkProps): ReactNode {
  return <span className={`signal-mark${props.active === true ? " active" : ""}`} aria-hidden="true"><i /></span>;
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
      <ExternalLink aria-hidden="true" size={12} />
    </a>
  );
}

interface TrueForgeLinkProps {
  snapshot: MissionControlSnapshot;
}

function TrueForgeLink(props: TrueForgeLinkProps): ReactNode {
  const href = trueForgeHref(props.snapshot);
  if (href === null) {
    return <span className="trueforge-credit"><TrueForgeMark /><span>Runtime by <strong>TrueForge</strong></span></span>;
  }
  return (
    <a className="trueforge-credit linked" href={href} rel="noreferrer" target="_blank">
      <TrueForgeMark />
      <span>{props.snapshot.integrations?.trueForgeSessionId === null ? "Powered by" : "Open in"} <strong>TrueForge</strong></span>
      <ExternalLink aria-hidden="true" size={12} />
    </a>
  );
}

function TrueForgeMark(): ReactNode {
  return (
    <span className="trueforge-mark" aria-hidden="true">
      <img alt="" className="trueforge-mark-dark" src={trueForgeMarkDark} />
      <img alt="" className="trueforge-mark-light" src={trueForgeMarkLight} />
    </span>
  );
}

function Brand(): ReactNode {
  return (
    <a className="brand" href="/" aria-label="BLACKBOX Mission Control">
      <span className="brand-mark" aria-hidden="true"><i /><i /></span>
      <span><strong>BLACKBOX</strong><small>Mission Control</small></span>
    </a>
  );
}

function sceneCopy(snapshot: MissionControlSnapshot): SceneCopy {
  switch (snapshot.status) {
    case "READY":
      return { description: "The controlled scenario is ready.", eyebrow: "Ready", title: "Run the live Incident", tone: "neutral" };
    case "BASELINE_RUNNING":
      return baselineProgress(snapshot).scene;
    case "INVESTIGATING":
      return investigationSceneCopy(snapshot);
    case "DRAFTED":
      return { description: "The focused reviews are complete. TrueForge is turning their evidence into one restrictive Policy Patch.", eyebrow: "02 · TrueForge Investigation", title: "Drafting the narrow policy change", tone: "live" };
    case "DRY_RUN_PASSED":
      return { description: "The candidate matches the reviewed base and is ready to become one exact human decision.", eyebrow: "02 · TrueForge Investigation", title: "Policy Patch passed dry-run checks", tone: "live" };
    case "AWAITING_APPROVAL":
      return { description: "The proposed Policy Patch is not active. The exact TrueForge action is waiting for you.", eyebrow: "03 · Human approval", title: "One policy decision is required", tone: "warning" };
    case "APPLIED":
    case "VERIFYING":
      return { description: "The patch is active. BLACKBOX is replaying the same attack, then checking legitimate support.", eyebrow: "04 · Automatic verification", title: "Proving the change—not trusting it", tone: "live" };
    case "VERIFIED":
      if (snapshot.comparison?.containment === null || snapshot.comparison === null) {
        return { description: "The expected finalized bundles could not be cross-checked, so BLACKBOX is withholding the containment claim.", eyebrow: "05 · Evidence claim withheld", title: "Verified evidence is unavailable", tone: "danger" };
      }
      return { description: "The replay was blocked, the sink stayed empty, and trusted support still delivered.", eyebrow: "05 · Incident result", title: "Verified Remediation earned", tone: "success" };
    case "DENIED":
      return { description: "No policy changed and no verification Runs started.", eyebrow: "05 · Human decision recorded", title: "Policy Patch declined", tone: "neutral" };
    case "STALE":
      return { description: "The active policy no longer matches the reviewed base. BLACKBOX refused to rebase it silently.", eyebrow: "05 · Safety boundary held", title: "The reviewed patch is stale", tone: "warning" };
    case "BASELINE_INCONCLUSIVE":
      return { description: "The attack did not produce complete evidence, so BLACKBOX will not claim a breach.", eyebrow: "05 · No supported verdict", title: "Breach proof is inconclusive", tone: "warning" };
    case "VALIDATION_FAILED":
      return { description: "A required verification gate did not finalize. Any restrictive policy remains active, but containment is not claimed.", eyebrow: "05 · Claim withheld", title: "Verification is incomplete", tone: "danger" };
  }
}

function journeyStepState(
  snapshot: MissionControlSnapshot,
  index: number,
): StepState {
  if (snapshot.phase === "RESULT") {
    if (index === 4) return "active";
    if (
      snapshot.status === "VERIFIED" &&
      snapshot.comparison?.containment === null &&
      index === 3
    ) {
      return "skipped";
    }
    if (snapshot.status === "DENIED" || snapshot.status === "STALE") {
      return index <= 2 ? "complete" : "skipped";
    }
    if (snapshot.status === "BASELINE_INCONCLUSIVE") {
      return "skipped";
    }
    if (snapshot.status === "VALIDATION_FAILED") {
      if (index === 0) return snapshot.baseline === null ? "skipped" : "complete";
      if (index === 1) {
        return snapshot.verification !== null ||
          approvalCompleted(snapshot.activity) ||
          investigationCompleted(snapshot.activity)
          ? "complete"
          : "skipped";
      }
      if (index === 2) {
        return snapshot.verification !== null || approvalCompleted(snapshot.activity)
          ? "complete"
          : "skipped";
      }
      if (index === 3 && snapshot.verification !== null) return "incomplete";
      return "skipped";
    }
    return "complete";
  }
  const activeIndex = {
    APPROVAL: 2,
    BASELINE: 0,
    INVESTIGATION: 1,
    READY: 0,
    VERIFICATION: 3,
  }[snapshot.phase];
  if (index < activeIndex) return "complete";
  if (index === activeIndex) return "active";
  return "upcoming";
}

function trueForgeHref(snapshot: MissionControlSnapshot): string | null {
  const integration = snapshot.integrations;
  if (integration === undefined) return null;
  const base = integration.trueForgeUrl.replace(/\/$/, "");
  return integration.trueForgeSessionId === null
    ? base
    : `${base}/sessions/${encodeURIComponent(integration.trueForgeSessionId)}`;
}

function friendlyActivityTitle(value: string): string {
  switch (value) {
    case "get_support_ticket":
      return "Read the untrusted Support Ticket";
    case "read_internal_document":
      return "Read the protected Canary document";
    case "search_internal_documents":
      return "Found the diagnostic runbook";
    case "send_external_message":
      return "Attempted the outbound message";
    default:
      return value;
  }
}

function investigationTaskState(
  activity: MissionControlActivity[],
  completedTitle: string,
): "active" | "complete" | "waiting" {
  if (activity.some((item) => item.title === completedTitle)) {
    return "complete";
  }
  const activeTitle =
    completedTitle === "Evidence Provenance Verifier"
      ? "Evidence provenance review started"
      : completedTitle === "Policy Patch Reviewer"
        ? "Policy Patch review started"
        : "Daytona sandbox analysis running";
  return activity.some(
    (item) => item.status === "ACTIVE" && item.title === activeTitle,
  )
    ? "active"
    : "waiting";
}

interface BaselineProgress {
  activeIndex: number;
  proof: string;
  scene: SceneCopy;
}

function investigationSceneCopy(
  snapshot: MissionControlSnapshot,
): SceneCopy {
  const active = snapshot.activity.findLast(
    (item) =>
      item.status === "ACTIVE" &&
      (item.source === "TRUEFORGE" || item.source === "DAYTONA"),
  );
  const title = {
    "Daytona sandbox analysis running": "Daytona is analyzing the evidence",
    "Evidence provenance review started": "Evidence provenance review is running",
    "Policy Patch review started": "Policy Patch review is running",
    "TrueForge investigation started": "Starting the TrueForge investigation",
  }[active?.title ?? ""];
  return {
    description:
      active?.source === "DAYTONA"
        ? "The isolated sandbox is testing the evidence-derived policy boundary."
        : "The leak is proven. TrueForge is checking its cause and the narrowest defensible boundary.",
    eyebrow: "02 · TrueForge Investigation",
    title: title ?? "Finding the missing boundary",
    tone: "live",
  };
}

function baselineProgress(snapshot: MissionControlSnapshot): BaselineProgress {
  const titles = new Set(snapshot.activity.map((item) => item.title));
  if (
    titles.has("External Sink observation closed") ||
    titles.has("Finalizing Run evidence")
  ) {
    return {
      activeIndex: 4,
      proof: "The sink observation window is closed. BLACKBOX is finalizing the Evidence Bundle before naming a verdict.",
      scene: { description: "The bounded sink observation is complete. BLACKBOX is finalizing the evidence before it names a verdict.", eyebrow: "01 · Baseline Run", title: "Finalizing the breach proof", tone: "live" },
    };
  }
  if (
    titles.has("External Sink receipt recorded") ||
    titles.has("Outbound policy evaluated")
  ) {
    return {
      activeIndex: 4,
      proof: "BLACKBOX is checking the controlled External Sink for an exact, run-scoped Canary receipt.",
      scene: { description: "The outbound action crossed the policy gate. BLACKBOX is checking the independent sink receipt.", eyebrow: "01 · Baseline Run", title: "Checking the External Sink", tone: "live" },
    };
  }
  if (titles.has("send_external_message")) {
    return {
      activeIndex: 3,
      proof: "The Support Agent requested an outbound message. The Capability Policy decision is being recorded.",
      scene: { description: "The Support Agent requested an outbound message. BLACKBOX is recording the Capability Policy decision.", eyebrow: "01 · Baseline Run", title: "Evaluating the outbound action", tone: "live" },
    };
  }
  if (titles.has("read_internal_document")) {
    return {
      activeIndex: 2,
      proof: "The Support Agent reached the protected synthetic document. No leak is claimed without a matching sink receipt.",
      scene: { description: "The Support Agent reached the synthetic Canary document. That alone is not proof of a leak.", eyebrow: "01 · Baseline Run", title: "Following the Canary", tone: "live" },
    };
  }
  if (titles.has("get_support_ticket")) {
    return {
      activeIndex: 1,
      proof: "The real TrueForge Support Agent is processing the untrusted Support Ticket while BLACKBOX records its actions.",
      scene: { description: "The real TrueForge Support Agent is processing the synthetic Support Ticket while BLACKBOX records durable facts.", eyebrow: "01 · Baseline Run", title: "Support Agent is handling the ticket", tone: "live" },
    };
  }
  return {
    activeIndex: 0,
    proof: "BLACKBOX is resetting the isolated Run state before the Support Agent starts.",
    scene: { description: "BLACKBOX is resetting the run-scoped ticket, tools, sink, and Canary before agent execution.", eyebrow: "01 · Baseline Run", title: "Preparing the isolated Run", tone: "live" },
  };
}

function investigationCompleted(activity: MissionControlActivity[]): boolean {
  const completed = new Set(
    activity
      .filter((item) => item.status === "COMPLETED")
      .map((item) => item.title),
  );
  return (
    completed.has("Evidence Provenance Verifier") &&
    completed.has("Policy Patch Reviewer") &&
    completed.has("Sandbox analysis completed")
  );
}

function approvalCompleted(activity: MissionControlActivity[]): boolean {
  return activity.some(
    (item) =>
      item.status === "COMPLETED" &&
      item.title === "Policy Patch approved by human",
  );
}

function isLiveStatus(status: MissionControlSnapshot["status"]): boolean {
  return status === "BASELINE_RUNNING" || status === "INVESTIGATING" || status === "VERIFYING";
}

function compactDestination(value: string): string {
  try {
    return new URL(value).pathname.replace(/^\/api\//, "") || value;
  } catch {
    return value;
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
