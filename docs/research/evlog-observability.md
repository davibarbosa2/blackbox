# Evlog fit for BLACKBOX observability

_Researched 2026-08-26 against Evlog 2.27.1 and the current BLACKBOX branch._

## Recommendation

Adopt Evlog in a small, local-first pilot. It fits this Node/TypeScript/Hono project well and would make failures such as the recent OpenRouter `429` visible as one structured Run event instead of the current generic `INCONCLUSIVE` message.

Evlog must remain an **operational observability layer**. The SQLite Evidence Ledger remains the sole source of truth for the Evidence Timeline, Evidence Bundle, completeness checks, and Run Verdict. Evlog events may be sampled, buffered, dropped, rotated, or unavailable; they must never participate in verdict calculation or serve as fallback evidence. Evlog itself documents bounded buffers and eventual drops after retry exhaustion in its [drain pipeline](https://www.evlog.dev/extend/drain-pipeline), which is appropriate for telemetry but not evidence.

Also fix the CLI's failure rendering even if Evlog is adopted: the bundle already contains `run.failed` and `completeness.missing`, so `pnpm accept:baseline` should print a sanitized cause, stage, Run id, and missing-evidence list. Evlog gives depth and history; the CLI still owes the operator a useful final answer.

## Fit with this repository

### Runtime and framework compatibility

This is not a Nuxt-only library. Evlog has a dedicated [`evlog/hono` middleware](https://www.evlog.dev/integrate/frameworks/hono) and a separate [standalone TypeScript API](https://www.evlog.dev/integrate/frameworks/standalone) for CLIs and background jobs. The Hono integration creates one request-scoped wide event, exposes the logger through `c.get("log")` or `useLogger()`, captures errors, status, method, path, duration, and request id, and emits when the response finishes.

The currently published package declares Node `>=18` and optional Hono peer `>=4.12.30`; BLACKBOX pins Node `22.23.2` and Hono `4.13.4`, so the declared ranges match. See the official [2.27.1 package metadata](https://github.com/HugoRCD/evlog/blob/7e1f6008ec89c925eccc1ee1db551c5dbb6e5af1/packages/evlog/package.json) and [Hono integration source](https://github.com/HugoRCD/evlog/blob/7e1f6008ec89c925eccc1ee1db551c5dbb6e5af1/packages/evlog/src/hono/index.ts).

### What it adds

- **Structured wide events:** accumulate useful fields through an operation and emit one event at the end, rather than printing disconnected lines. This maps naturally to an HTTP request and, via `createLogger()`, to a complete Baseline Run. See [Wide Events](https://www.evlog.dev/learn/wide-events).
- **Structured errors:** `message`, `why`, `fix`, `cause`, and backend-only `internal` fields can turn `Request failed (429)` into an actionable provider/rate-limit failure. `internal` still reaches logs/drains, so it is not a place for secrets. See [Structured Errors](https://www.evlog.dev/learn/structured-errors).
- **Local persistence:** the [filesystem drain](https://www.evlog.dev/integrate/adapters/self-hosted/fs) writes searchable NDJSON to `.evlog/logs/` by default. That path also works with the repository's installed `analyze-logs` skill. It is a better first step than adding a hosted backend.
- **Pluggable destinations:** the same events can later go to Axiom, Sentry, Datadog, Loki, ClickHouse, or an [OTLP log drain](https://www.evlog.dev/integrate/adapters/hybrid/otlp). Network drains should use the pipeline and be flushed during BLACKBOX shutdown.
- **Correlation with traces:** Evlog can parse an incoming W3C `traceparent` and carry `traceId`/`spanId`; its OTLP adapter maps those fields into OTLP log records. It does **not** create execution spans by itself. OpenTelemetry defines [logs](https://opentelemetry.io/docs/concepts/signals/logs/) and [traces](https://opentelemetry.io/docs/concepts/signals/traces/) as separate signals. If span waterfalls are needed later, add an OpenTelemetry tracer separately and correlate it to Evlog; for the pilot, `runId`, `incidentId`, `requestId`, and `transactionId` are sufficient.

The `evlog/ai` integration is not directly applicable: it wraps the Vercel AI SDK, while this project executes through the TrueForge SDK.

## Recommended event boundaries

Do not turn every function or every Evidence Record into a log line. Use a small set of wide events:

| Boundary | Event contents | Important exclusion |
| --- | --- | --- |
| Hono HTTP request | method, route, status, duration, requestId; add runId/incidentId to `POST /api/incidents` | request/response bodies |
| Baseline Run in `IncidentCoordinator` | runId, incidentId, model id/alias, current/failing stage, duration, verdict, completeness codes, evidence count, bundle hash | Canary Secret and complete Evidence Bundle |
| TrueForge execution | health/configuration/session/turn stage timings, provider, model, upstream HTTP status, retryable flag, session/turn ids | prompt, model text, raw tool arguments/responses |
| Scenario MCP tool transaction | runId, tool name, transactionId, requestId where relevant, success, duration, policy decision/reason code, sink HTTP status | document body, canary, outbound message/payload |
| Acceptance CLI | command duration, spawned service lifecycle, Run id, final verdict or sanitized cause | credentials and raw child payloads |

The HTTP request that starts an Incident returns `202` before the Run completes. Therefore its request event cannot represent the whole Run. The coordinator should own an explicit standalone logger and emit it in `finally` after finalization. Avoid making the core Run lifecycle depend on Hono's background `log.fork()`; the coordinator already owns cancellation and shutdown, and a direct Run logger is easier to test.

Exclude or heavily sample `/healthz` and the polled `GET /api/runs/:runId/evidence` route, otherwise the 500 ms acceptance polling will dominate the useful logs.

## Security rules

Evlog's [auto-redaction](https://www.evlog.dev/learn/redaction) runs before console output and drains, but it is enabled by default only in production and its built-ins do not know the BLACKBOX Canary format. Configure it explicitly in every environment with:

- built-in redaction enabled;
- explicit paths for credential, authorization, prompt, request body, tool input/output, sink payload, and manifest fields;
- a custom pattern for `BLACKBOX-CANARY-*`;
- tests proving neither a Canary Secret nor `OPENROUTER_API_KEY`/`DAYTONA_API_KEY` can appear in console or NDJSON output.

Redaction is defense in depth. Instrumentation should select safe scalar fields rather than logging an object and hoping redaction catches it. In particular, never pass Evidence Records, the Run manifest, MCP input/output JSON, a Support Ticket body, or an Evidence Bundle wholesale to `log.set()` or `log.error()`.

The in-memory drain plus a dev HTTP log endpoint is useful but should not be the first choice here: it loses data when the child process exits and creates a new endpoint that must be restricted. The filesystem drain persists after `accept:baseline` shuts down and needs no exposed API.

## Phased adoption

### Phase 0 — make the current failure useful

Change the acceptance CLI to render the already-persisted failure stage/message and completeness gaps, with a security-focused formatter that never prints raw evidence or Canary values. This directly fixes the observed `429` experience without relying on a logging backend.

### Phase 1 — local Evlog pilot

1. Pin an exact Evlog version; initialize it in one `src/observability/` module.
2. Enable Hono middleware for `/api/**` and `/mcp`, excluding health and polling noise.
3. Add one standalone wide event per Baseline Run in `IncidentCoordinator`.
4. Use the filesystem drain at `.evlog/logs/`, no sampling, explicit always-on redaction, bounded retention.
5. Flush the drain in the existing server shutdown path and before CLI exit.
6. Test the success and OpenRouter `429` paths, including negative secret-leak assertions.

This phase should make a failed run answer: which Run, which stage, which model/provider, which HTTP status, whether retrying makes sense, and which evidence gates were not reached.

### Phase 2 — boundary detail

Add safe timings and structured errors around TrueForge health/configuration/session/turn work and the four Scenario MCP transactions. Preserve existing domain errors where they express invariants; use structured errors primarily at external boundaries where `why`, `fix`, status, and retryability are meaningful.

### Phase 3 — hosted search or real tracing only if needed

Add an OTLP or another hosted drain behind Evlog's batching/retry pipeline. If the hackathon demo needs a span waterfall rather than searchable wide events, add OpenTelemetry tracing separately and propagate/correlate trace ids. Do not introduce either before the local pilot proves the event schema is useful.

## Limitations and risks

- Evlog is moving quickly, as its [release history](https://github.com/HugoRCD/evlog/releases) shows. Pin the exact version and isolate it behind one project-owned observability module; upgrade deliberately.
- Telemetry delivery is best effort. Buffered network events require an explicit shutdown flush and can still be dropped. This is another reason the Evidence Ledger must remain authoritative.
- Hono request logging alone will not explain the asynchronous Incident, because the start request ends at `202`. The Run-wide event is essential.
- Pretty console output is good for a human, while NDJSON is better for tools. Keep both, but define one stable field vocabulary (`runId`, `incidentId`, `stage`, `provider`, `modelId`, `verdict`, `missingEvidence`).
- Filesystem logs need retention limits. They may also contain operational identifiers, so keep `.evlog/` ignored and never publish its contents as hackathon evidence.
- Broadly converting every `new Error()` to Evlog errors would create noisy, non-surgical changes. Start with external-service and top-level operator-facing failures.

## Acceptance criteria for the pilot

- A forced provider `429` produces one error-level Run event with `runId`, `stage=trueforge`, provider/model, HTTP status, retryability, and missing-evidence codes.
- The CLI prints that sanitized cause instead of only `received INCONCLUSIVE`.
- A successful run produces one completion event with `VULNERABLE`, evidence count, and bundle hash.
- `rg 'BLACKBOX-CANARY|OPENROUTER_API_KEY value|DAYTONA_API_KEY value' .evlog/logs` finds nothing.
- Restarting or shutting down the owned BLACKBOX process leaves readable NDJSON and does not lose the final Run event.
- Removing Evlog or losing its drain has no effect on Evidence Bundle generation, hash validation, completeness, or verdict.
