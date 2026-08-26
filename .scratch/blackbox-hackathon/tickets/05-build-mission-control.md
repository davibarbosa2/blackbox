## Parent

[BLACKBOX Spec v0.1 — verified AI-agent incident remediation](https://github.com/davibarbosa2/blackbox/issues/1)

## What to build

Deliver the judge-facing Mission Control that drives and explains the real Incident workflow without terminal choreography or a chat transcript. One start action progresses from proven attack through visible TrueForge investigation, the single human policy decision, automatic verification, and an evidence-backed Baseline/Replay/Control comparison.

Rebuild from the prototype's behavioral decisions; do not reuse its fake state machine as product state.

## Acceptance criteria

- [ ] The opening view explains the synthetic attack, containment claim, and single start action clearly enough for a first-time judge.
- [ ] Starting from the browser calls the real BLACKBOX orchestrator and never simulates agent, tool, sink, approval, replay, or verdict state in the client.
- [ ] Progressive activity shows relevant TrueForge tool calls, two subagents, Daytona sandbox execution, evidence milestones, and current Incident phase without exposing hidden reasoning.
- [ ] The approval modal presents the exact durable Policy Patch diff, base hash, evidence justification, affected capability, and predicted operational impact.
- [ ] Approve and deny controls submit the one real pending TrueForge decision and accurately render all resulting terminal states.
- [ ] After approval there is no separate investigation, apply, replay, or control button; readback and verification advance automatically.
- [ ] The final view compares Baseline, Attack Replay, and Control evidence and displays containment only when finalized bundles establish Verified Remediation.
- [ ] Every visible security claim resolves to source facts from finalized Evidence Bundles rather than client or model-generated inference.
- [ ] Refreshing or reconnecting during a live turn or pending approval reconstructs durable Incident state without duplicate evidence, actions, or side effects.
- [ ] Loading, denial, inconclusive, stale, infrastructure-failure, and validation-failure states remain understandable and never visually imply success.
- [ ] The representative successful flow is accessible, responsive at the recording viewport, and operable in approximately three minutes.

## Blocked by

- [#5 — Apply and verify the Remediation](https://github.com/davibarbosa2/blackbox/issues/5)
