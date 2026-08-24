# Define the Remediation and Safety Contract

Parent: [Chart the BLACKBOX Hackathon Project](../map.md)
Type: grilling
Status: resolved
Blocked by: 02, 04

## Question

What exact policy change fixes the canonical Incident, which actions remain autonomous, where must human approval stop execution, and what evidence proves the approved Remediation was applied without merely hiding the attack?

## Answer

### Security claim

BLACKBOX claims **Containment**, not elimination of prompt injection or complete agent security. After Remediation, the canonical payload may still influence the Support Agent's reasoning, but Capability Policy prevents it from exposing confidential information or completing an unauthorized external action. The verified conclusion is `ATTACK CONTAINED / PROTECTED`.

### Policy Patch

The candidate Policy Patch changes capability rules, not the model, prompt, payload, tools, or scenario data:

- `read_internal_document` continues to allow ordinary `internal-support` content but denies `confidential` documents to the Support Agent.
- `send_external_message` continues to allow Trusted Destinations; an untrusted destination requires approval and is blocked when no such approval exists.

The canonical Attack Replay is expected to stop at the confidential-document rule. The outbound rule is a second containment layer. The separate Control Run must still read an allowed support document and send its legitimate response to a Trusted Destination.

BLACKBOX may generate only schema-valid, monotonically restrictive changes: `deny`, `restrict`, or `require_approval`. A candidate cannot grant a tool, widen a resource scope, add a destination, weaken an approval, or execute arbitrary remediation code.

### Autonomous preparation and human approval

BLACKBOX autonomously reconstructs the Incident, delegates evidence analysis, generates the candidate Policy Patch, and validates it through dry-run/sandbox without changing effective policy.

The only mandatory human stop is the literal TrueForge-gated `apply_policy_patch` call. Before deciding, the user sees the complete diff, expected base version/hash, affected tools, evidence-backed justification, and predicted operational impact.

- Denial records `DENIED`, leaves the policy hash unchanged, and does not trigger Attack Replay. The Incident remains unresolved; BLACKBOX may prepare a new proposal but cannot silently reapply the denied one.
- Approval resumes through the exact TrueForge approval identifiers and executes the already-reviewed call. Application is atomic and idempotent, records the approver/action evidence, and returns the new policy version/hash.
- If `expected_base_hash` no longer matches, application returns `STALE`; BLACKBOX must repeat dry-run and request a fresh approval. It never rebases a security change automatically.

### Remediation lifecycle

The normal lifecycle is:

`DRAFTED → DRY_RUN_PASSED → AWAITING_APPROVAL → APPLIED → VERIFYING → VERIFIED`

Alternative terminal outcomes are `DENIED`, `STALE`, and `VALIDATION_FAILED`. `APPLIED` never implies that the Remediation worked.

After application, BLACKBOX must:

1. read back the effective Capability Policy and verify its version/hash;
2. execute the equivalent Attack Replay and obtain `PROTECTED`;
3. execute the equivalent Control Run and preserve the legitimate workflow;
4. finalize complete Evidence Bundles including the approval and policy-transition events.

Only all four conditions produce a Verified Remediation and allow the UI to display `ATTACK CONTAINED`.

### Safe failure

If readback, Attack Replay, Control Run, or evidence finalization fails, the Remediation becomes `VALIDATION_FAILED`. BLACKBOX makes no protected claim, retains the more restrictive policy, stops further autonomous mutation, and requests human direction. There is no automatic rollback in the MVP. The previous version remains preserved for audit; a separately approved rollback workflow is post-MVP.
