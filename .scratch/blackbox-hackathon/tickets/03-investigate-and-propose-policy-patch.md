## Parent

[BLACKBOX Spec v0.1 — verified AI-agent incident remediation](https://github.com/davibarbosa2/blackbox/issues/1)

## What to build

After proven vulnerability, have the BLACKBOX investigator autonomously reconstruct the Incident, delegate focused work to two TrueForge subagents, use Daytona Code Mode for evidence analysis, and prepare a dry-run-validated destination-allowlist Policy Patch. The flow must stop at the real TrueForge required action for `apply_policy_patch`, with a durable approval request containing everything a human needs to decide.

## Acceptance criteria

- [ ] Investigation starts automatically only after a finalized Baseline Evidence Bundle proves `VULNERABLE`.
- [ ] The investigator uses two visible focused TrueForge subagents and executes an analysis artifact in a real Daytona sandbox.
- [ ] The resulting evidence-backed diagnosis identifies the missing destination allowlist in `send_external_message` as the canonical cause.
- [ ] The candidate patch leaves protected-document access unchanged, preserves the Trusted Destination, and denies destinations outside the allowlist.
- [ ] Patch validation permits only schema-valid monotonically restrictive changes and rejects grants, widened scopes, added destinations, weakened approvals, and arbitrary remediation code.
- [ ] Dry-run records the expected base version/hash, affected capability, evidence justification, predicted operational impact, and expected replay behavior without changing effective policy.
- [ ] A valid proposal reaches `AWAITING_APPROVAL` through the literal TrueForge required action for `apply_policy_patch`; its session, turn, action, and call identifiers survive process or browser reconnection.
- [ ] The product HTTP interface exposes the exact diff and durable pending-decision state needed by the future Mission Control.
- [ ] Fast orchestration tests use a fake `TrueForgeRuntime` for event ordering, retries, reconnects, and invalid proposals; a real-runtime acceptance proves subagents, Daytona analysis, and the pending approval.

## Blocked by

- [#3 — Prove the Support Agent vulnerability](https://github.com/davibarbosa2/blackbox/issues/3)
