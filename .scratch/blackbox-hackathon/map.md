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
- When GitHub publication begins, use the developer's personal account and create the repository as private. Do not publish before that implementation step.

## Decisions so far

<!-- Closed decision tickets are indexed here; each decision lives in its ticket. -->

## Not yet specified

- Which post-MVP extensions should graduate after the canonical demo is reliable: more Victim Agents, attack classes, policy adapters, or integrations.
- Hosting, deployment, and production-like observability details that depend on the chosen executable system shape.

## Out of scope

- A generic agent-security platform, universal scanner, complete OWASP coverage, enterprise RBAC, SIEM replacement, or support for multiple agent frameworks in the MVP.
- Real customer data, production secrets, uncontrolled external targets, or offensive activity outside the synthetic demo environment.
- Optimizing the developer's personal schedule or daily time allocation.
