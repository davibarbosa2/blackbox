# Chart the BLACKBOX Hackathon Project

## Destination

An approved BLACKBOX Spec v0.1 that is ready for implementation: the three-minute demo experience, MVP boundary, executable architecture, TrueForge integrations, acceptance criteria, and delivery sequence are explicit enough to build without unresolved product or technical decisions.

## Notes

- Domain: AI-agent security incident investigation for the TrueForge hackathon.
- Consult `wayfinder` for the map, `grilling` and `domain-modeling` for HITL decisions, `research` for external facts, and `prototype` for the demo/UI and final spec.
- BLACKBOX is built by one developer and targets the hackathon's top prize; time management remains with the developer.
- Canonical scope: one Support Agent, one indirect prompt-injection Incident, one Canary Secret, one External Sink, one Remediation, and the same Attack Replay before and after the Remediation.
- The agent, tools, attack, canary, sink, sandbox, approval, policy change, and replay must execute for real; the company, customers, and data are synthetic.
- BLACKBOX investigates, reproduces, and prepares a Remediation autonomously; applying the Remediation requires human approval, after which BLACKBOX replays the attack automatically.
- The MVP must complete truthfully in about three minutes without deceptive cuts.
- Preserve obvious seams for later extensions, but introduce no generic platform abstractions before the MVP Definition of Done is satisfied.
- When GitHub work begins, use the developer's personal account and create the repository as private. Connect Qodo before the first implementation PR. The repository must transition to public and open source before the August 30, 2026 16:00 São Paulo submission deadline.

## Decisions so far

<!-- Closed decision tickets are indexed here; each decision lives in its ticket. -->

- [Verify the Current Hackathon Constraints](issues/01-verify-hackathon-constraints.md): TrueForge must visibly do real work, while the private repository must become public, reproducible, and submitted with the required demo artifacts by the deadline.
- [Establish the TrueForge Capability Contract](issues/02-establish-trueforge-capability-contract.md): BLACKBOX can use remote MCP, Daytona Code Mode, model-directed subagents, turn-based approval resumption, durable sessions, and SDK events within documented boundaries.
- [Define Incident Evidence and Attack Replay Semantics](issues/04-define-incident-evidence-and-replay.md): a correlated Evidence Bundle proves the canonical tool chain, gives every isolated run a strict verdict, and compares equivalent before/after executions with a six-run reliability gate.

## Not yet specified

- Which post-MVP extensions should graduate after the canonical demo is reliable: more Victim Agents, attack classes, policy adapters, or integrations.
- Hosting, deployment, and production-like observability details that depend on the chosen executable system shape.

## Out of scope

- A generic agent-security platform, universal scanner, complete OWASP coverage, enterprise RBAC, SIEM replacement, or support for multiple agent frameworks in the MVP.
- Real customer data, production secrets, uncontrolled external targets, or offensive activity outside the synthetic demo environment.
- Optimizing the developer's personal schedule or daily time allocation.
