# Assess the Agent Observability Tooling Boundary

Parent: [Chart the BLACKBOX Hackathon Project](../map.md)
Type: research
Status: resolved

## Question

Do TrueForge's current first-party events, persistence, and SDK surfaces provide enough observable agent history to build BLACKBOX's Evidence Timeline, what operational value would Langfuse or another tracing layer add, and which boundary minimizes MVP risk without preventing a later exporter?

## Answer

Keep Langfuse outside the hackathon MVP. TrueForge's live and persisted SDK events are sufficient for observable agent-runtime facts, while BLACKBOX's append-only evidence ledger remains authoritative by combining those events with transactional MCP audit records and External Sink receipts. Langfuse adds useful trace trees, session views, filtering, cost/token/latency analysis, and evaluation workflows, but its asynchronous telemetry is not Vulnerability Proof and must never compute or reconstruct a Run Verdict.

Preserve only a one-way `EvidenceExporter` seam after Evidence Bundle finalization. A future OTLP/Langfuse exporter must be asynchronous, idempotent, redacted, and optional; exporter failure cannot alter the Run, bundle, verdict, or demo state.

Full findings and primary-source citations: [Agent Observability Tooling Boundary for BLACKBOX](../research/observability-tooling.md).
