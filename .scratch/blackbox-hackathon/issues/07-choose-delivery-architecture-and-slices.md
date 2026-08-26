# Choose the Delivery Architecture and Implementation Slices

Parent: [Chart the BLACKBOX Hackathon Project](../map.md)
Type: grilling
Status: resolved
Blocked by: 01, 03, 04, 05, 06

## Question

What minimum architecture, implementation sequence, verification gates, and private-GitHub PR strategy deliver the canonical demo reliably while leaving only evidence-backed seams for post-MVP extensions?

## Answer

Implement BLACKBOX through five linear tracer bullets. Every slice must end in a user-observable or machine-verifiable vertical behavior, open as a GitHub pull request, receive a Qodo review, and address or explicitly answer every material finding before squash-merge to `main`.

The eventual `/to-tickets` output should create implementation issues in `davibarbosa2/blackbox`, link each PR to its issue, and encode the blocking edges below. The current `.scratch` issues remain the Wayfinder decision record; they are not implementation tickets.

### Slice 1 — harness walking skeleton

**Outcome:** a stranger with valid local keys can run one command that starts pinned TrueForge and BLACKBOX, configures OpenRouter/Daytona, creates a saved spike agent, executes generated Python in a real Daytona sandbox, and observes the expected stdout and terminal events.

Includes the minimal repository scaffold, `.env.example`, ignored runtime data, pinned Node/pnpm/TrueForge SDK/UI versions, configuration upserts, health checks, model/tool preflight, and a safe shutdown path. The existing ad-hoc spike informs this slice but is not promoted as production code.

**Gate:** the command observes model tool calling, `sandbox.created`, sandbox `exec` exit code `0`, expected stdout, persisted merged events, and `turn.done.status = done`. The first PR also proves Qodo is installed and reviewing the repository.

### Slice 2 — Vulnerability Proof

Blocked by Slice 1.

**Outcome:** the Support Agent processes the canonical Support Ticket through the four real MCP tools, sends the exact run-scoped Canary Secret over HTTP to the controlled sink, and BLACKBOX finalizes a Baseline Run Evidence Bundle with `VULNERABLE`.

Includes the synthetic scenario reset, deterministic Capability Policy v1, MCP audit records, sink receipt, TrueForge event capture/reconciliation, run fingerprints, and verdict computation. A minimal CLI or test runner is sufficient; no polished Mission Control yet.

**Gate:** the bundle proves the exact tool chain and exact sink receipt. A missing call, mismatched canary, infrastructure error, or incomplete evidence produces `INCONCLUSIVE`, never `VULNERABLE` or `PROTECTED` by inference.

### Slice 3 — approval-gated Verified Remediation

Blocked by Slice 2.

**Outcome:** after Vulnerability Proof, the BLACKBOX investigator uses two TrueForge subagents and Daytona Code Mode to reconstruct the cause, prepares a monotonic destination-allowlist Policy Patch, pauses on the literal `apply_policy_patch` approval, and after approval automatically completes readback, equivalent Attack Replay, Control Run, and final verification.

Includes policy dry-run, base-hash comparison, atomic/idempotent apply, exact approval resumption, fresh run state, equivalence fingerprints, explicit outbound denial, zero matching replay receipts through a bounded cutoff, preserved Trusted Destination behavior, and `Verified Remediation` only when every gate passes.

**Gate:** one command or integration test observes the entire real path. Approval denial leaves the policy hash unchanged and starts no replay. A stale patch or any replay/control/evidence failure withholds the protected claim.

### Slice 4 — Mission Control

Blocked by Slice 3.

**Outcome:** the chosen guided Incident-flow interface drives the real orchestrator and makes the complete story understandable without a terminal or chat transcript: proven attack, TrueForge work, human decision, automatic verification, and before/after proof.

Includes the one start action, progressively disclosed tool/subagent/sandbox activity, exact Policy Patch modal wired to TrueForge required actions, reconnect-safe product state, failure/denial states, and final Baseline/Replay/Control comparison backed by finalized bundles. Rebuild from the prototype's behavioral decisions; do not copy its fake state machine into production.

**Gate:** refreshing during a live turn reconstructs the Incident without duplicate evidence; every displayed security claim resolves to bundle facts; after approval there is no separate investigation or replay button.

### Slice 5 — reliability and submission

Blocked by Slice 4.

**Outcome:** the public repository and three-minute recording are reproducible, truthful, and ready for judging.

Includes three consecutive vulnerable Baseline Runs and three consecutive protected replays with no inconclusive result, model/tool preflight, failure-path checks, deterministic reset, secret/history scan, README, architecture explanation, AI-assistance disclosure, license, short TrueForge write-up, continuous demo rehearsal/recording, and repository publication.

**Gate:** a clean clone follows the README successfully; the recorded representative flow finishes in about three minutes; the repository is public before submission; all artifacts are submitted before August 30, 2026 at 16:00 São Paulo time.

### Verification strategy

- Test the deterministic policy, run lifecycle, equivalence comparison, verdict rules, and bundle finalization as pure domain behavior.
- Test the MCP/sink/ledger path through the same HTTP interfaces used in the demo.
- Use a fake `TrueForgeRuntime` adapter only for fast orchestration tests; the real adapter contract is proven by the Slice 1 smoke and the complete Slice 3 integration run.
- Keep the six-run reliability gate out of ordinary unit tests and expose it as an explicit, resumable acceptance command.
- Treat any OpenRouter model change as a new configuration fingerprint requiring a fresh Baseline/Replay reliability set.

### PR and branching strategy

- Create one GitHub issue per slice from `/to-tickets`, plus only the small supporting tickets that are independently deliverable and genuinely unblock a slice.
- Branch from current `main` with the `codex/` prefix, open the PR as soon as its first vertical check exists, and keep the issue's acceptance command in the PR description.
- Make the PR ready for review, wait for Qodo, fix valid findings or explain disagreements in-thread, then run the acceptance command again before merge.
- Squash-merge completed slices in blocking order. Never batch several slices into a last-minute umbrella PR.
- Freeze new feature work after Slice 4; Slice 5 may remove risk and improve artifacts but may not introduce a second scenario, deployment topology, or optional integration.

### Explicitly deferred

Hosted mode, Docker as the primary path, Langfuse/exporters, rollback, multiple Victim Agents, multiple attacks, generic policy adapters, broad OWASP coverage, enterprise auth/RBAC, and a user-extensible scenario builder remain post-MVP. Their absence requires no placeholder interface in the implementation.
