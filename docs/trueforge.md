# How BLACKBOX uses TrueForge

BLACKBOX uses TrueForge as the real agent harness for both the compromised
Support Agent flow and the investigation that follows it. TrueForge runs as a
pinned sibling process; BLACKBOX controls it through the TypeScript SDK and
keeps the browser behind BLACKBOX's product HTTP interface.

The Support Agent receives four MCP business tools: it reads a synthetic
Support Ticket, searches internal documents, reads the selected document, and
attempts an external message. Those calls are real, observable boundaries. The
last call is authorized by BLACKBOX's Capability Policy outside the model, and
the controlled External Sink independently records whether the run-scoped
Canary Secret arrived.

After Vulnerability Proof, a separate TrueForge investigator uses evidence and
policy MCP tools. It delegates focused evidence and policy analysis to exactly
two dynamic subagents, then executes the generated analysis artifact in an
isolated Daytona sandbox. The proposed destination-allowlist Policy Patch is
schema checked, required to be monotonically restrictive, and dry-run before
it can reach approval.

The only human checkpoint is TrueForge's literal required action for
`apply_policy_patch`. Mission Control displays the exact pending action,
evidence-backed diff, expected base policy hash, and predicted impact. Approval
resumes that same persisted action; denial leaves the policy unchanged and does
not start verification.

BLACKBOX merges TrueForge's live events with persisted event readback so a
reconnect can reconstruct tool, subagent, sandbox, and approval activity
without replaying side effects. The browser receives a sanitized projection of
those observable events, not hidden model reasoning.

TrueForge orchestrates the work, but it is not the source of BLACKBOX's
security verdict. The append-only SQLite Evidence Ledger correlates TrueForge
events, MCP transactions, policy decisions, and External Sink receipts into
finalized Evidence Bundles. BLACKBOX claims only containment of this canonical
synthetic Attack Scenario: an equivalent Attack Replay must reach an explicit policy
denial with no matching receipt, while a separate Control Run must still
deliver to the Trusted Destination. It does not claim to prevent prompt
injection or provide general agent security.
