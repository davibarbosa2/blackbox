# TrueForge capability contract for BLACKBOX

Status: researched 2026-08-24 against first-party TrueForge documentation and source at [`506bf5c`](https://github.com/truefoundry/trueforge/tree/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4), published release commit [`fba492f`](https://github.com/truefoundry/trueforge/tree/fba492fafd853e897793e8f5f6c5cbd1174e3676), the official hackathon brief, and the official hackathon examples branch at [`314875b`](https://github.com/truefoundry/trueforge/tree/314875b3527cec5ee42fd720e7ae4c5e527c06e8). “Verified” below means the capability has a documented public path and/or a shipped implementation. “Inference” is an architecture recommendation based on that contract. “Unknown” means BLACKBOX must not depend on it without a spike.

## Decision

BLACKBOX can use every TrueForge capability highlighted by the hackathon—real MCP tools, sandboxed generated code, dynamic subagents, tool approval, reconnectable persistent sessions, and visible agent steps—without modifying TrueForge. The supported integration surface is:

1. run the harness with `@truefoundry/trueforge`;
2. define agents through saved or inline agent specs;
3. expose BLACKBOX's controlled scenario as a remote Streamable HTTP MCP server;
4. drive sessions and turns with `@truefoundry/trueforge-sdk`; and
5. either embed the React `@truefoundry/trueforge-ui` or build BLACKBOX's own UI from the SDK event stream.

These are the three public surfaces the project itself advertises: bundled chat, HTTP API/TypeScript SDK, and embeddable UI SDK. The local harness starts with `npx @truefoundry/trueforge@latest`; local mode persists to SQLite, while hosted mode uses Postgres and Redis. ([TrueForge README](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/README.md#L32-L59), [deployment modes](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/README.md#L75-L80))

The hackathon specifically rewards a harness doing substantive work: real MCP tools, generated code in a sandbox, approval before an irreversible action, subagent delegation, and a session that survives reconnects. The UI track also expects the running interface to show what the agent is doing, waiting on, and has done. ([official hackathon brief](https://www.wemakedevs.org/hackathons/trueforge))

## Capability contract

### 1. Real tools through MCP — verified

**Supported path.** TrueForge currently accepts URL-based **remote** MCP servers. A configured connector may have no auth, static header auth, or OAuth Dynamic Client Registration; the agent attaches it by name. The public schema currently allows only `type: "remote"`, and the client probes Streamable HTTP first with SSE as a compatibility fallback. ([connector documentation](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/mcp-servers.mdx#L7-L38), [public server schema](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/packages/trueforge/src/schemas/mcpServer.ts#L13-L58), [transport implementation](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/packages/trueforge-core/src/core/mcp/remoteMcpClient.ts#L12-L30))

The official hackathon cookbook contains a minimal custom MCP server using `@modelcontextprotocol/sdk`, Express, and stateless Streamable HTTP at `POST /mcp`; it is explicitly intended to be copied and adapted around a private API. ([custom MCP example](https://github.com/truefoundry/trueforge/blob/314875b3527cec5ee42fd720e7ae4c5e527c06e8/examples/bring-your-own-mcp/mcp-server.mjs#L1-L16), [server registration and transport](https://github.com/truefoundry/trueforge/blob/314875b3527cec5ee42fd720e7ae4c5e527c06e8/examples/bring-your-own-mcp/mcp-server.mjs#L60-L116))

**Controls.** An agent spec can expose `@all`, `@read-only`, or literal tool names; subtract tools; defer or preload schemas; and require approval for `@write`, `@destructive`, `@all`, or literal names. Annotation selectors depend on annotations supplied by the MCP server. ([agent-spec MCP fields](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/create-agent/overview.mdx#L284-L297))

**BLACKBOX inference.** Build one real `blackbox-scenario` MCP service backed by an actual scenario database/state store and controlled HTTP sink. Its tools should cover ticket/document reads, the outbound action, evidence reads, remediation application, and replay triggering. Synthetic company data is fine; the calls and state transitions must be real. Use Streamable HTTP and explicit tool names in each agent's policy. Do not plan on injecting ordinary TypeScript callback tools into an agent spec—the documented extension path is remote MCP.

**Critical demo constraint.** The vulnerable Victim Agent must explicitly allow its controlled outbound tool; otherwise the default `@write`/`@destructive` approval policy may stop the baseline exfiltration. The remediation tool, in contrast, must be listed literally in the investigator's `require_approval_for_tools`. This is safer and more deterministic than relying on custom annotations. This is an inference from the per-agent approval policy and must be verified in a smoke test.

### 2. Sandboxed generated code and Code Mode — verified

**Supported path.** Enable `config.sandbox.enabled: true` on the agent. The sandbox is a tool: the model and credentials remain in the harness, and the isolated environment performs code, file, and shell operations only. It is provisioned on demand, reused across turns in the same session, and can expose generated files for download. ([sandbox model and isolation](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/sandbox.mdx#L7-L26), [lifecycle](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/sandbox.mdx#L47-L64), [agent config](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/create-agent/overview.mdx#L324-L337))

Code Mode is the documented generated-code path: the agent writes Python in the sandbox, calls configured MCP tools through `mcp_client.call_tool`, processes the results, and returns only the useful output. MCP credentials stay in the harness, and the same approval policies still apply to MCP calls made from code. ([Code Mode contract](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/key-features/code-mode.mdx#L13-L59))

**Current provider constraint.** The public docs state that Daytona is the only supported sandbox provider today; local sandbox execution is still listed on the roadmap. BLACKBOX therefore needs a Daytona account/API key and must not depend on source-level local-sandbox scaffolding. ([sandbox provider support](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/sandbox.mdx#L28-L45), [roadmap](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/roadmap.mdx#L13-L15))

**BLACKBOX inference.** Use the investigator's sandbox to generate and execute the incident-analysis/replay script over MCP evidence, producing a small proof artifact. Keep all cross-agent scenario truth in the MCP service, not in sandbox files: persistence is documented within one session, and only a root agent and its dynamic subagents are documented to share the same sandbox.

**Safety constraint.** Do not implement the irreversible remediation as a plain sandbox shell command. Agent-spec approval policies cover MCP tools, while the sandbox's documented guarantee is that approval still applies when a script calls a gated MCP tool. Put the mutation behind the gated MCP tool.

### 3. Dynamic subagents — verified, model-directed

**Supported path.** Dynamic subagents are enabled by default through `config.dynamic_sub_agents.enabled`. The root model decides to call the built-in `create_sub_agent` tool; each child gets generated, self-contained instructions, runs in an isolated context, and returns only its final result. ([subagent behavior](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/key-features/subagents.mdx#L7-L42), [agent config](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/create-agent/overview.mdx#L105-L113))

Children share the root's MCP tools and sandbox, cannot ask the user questions, cannot create nested subagents, and may run concurrently. A gated MCP call inside a child still pauses for human approval. ([subagent constraints](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/key-features/subagents.mdx#L65-L70))

**BLACKBOX inference.** Instruct the investigator to delegate at least two independent evidence passes—for example, one child reconstructs the attack path while another inspects permissions/policy—and aggregate their results before proposing remediation. This is the closest fit to the official security-auditor example, which combines parallel audit passes, sandbox work, Generative UI, and approval for write/destructive tools. ([official security-auditor spec](https://github.com/truefoundry/trueforge/blob/314875b3527cec5ee42fd720e7ae4c5e527c06e8/examples/security-auditor/agent.json#L1-L17))

**Constraint.** There is no documented application-side `createSubagent()` SDK call or public spec for fixed named specialist agents. Delegation is model-directed, so a repeatable demo needs forceful instructions and an integration test that observes `thread.created` twice. Separate TrueForge sessions can model fixed agents, but that is application orchestration, not the built-in dynamic-subagent feature.

### 4. Human approval and pause/resume — verified

**Supported path.** Gate an MCP tool with `require_approval_for_tools`. When the model requests it, the turn emits `tool.approval_required` and ends with `turn.done.state.status: "done"`, `output: null`, and one or more `requiredActions`. “Paused” is therefore not a distinct turn status. ([pause contract](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/api/use-agent.mdx#L264-L276), [terminal event shape](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/api/use-agent.mdx#L593-L622))

Resume by creating a **new turn in the same session** containing a `user.tool_approval` for the exact `threadId` and `toolCallId`; allow or deny is supported. A single paused turn may contain multiple pending approvals, and approval/tool-response items cannot be mixed with a new `user.message`. ([approval recipe](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/api/use-agent.mdx#L274-L321), [input constraint](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/api/use-agent.mdx#L702-L712))

**BLACKBOX inference.** The proposed remediation should resolve to one literal MCP call such as `apply_policy_patch`. The UI must show its name and serialized arguments, submit the matching approval event, and let the resumed agent continue to the automatic Attack Replay. Persist the pending event data before rendering the approval screen.

**Current limitation.** “Approve once” is roadmap work, so current approval is per invocation. ([approval roadmap](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/roadmap.mdx#L26-L28))

### 5. Persistent sessions and reconnects — verified with an important boundary

**Session persistence.** A session is durable conversation context across many automatically chained turns; clients should persist `session.id` and reopen it later. Local mode uses SQLite; hosted mode uses Postgres, with Redis coordinating live streams and cancellation across replicas. ([session/turn model](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/api/overview.mdx#L61-L87), [local versus hosted runtime](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/introduction.mdx#L77-L93))

**Live reconnect.** Persist `session.id`, `turnId`, and the latest SSE sequence number. If the turn is still running, call `subscribeToTurn(..., { afterSequenceNumber })`; if it is terminal, rebuild from `listTurnEvents`. `createTurn` plus `subscribeToTurn` uses `Last-Event-ID` for transient reconnection. Completed-turn replay returns merged events, not deltas. ([reconnect recipe](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/api/use-agent.mdx#L413-L474), [completed replay](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/api/use-agent.mdx#L540-L558))

**Restart boundary.** First-party prose says session state survives restarts, but the published release's graceful-shutdown path aborts every currently executing turn with reason `abandoned` before the process exits. That supports history/session recovery after restart; it does **not** support claiming that an in-flight model/tool execution continues seamlessly through a server process restart. ([persistence claim](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/introduction.mdx#L43-L52), [active-turn shutdown behavior](https://github.com/truefoundry/trueforge/blob/fba492fafd853e897793e8f5f6c5cbd1174e3676/packages/trueforge/src/runtime/activeTurns.ts#L88-L105), [shutdown call site](https://github.com/truefoundry/trueforge/blob/fba492fafd853e897793e8f5f6c5cbd1174e3676/packages/trueforge/src/main.ts#L334-L361))

**BLACKBOX inference.** Demonstrate reconnect by refreshing/disconnecting the UI while the harness process remains alive, then reopening the same session or resubscribing. Also demonstrate durable history after a controlled server restart if desired, but do not promise mid-turn resurrection. A restart that abandons a turn should be recovered by creating a new turn from the durable session.

**Additional constraint.** Creating a new turn automatically cancels any still-running turn in that session, so the UI must not submit a second user message while the investigation is live. ([turn behavior](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/api/use-agent.mdx#L118-L124))

### 6. Agent-state UI — verified, chat-first

**Ready-made path.** `@truefoundry/trueforge-ui` renders a full agent chat with streaming, history, and tool calls when pointed at the harness; `initialSessionId` opens an existing session. It includes containers for tool calls, approval, agent steps, ask-user prompts, session lists, MCP auth, and sandbox artifacts, plus overridable slots. ([UI quickstart](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/ui-sdk/get-started/quickstart.mdx#L6-L52), [component props](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/ui-sdk/reference/trueforge-ui.mdx#L7-L34), [runtime-connected containers](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/ui-sdk/reference/containers.mdx#L9-L53))

**Event path for a custom UI.** The SDK stream exposes model messages, tool calls/results, approval requirements, subagent `thread.created`/`thread.done`, `sandbox.created`, and terminal turn state. Subagents are separate threads with parent links; `requiredActions` is the source of truth for a waiting UI. ([UI event protocol](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/ui-sdk/reference/events.mdx#L38-L66), [approval and subagent events](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/ui-sdk/reference/events.mdx#L185-L265), [sandbox event](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/ui-sdk/reference/events.mdx#L267-L281))

**Framework constraint.** The UI SDK is React-only and requires React/ReactDOM 18 or 19. A Vue/Nuxt BLACKBOX should consume `@truefoundry/trueforge-sdk` and render its own state UI rather than attempting to import the React component directly. ([UI dependencies](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/ui-sdk/get-started/quickstart.mdx#L6-L24))

**Generative UI boundary.** Agents can emit OpenUI charts, tables, cards, and forms, but these render registered components and do not execute arbitrary client code. Use it for a compact evidence summary, not as BLACKBOX's durable incident state machine. ([Generative UI contract](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/create-agent/overview.mdx#L74-L90))

**BLACKBOX inference.** The strongest UI is a custom incident timeline/state machine driven by the official SDK events, with the TrueForge-native steps visible rather than hidden: MCP reads, `sandbox.created`, subagent threads, proposed remediation, pending approval, applied mutation, and replay result. Embedding or adapting `AgentStepsContainer` is viable in React; otherwise reproduce those semantics in the chosen frontend.

## Supported SDK path and naming caveat

Use `@truefoundry/trueforge-sdk` as the application client. Its official quickstart constructs `new TrueForge(...)`, creates a session, streams a turn, and consumes `turn.done`; the UI SDK itself installs and depends on this package. ([SDK quickstart](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/api/quickstart.mdx#L7-L18), [first streamed turn](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/api/quickstart.mdx#L52-L89), [UI installation](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/ui-sdk/get-started/quickstart.mdx#L6-L20))

One introduction line calls `@truefoundry/trueforge-core` the TypeScript SDK, but the README, SDK docs, package names, and UI adapter consistently identify `@truefoundry/trueforge-sdk` as the HTTP client. Treat the `trueforge-core` wording as a documentation defect, not an alternative recommended integration path. ([inconsistent introduction line](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/docs/introduction.mdx#L60-L67), [canonical README surface](https://github.com/truefoundry/trueforge/blob/506bf5c4d1540fa7cb086f1fb697bbe66d1ea5d4/README.md#L42-L49))

## BLACKBOX minimum architecture contract

The capability research supports this implementation boundary:

- **TrueForge server:** local SQLite mode for development/demo unless deployment requires hosted mode.
- **Two saved agent specs:** a deliberately vulnerable Support Agent and a BLACKBOX investigator/remediator. Both use the custom MCP; only the investigator gets the gated remediation tool and sandbox/subagents.
- **Custom Streamable HTTP MCP:** authoritative synthetic scenario state, controlled External Sink, evidence, policy mutation, and replay operations. It must be a real running service, not hard-coded tool-call screenshots.
- **Investigation session:** one durable TrueForge session from intake through approval and post-remediation verification. Persist its id and stream cursor in the BLACKBOX app.
- **Generated-code proof:** an investigator-authored Python analysis/replay artifact executed through the TrueForge sandbox and visible as sandbox/tool events.
- **Subagent proof:** at least two `thread.created` events with independent evidence tasks.
- **Approval proof:** `apply_policy_patch` produces `tool.approval_required`; the UI submits the exact approval in a new turn; the original call then executes.
- **UI proof:** state is derived from TrueForge events and clearly distinguishes running, waiting for approval, applied, replaying, protected, cancelled, and error.

This mapping is an **inference**, not a claim that TrueForge supplies BLACKBOX-specific incident entities. It keeps the custom product thin while ensuring the harness visibly performs the judged work.

## Unknowns and blockers to retire early

1. **Daytona provisioning and credits:** the docs require Daytona but the reviewed official hackathon materials do not promise a Daytona account or credits. Obtain the API key and verify a cold sandbox build before UI work.
2. **Model compliance/determinism:** dynamic subagents and Code Mode are model-selected. Prove with the selected model that the canonical prompt reliably emits the required sandbox and subagent events.
3. **Approval on the exact custom tool:** verify literal `require_approval_for_tools` matching against the custom MCP's tool name and verify that the Victim Agent's baseline outbound tool is intentionally ungated only inside the controlled scenario.
4. **No generic durable workflow checkpoint:** only the documented turn/session/action-required protocol is contracted. Persist BLACKBOX's incident projection separately; never infer “paused” from `status` alone.
5. **No in-flight restart resurrection:** history is durable, but current graceful shutdown cancels live work as `abandoned`. Handle this explicitly.
6. **UI framework choice:** `@truefoundry/trueforge-ui` is React. Decide early between React reuse and a framework-native UI over `@truefoundry/trueforge-sdk`.
7. **Version churn:** the inspected release publishes the server at 0.1.4, HTTP SDK at 0.1.3, and UI SDK at 0.2.4. Pin compatible versions together and run the canonical end-to-end flow before building polish. ([server manifest](https://github.com/truefoundry/trueforge/blob/fba492fafd853e897793e8f5f6c5cbd1174e3676/packages/trueforge/package.json#L1-L4), [HTTP SDK manifest](https://github.com/truefoundry/trueforge/blob/fba492fafd853e897793e8f5f6c5cbd1174e3676/packages/trueforge-sdk/package.json#L1-L4), [UI SDK manifest](https://github.com/truefoundry/trueforge/blob/fba492fafd853e897793e8f5f6c5cbd1174e3676/packages/trueforge-ui/package.json#L1-L4))

## Acceptance checks for the eventual prototype

The capability contract is proven only when one automated or scripted run observes all of the following from a real TrueForge server:

1. a Support Ticket causes real custom-MCP reads and the controlled outbound action;
2. `sandbox.created` and a sandbox `exec` tool call show generated analysis code ran;
3. two or more subagent threads start and finish;
4. remediation emits `tool.approval_required` and no mutation occurs before approval;
5. a new turn carrying `user.tool_approval` applies the mutation and continues;
6. Attack Replay reaches the same outbound tool and is blocked by the changed policy;
7. a dropped client stream resumes without duplicate event application; and
8. reopening the saved session reconstructs the incident, approval, and replay history.
