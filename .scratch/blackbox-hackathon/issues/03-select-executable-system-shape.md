# Select the Executable System Shape

Parent: [Chart the BLACKBOX Hackathon Project](../map.md)
Type: grilling
Status: resolved
Blocked by: 01, 02, 09, 10

## Question

Given the verified hackathon constraints and TrueForge capability contract, what stack, process boundaries, integration approach, and local-versus-hosted execution shape minimize delivery risk while keeping every important demo action real?

## Answer

Build BLACKBOX as a local-first TypeScript application with two runtime processes and one remote execution dependency:

1. **BLACKBOX application:** one Node.js process owns orchestration, the Streamable HTTP MCP endpoint, the controlled HTTP sink, the append-only evidence ledger, Capability Policy state, product endpoints, and the built React application.
2. **TrueForge `0.1.4`:** one sibling standalone process on localhost with its own SQLite database. BLACKBOX uses `@truefoundry/trueforge-sdk@0.1.3`; the activity surface may reuse `@truefoundry/trueforge-ui@0.2.4` atoms without adopting its chat shell.
3. **Daytona:** the remote sandbox provider configured in TrueForge. OpenRouter is configured as a custom OpenAI-compatible model provider and the chosen literal model id is fingerprinted per run.

The repository is a single pnpm package, not a premature workspace. Use Node.js 22 or newer, React, Vite, a small Node HTTP framework, the MCP TypeScript SDK, and SQLite. Development may run Vite separately for hot reload; the demo build is served by the BLACKBOX process, so development tooling does not become another product runtime.

### Process and trust boundaries

- The browser talks only to BLACKBOX. It never owns orchestration state or calls TrueForge directly.
- The BLACKBOX orchestrator creates TrueForge sessions/turns, captures their live and persisted events, persists pending approval identifiers, and resumes the exact approval in a new turn.
- Both saved Agent Specs use the same BLACKBOX MCP endpoint. The Support Agent receives only scenario tools; the investigator receives evidence/policy tools, Daytona sandbox access, dynamic subagents, and the approval-gated `apply_policy_patch` tool.
- `send_external_message` performs a real HTTP request to the controlled sink route. The sink records its receipt independently from the initiating MCP tool record, even though both logical modules run in the same Node process and persist to the same BLACKBOX SQLite database.
- The deterministic Capability Policy, not the model or UI, authorizes document and outbound operations. Policy version/hash and every decision are written with the MCP audit record.
- The Evidence Ledger accepts source records from TrueForge, MCP execution, policy decisions, and sink receipts. It alone finalizes a Run Verdict and Evidence Bundle; UI state and generated reports are projections.

These are the only external module seams the implementation should expose:

- a `TrueForgeRuntime` interface hiding sessions, turns, reconnects, approval resumption, and event reconciliation;
- an `EvidenceLedger` interface hiding append/idempotency, source correlation, finalization, and bundle hashing;
- a `CapabilityPolicy` interface hiding dry-run, evaluation, optimistic base-hash checks, atomic application, and readback;
- the product HTTP interface used by the Mission Control to start the canonical Incident and submit the one human decision.

Internal classes, repositories, event reducers, and adapters remain implementation details. Do not add an exporter or generic multi-agent/policy adapter interface until a second implementation actually exists.

### Execution flow

`pnpm demo` uses locally pinned dependencies, starts TrueForge and BLACKBOX with explicit ignored data paths, waits for health checks, upserts the model/sandbox settings and the two Agent Specs, resets the synthetic scenario, and opens the Mission Control.

The operator starts once. BLACKBOX runs the vulnerable Support Agent, verifies the sink receipt, runs the investigator, and pauses only when TrueForge emits the required action for `apply_policy_patch`. Approval resumes the exact call; BLACKBOX then performs policy readback, equivalent Attack Replay, Control Run, and bundle finalization without further operator actions.

### Model and sandbox constraints

- Select the literal OpenRouter model id through documented runtime configuration; do not hard-code it in BLACKBOX or the saved Agent Specs. `stealth/ox-alpha` is the initially validated example/default because the 2026-08-25 spike proved direct tool calling and a complete TrueForge-to-Daytona Python run.
- Run a capability preflight for the configured model before development reliability runs and before recording. A different model may be selected only before starting a new equivalence set; baseline and replay within a set can never use different model configurations.
- Store provider keys only in ignored local environment/configuration. Store TrueForge and BLACKBOX SQLite files under an ignored data directory. The sandbox receives neither model nor MCP credentials.

### Delivery shape

The required deliverable is a reproducible local application and continuous real demo recording. A hosted public runtime is post-MVP and must not delay the reliability gate, README, video, or submission. Docker is optional convenience after the one-command local path works; it is not the primary development topology.

### Rejected shapes

- Separate MCP, sink, ledger, API, and UI deployments: operational cost without stronger proof.
- A browser-owned workflow over raw TrueForge calls: loses durable orchestration and evidence locality.
- Forking TrueForge or reading its SQLite tables: unsupported coupling.
- Nuxt/Vue around the React-only TrueForge UI package: avoidable framework integration work.
- Hosted Postgres/Redis, Langfuse, generic policy adapters, and multiple attack scenarios before the canonical flow passes its reliability gate.
