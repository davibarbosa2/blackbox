# Agent observability tooling boundary for BLACKBOX

Status: researched 2026-08-24 against first-party TrueForge documentation and source at [`506bf5c`](https://github.com/truefoundry/trueforge/tree/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4), and first-party Langfuse documentation at [`27623f6`](https://github.com/langfuse/langfuse-docs/tree/27623f6b596299027387fe47362e7b287baae833) and source at [`f6725ae`](https://github.com/langfuse/langfuse/tree/f6725ae52a1798024fda4b54cd538a48280a7d91).

## Decision

**Do not put Langfuse on the BLACKBOX hackathon MVP's critical path.** TrueForge's persisted event stream is sufficient for the **agent-observable portion** of the Evidence Timeline: turns, model messages and tool-call arguments, tool responses, approval boundaries, subagent lifecycles, sandbox creation, terminal status, token usage, and cost. It is not sufficient by itself for the authoritative Incident verdict because TrueForge cannot attest to BLACKBOX-specific facts inside the scenario MCP or External Sink.

BLACKBOX should therefore own one append-only Incident evidence ledger and derive `evidence-bundle.json` from it. That ledger ingests:

1. unmodified TrueForge events with their source identities;
2. audit events written transactionally by the scenario MCP around tool execution, policy decisions, and state changes; and
3. External Sink receipts plus a bounded verification record when absence is asserted.

Langfuse would add a strong developer-facing trace tree, session replay, filtering, token/cost/latency analytics, annotations, and later evaluation workflows. Those are valuable observability projections, not Vulnerability Proof. Preserve a one-way exporter seam from finalized/redacted BLACKBOX evidence to OTLP/Langfuse; an exporter failure must never change an Incident Run, Run Verdict, or demo state.

## Why the TrueForge history is enough for agent actions

TrueForge exposes a live turn stream through `@truefoundry/trueforge-sdk`. Stream metadata carries a per-turn sequence number; each non-delta event has a stable event id; deltas merge into their base `model.message`. The documented reconnect recipe persists `session.id`, `turnId`, and the last sequence number, then resumes a running turn with `subscribeToTurn(... afterSequenceNumber)` or rebuilds a finished turn with `listTurnEvents`. ([stream contract](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/api/use-agent.mdx#L118-L158), [reconnect and replay](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/api/use-agent.mdx#L413-L473))

The persisted event shape covers the evidence BLACKBOX needs from the agent runtime:

- every event has a monotonic ULID, timestamp, and root/subagent `thread_id`;
- `turn.created` records the turn id, previous turn, and exact input, so an approval decision sent in the next turn remains observable;
- merged `model.message` events include tool-call ids, names, serialized arguments, finish reason, and per-call token usage;
- `tool.response` links the result back to `tool_call_id`;
- approval events identify the pending call and source model message;
- `thread.created`/`thread.done`, `mcp.initialize`, `sandbox.created`, and `turn.done` expose subagent, connector, sandbox, terminal-state, aggregate token, and cost facts. ([event identity and lifecycle](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/api/use-agent.mdx#L561-L622), [model and tool events](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/api/use-agent.mdx#L625-L669), [subagent and environment events](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/api/use-agent.mdx#L671-L700), [approval input](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/api/use-agent.mdx#L702-L712))

This is genuinely durable history, not only UI state. The built-in persisted-event union includes turn lifecycle, model messages, tool responses, subagent events, MCP initialization/authentication, sandbox creation, and approval/response requirements; persisted entries retain id and timestamp. ([persisted event schema](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/packages/trueforge-core/src/agent-session/schemas/events.ts#L49-L100)) During execution, TrueForge appends `turn.created` before running the harness and persists tool responses and merged model output to the event store. ([turn start persistence](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/packages/trueforge-core/src/agent-session/TurnHandle.ts#L215-L240), [execution event persistence](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/packages/trueforge-core/src/agent-session/TurnHandle.ts#L399-L500))

For cross-turn reconstruction, the server has a paginated session-events route that returns persisted events across the active branch, including a running tip, and restricts access to the session creator. The underlying session handle explicitly reads only from the store and synthesizes nothing. ([session-events HTTP contract](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/packages/trueforge/src/routes/sessionRoutes.ts#L212-L237), [store-backed session history](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/packages/trueforge-core/src/agent-session/SessionHandle.ts#L358-L389)) Context compaction does not erase that history: it is lossy only in the model's working context, while the full event history remains persisted and queryable. ([compaction boundary](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/key-features/overview.mdx#L148-L165))

### What TrueForge cannot prove

The TrueForge log proves what the harness asked a tool to do and what result it received. It does **not** by itself prove the internal transaction that the scenario MCP committed, the policy version actually evaluated, the External Sink request actually received, or the absence of a canary receipt over the verification window. Those entities do not exist in TrueForge's persisted event union; they are BLACKBOX domain facts. This is an inference from the first-party event schema, not a defect claim. ([persisted event schema](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/packages/trueforge-core/src/agent-session/schemas/events.ts#L61-L100))

Consequently:

- a TrueForge `model.message.tool_calls` entry is **agent intent**, not proof that the side effect occurred;
- a TrueForge `tool.response` is **the harness-observed response**, not an independent receipt from the sink;
- absence of a `send_external_message` success event is not enough for `PROTECTED`; the MCP must record an explicit policy denial and the sink verifier must record no matching receipt through a defined cutoff;
- TrueForge event timestamps and ordering are useful provenance, but BLACKBOX must generate the run manifest, configuration fingerprints, policy version, replay-equivalence comparison, Evidence Timeline, and Run Verdict.

This preserves a single source of truth: the BLACKBOX evidence ledger holds source records and the final bundle; TrueForge remains an authoritative **source** for agent-runtime facts, not a competing Incident store.

## Native telemetry/export boundary in current TrueForge

TrueForge Core contains an `AgentTracing` extension interface for root/subagent execution, local tools, and remote MCP operations. However, its standard `TurnResourceResolver.createTracing()` explicitly returns `NOOP_AGENT_TRACING`, whose methods perform no telemetry work. ([tracing extension interface](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/packages/trueforge-core/src/core/tracing/AgentTracing.ts#L1-L51), [no-op implementation](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/packages/trueforge-core/src/core/tracing/NoopAgentTracing.ts#L53-L94), [default resolver](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/packages/trueforge-core/src/agent-session/TurnResourceResolver.ts#L47-L93))

The packaged TrueForge server constructs that base resolver directly and does not override the tracing factory. Therefore, there is no verified server configuration that turns the current packaged harness into a Langfuse/OTLP exporter. Adding one would require embedding/subclassing the core resolver or changing the server, which is unnecessary risk for the hackathon. ([packaged server resolver construction](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/packages/trueforge/src/apis/turns.ts#L130-L180))

TrueForge does inject the currently active OpenTelemetry context into remote MCP request headers, so future tracing can propagate across the harness/MCP boundary once a real tracer establishes an active span. In the current packaged server, the no-op tracer means this hook is not itself an exported trace. ([MCP trace-header propagation](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/packages/trueforge-core/src/core/mcp/remoteMcpClient.ts#L1-L11), [header injection and calls](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/packages/trueforge-core/src/core/mcp/remoteMcpClient.ts#L70-L113))

**Boundary conclusion:** use the supported SDK event/history APIs for the MVP. Do not fork TrueForge or reach into its SQLite/Postgres tables to add tracing.

## Concrete value Langfuse would add

Langfuse models individual application steps such as LLM and tool calls as nested observations, groups observations into a trace, and can group multiple traces into a session. That maps naturally to one TrueForge turn per trace and one TrueForge session or BLACKBOX Incident per Langfuse session. ([Langfuse data model](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/content/docs/observability/data-model.mdx#L12-L36), [session replay](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/content/docs/observability/features/sessions.mdx#L9-L18))

For BLACKBOX developers, that would provide:

- a navigable agent/tool trace tree instead of reading raw JSON;
- filtering by run id, environment, release, policy version, and bundle hash through propagated attributes/metadata;
- per-generation token and cost tracking, dashboards, and alerts;
- latency and time-to-first-token analysis;
- session-level human scores and, later, evaluation/dataset workflows. ([attributes and multi-export support](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/content/docs/observability/data-model.mdx#L67-L95), [usage and cost capabilities](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/content/docs/observability/features/token-and-cost-tracking.mdx#L9-L46), [queryable observation fields](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/content/docs/api-and-data-platform/features/observations-api.mdx#L66-L104), [session scoring](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/content/docs/observability/features/sessions.mdx#L191-L205))

Langfuse accepts OTLP/HTTP traces at `/api/public/otel`; its current docs support JSON and protobuf over HTTP, not gRPC. Its SDK is a thin OpenTelemetry layer that adds Langfuse observation types and LLM-specific helpers. ([OTLP endpoint and protocol](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/content/integrations/native/opentelemetry/index.mdx#L21-L79), [SDK/OTEL ingestion choices](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/content/integrations/native/opentelemetry/index.mdx#L164-L184)) A later BLACKBOX exporter can therefore emit standards-based spans without coupling the evidence ledger to Langfuse's REST object model.

None of these capabilities strengthen the canonical Vulnerability Proof. They improve debugging, analytics, collaboration, and presentation of a **copy** of the evidence.

## Integration and operational costs Langfuse would add

### Application work

Current TrueForge does not emit OTLP in its packaged runtime, so BLACKBOX would have to map TrueForge events and MCP/sink records into spans, define parentage across turns/subagents/tools, propagate run/session attributes, and reconcile duplicates after reconnects. Langfuse requires trace-level attributes such as session id, metadata, release, and tags on every span for reliable filtering and aggregation, which makes propagation correctness part of the integration. ([attribute propagation requirement](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/content/integrations/native/opentelemetry/index.mdx#L83-L89), [required propagation mechanics](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/content/integrations/native/opentelemetry/index.mdx#L117-L170))

Langfuse SDKs batch and send traces in the background. Short-lived processes must flush explicitly or can lose buffered traces; the JS span processor also requires a final `forceFlush()`. This delivery model is appropriate for telemetry but weaker than a synchronous, transactional security evidence write. ([background processing and loss boundary](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/content/docs/observability/data-model.mdx#L99-L136), [batching and flush contract](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/content/docs/observability/features/queuing-batching.mdx#L6-L27), [JS force-flush](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/content/docs/observability/features/queuing-batching.mdx#L58-L90))

### Security and data handling

Raw prompts, tool arguments, tool outputs, and the Canary Secret are exactly the data most likely to be copied into tracing. Langfuse supports client-side masking before export, including JS/TS masking of observation input, output, and metadata, but BLACKBOX would have to design and test that redaction. ([masking contract](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/content/docs/observability/features/masking.mdx#L7-L15), [JS/TS masking](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/content/docs/observability/features/masking.mdx#L229-L257)) The exact Canary Secret must stay in the authoritative evidence bundle/sink store; the observability projection should export a redacted value, deterministic digest, and bundle pointer.

Using Langfuse Cloud adds project credentials and an outbound data dependency. Self-hosting removes that external data boundary but adds a web container, async worker, Postgres, ClickHouse, Redis/Valkey, and S3-compatible blob storage; the official minimum sizing lists separate CPU/memory allocations for each component. ([self-hosted components](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/components-mdx/architecture-description-v3.mdx#L1-L15), [minimum infrastructure](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/content/self-hosting/configuration/scaling.mdx#L12-L21)) Docker Compose is officially positioned for testing/low scale and lacks high availability, scaling, and backup functionality. ([deployment boundary](https://github.com/langfuse/langfuse-docs/blob/27623f6b596299027387fe47362e7b287baae833/content/self-hosting/index.mdx#L21-L40)) That is disproportionate operational scope for this three-minute demo.

## MVP implementation contract

### Authoritative path

1. **Capture live TrueForge events.** Append every raw stream envelope, including deltas, with `incident_run_id`, `source = "trueforge"`, `session_id`, `turn_id`, `thread_id`, event id, live sequence number, source timestamp, and unmodified payload. Fold deltas only in a read projection.
2. **Reconcile after each terminal turn.** Read `listTurnEvents(order: "asc")` and append each merged source event once under a unique `(source, event.id, representation = "merged")` key. On UI reconnect, resume with the saved sequence number before reconciliation.
3. **Write MCP evidence transactionally.** The scenario MCP assigns `incident_run_id` to every canonical tool call and appends request, policy decision, result, and state-change records in the same database transaction as the scenario mutation where possible.
4. **Use the sink as receipt authority.** The External Sink persists request id, run id, payload digest, whether the exact canary matched, and receipt timestamp. During `VERIFYING`, append the matching receipt or a bounded no-receipt verification containing the sink high-water mark and cutoff.
5. **Finalize once.** Compute the Run Verdict from ledger facts, freeze the run, emit `evidence-bundle.json`, and hash the canonical bundle. The Markdown report and UI are projections of that finalized bundle.

### Exporter seam, not MVP integration

Keep the seam deliberately small:

```ts
interface EvidenceExporter {
  exportFinalizedRun(bundle: EvidenceBundle, context: { bundleHash: string }): Promise<void>
}
```

The MVP implementation may provide only `NoopEvidenceExporter`. A future `OtlpEvidenceExporter` should:

- run asynchronously after bundle finalization;
- emit one trace per Incident Run and group related runs by Incident/session id;
- preserve `incident_run_id`, `evidence_bundle_hash`, source ids, policy version, and verdict as searchable attributes;
- redact the Canary Secret and sensitive tool payloads before they leave the evidence boundary;
- be idempotent and retryable from an outbox keyed by the bundle hash; and
- never be read back to compute a verdict or rebuild the authoritative bundle.

If time remains after the six-run reliability gate passes, Langfuse Cloud can be added behind this seam as a developer/demo supplement. It remains explicitly optional.

## Verified unknowns and early checks

1. **Schema compatibility:** TrueForge exposes detailed event types, but no reviewed first-party source promises backward compatibility for every event payload. Pin the exact TrueForge server and SDK versions together and run a contract fixture covering every event BLACKBOX consumes.
2. **Running-history documentation mismatch:** current source and OpenAPI describe session history including a running tip, while the `listTurnEvents` recipe is documented for completed turns only. Use streaming/subscription for live capture and finished-turn replay for reconciliation; do not make the MVP depend on polling running turn history. ([running session history](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/packages/trueforge/src/routes/sessionRoutes.ts#L212-L220), [completed-turn replay](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/api/use-agent.mdx#L540-L558))
3. **No tamper-evidence guarantee:** the reviewed TrueForge event contract provides durable ids, timestamps, and persisted payloads, but does not document cryptographic signing or a hash chain. BLACKBOX should hash the finalized canonical bundle and avoid claiming that TrueForge history itself is tamper-proof.
4. **Tool-output size behavior:** verify that the four canonical tool responses remain inline and unchanged in persisted `tool.response` events at the pinned version. The MCP audit ledger remains authoritative for scenario facts even if presentation/offloading behavior changes.
5. **Langfuse mapping fidelity:** if the optional exporter is built, prove parent/child structure for subagents and tool calls, idempotency after reconnect/replay, redaction of the exact Canary Secret, and flush-on-shutdown before showing its UI in the demo.
