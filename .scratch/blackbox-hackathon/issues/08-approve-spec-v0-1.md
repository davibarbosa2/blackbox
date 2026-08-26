# Approve BLACKBOX Spec v0.1

Parent: [Chart the BLACKBOX Hackathon Project](../map.md)
Type: prototype
Status: resolved
Blocked by: 01, 02, 03, 04, 05, 06, 07

## Question

Does the consolidated BLACKBOX Spec v0.1 faithfully encode every resolved decision, expose no hidden implementation choice, and provide sufficient acceptance criteria and delivery guidance to begin implementation?

## Answer

Yes. The approved specification is published as [GitHub issue #1](https://github.com/davibarbosa2/blackbox/issues/1) with the `ready-for-agent` label and preserved locally at [`spec-v0.1.md`](../spec-v0.1.md).

It consolidates the canonical Incident story, strict evidence and verdict rules, approval-gated Policy Patch lifecycle, executable local-first architecture, pinned TrueForge/Daytona integration with a configurable OpenRouter model, Mission Control behavior, five-slice delivery sequence, explicit exclusions, and submission constraints.

The approved testing seams are:

1. the highest-confidence acceptance path drives BLACKBOX over its real product HTTP interface and validates finalized Evidence Bundles while using real TrueForge, OpenRouter, Daytona, MCP tools, sink HTTP, policy state, and SQLite evidence;
2. deterministic tests exercise `CapabilityPolicy` and `EvidenceLedger` behavior directly;
3. fast orchestrator tests use a fake `TrueForgeRuntime`, while the real adapter is proven by a runtime smoke and the complete remediation integration path.

No unresolved product or technical choice blocks ticket decomposition. Free-model availability and Qodo installation remain delivery risks with explicit preflight and first-PR verification gates, not hidden design decisions.

## Implementation tickets

The approved specification was decomposed into seven `ready-for-agent` GitHub issues with native blocking relationships:

1. [#2 — Build the executable TrueForge–Daytona harness](https://github.com/davibarbosa2/blackbox/issues/2)
2. [#3 — Prove the Support Agent vulnerability](https://github.com/davibarbosa2/blackbox/issues/3)
3. [#4 — Investigate the Incident and propose the Policy Patch](https://github.com/davibarbosa2/blackbox/issues/4)
4. [#5 — Apply and verify the Remediation](https://github.com/davibarbosa2/blackbox/issues/5)
5. [#6 — Build Mission Control](https://github.com/davibarbosa2/blackbox/issues/6)
6. [#7 — Harden the flow and pass the reliability gate](https://github.com/davibarbosa2/blackbox/issues/7)
7. [#8 — Prepare the hackathon submission](https://github.com/davibarbosa2/blackbox/issues/8)

Issues #6 and #7 form the only parallel frontier after the verified runtime path in #5; submission issue #8 is blocked by both.
