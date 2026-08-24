# Prototype the Three-Minute Demo and Mission Control

Parent: [Chart the BLACKBOX Hackathon Project](../map.md)
Type: prototype
Status: resolved
Blocked by: 04, 05

## Question

What concrete three-minute narrative, screen sequence, information hierarchy, and interaction design make the attack path, autonomous investigation, approval pause, policy change, and before-versus-after proof immediately legible and memorable?

## Answer

### Demo narrative

The demo starts once in the operator's terminal with the proposed `pnpm demo` command, which must start the required services, pass their health checks, and open a dedicated browser route. From that point onward, the story stays in BLACKBOX:

1. The operator starts the canonical live attack.
2. The Support Agent performs the real TrueForge model and tool work, and the External Sink proves the Canary Secret arrived.
3. BLACKBOX automatically opens the Incident, reconstructs the causal path, delegates focused evidence and policy analysis, and prepares a monotonic Policy Patch.
4. The only mandatory human stop presents the exact patch, evidence, expected policy base, and operational effect. The operator approves or denies the literal TrueForge-gated mutation.
5. After approval, BLACKBOX applies the reviewed patch, verifies policy readback, and automatically runs the equivalent Attack Replay and Control Run.
6. The closing comparison shows the authoritative result: one exact Canary receipt before, zero after, the explicit policy block, preserved legitimate behavior, and a finalized Evidence Bundle.

The operator should not need separate `Start investigation` or `Run replay` actions in the final flow. Those controls were useful in the logic prototype to expose state transitions, but the product should automate all work except starting the demonstration and approving the production mutation.

### Information hierarchy

The primary BLACKBOX surface is a guided Incident flow, not a generic dashboard or chat transcript. It answers, in order: what happened, what BLACKBOX can prove, what the agents are doing, what decision the human owns, and whether the equivalent replay contained the attack.

TrueForge activity is progressively disclosed inside the Incident. Its real UI atoms may show subagents, tool calls, sandbox work, and approval state, but the full TrueForge chat shell does not become the product's navigation or source of truth. The final proof is a compact before/after comparison backed by the Evidence Bundle.

Motion is restrained and functional: frequent navigation and live-state inspection respond immediately; only state changes that aid causality may animate. Every stage has one obvious primary action, and technical detail stays available without competing with the three-minute story.

### Truthfulness and delivery modes

The recorded and hosted demos share the same real execution spine. Model calls, tools, subagents, approval, policy application, sink receipts, and replay execute for real; only the company, data, attack fixture, Canary Secret, and scenario seed are controlled synthetic inputs.

Local recording uses the one-command launcher. A later public URL may expose the same flow through isolated, short-lived, rate-limited sessions with fixed tools and a hard per-run cost budget. It is not a separate mocked product.

Denial stops without mutation. A replay that leaks again cannot produce `PROTECTED`; it displays the failure and withholds a successful bundle. These failure paths remain legible but do not interrupt the main recording.

### Prototype assets

The throwaway primary source lives on branch `prototype/mission-control` at commit `d659242`:

- the selected guided Incident-flow UI with progressively disclosed TrueForge activity;
- alternate evidence-notebook and replay-comparator studies;
- a self-contained behavioral walkthrough covering the main demo, denied approval, and failed replay.

The prototypes validate behavior and hierarchy only. Their code must not be promoted directly into production.
