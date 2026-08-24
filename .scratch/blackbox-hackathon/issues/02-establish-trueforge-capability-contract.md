# Establish the TrueForge Capability Contract

Parent: [Chart the BLACKBOX Hackathon Project](../map.md)
Type: research
Status: resolved

## Question

Which current first-party TrueForge capabilities and supported SDK paths can BLACKBOX use for real tools or MCP, sandboxed generated code, subagents, human approval with pause/resume, persistent sessions or reconnects, and agent-state UI, and what constraints or examples must the architecture respect?

## Answer

The supported BLACKBOX path is a TrueForge server plus saved agent specs, a remote Streamable HTTP MCP service, `@truefoundry/trueforge-sdk` for sessions/events, and either the React-only UI package or a custom event-driven interface. Code Mode executes generated Python through a Daytona sandbox; dynamic subagents are model-directed and non-nesting; approval ends the current turn and resumes through a new turn carrying exact approval identifiers; sessions and event history persist, but in-flight execution does not survive a server shutdown. The canonical flow must prove literal approval matching, deterministic subagent/Code Mode behavior, event-stream reconnection, and the intentionally controlled vulnerable outbound action.

Full findings, acceptance checks, and primary-source citations: [TrueForge Capability Contract for BLACKBOX](../research/trueforge-capability-contract.md).
