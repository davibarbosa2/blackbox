# Chart the BLACKBOX Hackathon Project

## Destination

An approved BLACKBOX Spec v0.1 that is ready for implementation: the three-minute demo experience, MVP boundary, executable architecture, TrueForge integrations, acceptance criteria, and delivery sequence are explicit enough to build without unresolved product or technical decisions.

## Notes

- Domain: AI-agent security incident investigation for the TrueForge hackathon.
- Consult `wayfinder` for the map, `grilling` and `domain-modeling` for HITL decisions, `research` for external facts, and `prototype` for the demo/UI and final spec.
- BLACKBOX is built by one developer and targets the hackathon's top prize; time management remains with the developer.
- Canonical scope: one Support Agent, one indirect prompt-injection Attack Scenario, one Incident, one Canary Secret, one External Sink, one Remediation, one Baseline Run, and one equivalent Attack Replay.
- The agent, tools, attack, canary, sink, sandbox, approval, policy change, and replay must execute for real; the company, customers, and data are synthetic.
- BLACKBOX investigates, reproduces, and prepares a Remediation autonomously; applying the Remediation requires human approval, after which BLACKBOX replays the attack automatically.
- The MVP must complete truthfully in about three minutes without deceptive cuts.
- Preserve obvious seams for later extensions, but introduce no generic platform abstractions before the MVP Definition of Done is satisfied.
- Build the authoritative Evidence Timeline from TrueForge events, transactional MCP audit records, and External Sink receipts. Langfuse is outside the MVP; retain only an optional one-way exporter seam after bundle finalization.
- When GitHub work begins, use the developer's personal account and create the repository as private. Connect Qodo before the first implementation PR. The repository must transition to public and open source before the August 30, 2026 16:00 São Paulo submission deadline.

## Decisions so far

<!-- Closed decision tickets are indexed here; each decision lives in its ticket. -->

- [Verify the Current Hackathon Constraints](issues/01-verify-hackathon-constraints.md): TrueForge must visibly do real work, while the private repository must become public, reproducible, and submitted with the required demo artifacts by the deadline.
- [Establish the TrueForge Capability Contract](issues/02-establish-trueforge-capability-contract.md): BLACKBOX can use remote MCP, Daytona Code Mode, model-directed subagents, turn-based approval resumption, durable sessions, and SDK events within documented boundaries.
- [Select the Executable System Shape](issues/03-select-executable-system-shape.md): a local-first TypeScript application keeps BLACKBOX orchestration, MCP, sink, evidence, policy, and UI in one process beside pinned standalone TrueForge, with Daytona and a pinned OpenRouter model as explicit runtime dependencies.
- [Define Incident Evidence and Attack Replay Semantics](issues/04-define-incident-evidence-and-replay.md): a correlated Evidence Bundle proves the canonical tool chain, gives every isolated run a strict verdict, and compares equivalent before/after executions with a six-run reliability gate.
- [Define the Remediation and Safety Contract](issues/05-define-remediation-and-safety-contract.md): a monotonic Policy Patch is approval-gated, atomically applied, and verified only when readback, protected replay, legitimate control, and complete evidence all pass.
- [Assess the Agent Observability Tooling Boundary](issues/10-assess-observability-tooling.md): TrueForge plus BLACKBOX's evidence ledger covers the MVP, while Langfuse remains an optional redacted telemetry projection and never a verdict source.
- [Prototype the Three-Minute Demo and Mission Control](issues/06-prototype-demo-and-mission-control.md): one live guided Incident flow automates detection, investigation, and post-approval verification while progressively disclosing real TrueForge work and closing on evidence-backed before/after proof.
- [Prove Daytona Sandbox Access](issues/09-prove-daytona-sandbox-access.md): pinned TrueForge `0.1.4` successfully used `stealth/ox-alpha` through OpenRouter to create a real Daytona sandbox and execute a generated Python artifact; free-model availability requires a preflight and an explicit fallback.
- [Choose the Delivery Architecture and Implementation Slices](issues/07-choose-delivery-architecture-and-slices.md): five blocking tracer bullets deliver the harness skeleton, Vulnerability Proof, Verified Remediation, Mission Control, and submission reliability through separate Qodo-reviewed PRs.
- [Approve BLACKBOX Spec v0.1](issues/08-approve-spec-v0-1.md): the consolidated specification is published as GitHub issue #1 with confirmed real-runtime, deterministic-domain, and fake-runtime orchestration test seams and is ready for implementation ticket decomposition.

## Implementation frontier

- [GitHub issue #2](https://github.com/davibarbosa2/blackbox/issues/2) is complete: the executable TrueForge–Daytona harness shipped in [PR #9](https://github.com/davibarbosa2/blackbox/pull/9).
- [GitHub issue #3](https://github.com/davibarbosa2/blackbox/issues/3) is the current frontier: prove the Support Agent vulnerability.
- Issues [#4](https://github.com/davibarbosa2/blackbox/issues/4) and [#5](https://github.com/davibarbosa2/blackbox/issues/5) continue the blocking core path.
- Mission Control [#6](https://github.com/davibarbosa2/blackbox/issues/6) and reliability [#7](https://github.com/davibarbosa2/blackbox/issues/7) can proceed after #5; submission [#8](https://github.com/davibarbosa2/blackbox/issues/8) waits for both.

## Not yet specified

- Which post-MVP extensions should graduate after the canonical demo is reliable: more Victim Agents, attack classes, policy adapters, or integrations.

## Out of scope

- A generic agent-security platform, universal scanner, complete OWASP coverage, enterprise RBAC, SIEM replacement, or support for multiple agent frameworks in the MVP.
- Real customer data, production secrets, uncontrolled external targets, or offensive activity outside the synthetic demo environment.
- Optimizing the developer's personal schedule or daily time allocation.
- Automatic or user-facing rollback in the MVP; previous policy versions are preserved for audit, and any later rollback requires a separately approved workflow.
