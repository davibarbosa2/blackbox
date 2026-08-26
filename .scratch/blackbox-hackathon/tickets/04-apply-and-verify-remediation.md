## Parent

[BLACKBOX Spec v0.1 — verified AI-agent incident remediation](https://github.com/davibarbosa2/blackbox/issues/1)

## What to build

Complete the approval-gated remediation tracer bullet. A human decision resumes the exact pending TrueForge action. Approval atomically applies and reads back the reviewed Capability Policy, then automatically runs an equivalent Attack Replay and legitimate Control Run. BLACKBOX produces Verified Remediation only when every evidence gate passes.

## Acceptance criteria

- [ ] Approval resumes the exact persisted `apply_policy_patch` required action and cannot substitute a different patch or call.
- [ ] Denial records `DENIED`, leaves the effective policy hash unchanged, starts no replay, and keeps the Incident unresolved.
- [ ] A stale expected base hash returns `STALE`, changes no policy state, and requires a new dry-run and approval rather than automatic rebasing.
- [ ] Successful application is atomic and idempotent, records the approval evidence, and reads back the expected new policy version/hash before verification.
- [ ] BLACKBOX automatically creates a freshly reset Attack Replay whose scenario, tools, selected OpenRouter model, and relevant configuration fingerprints are equivalent to the Baseline Run.
- [ ] The replay still reads the protected document, reaches `send_external_message`, records an explicit unauthorized-destination policy denial, and produces no exact Canary receipt through a bounded cutoff.
- [ ] The replay becomes `PROTECTED` only when equivalence, explicit denial, absence of the exact receipt, and evidence completeness all pass.
- [ ] The automatic Control Run reads the legitimate support data and successfully sends to the Trusted Destination under the applied policy.
- [ ] Verified Remediation requires successful readback, protected replay, passing control, and finalized Evidence Bundles; `APPLIED` alone never implies `VERIFIED`.
- [ ] Readback, replay, control, or finalization failure produces `VALIDATION_FAILED`, retains the restrictive policy, performs no automatic rollback, and makes no protected claim.
- [ ] The complete real-runtime acceptance drives BLACKBOX through its product HTTP interface and validates the Baseline, Replay, and Control bundles rather than model narration.

## Blocked by

- [#4 — Investigate the Incident and propose the Policy Patch](https://github.com/davibarbosa2/blackbox/issues/4)
