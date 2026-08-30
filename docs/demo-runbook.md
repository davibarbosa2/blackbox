# Demo and submission runbook

This runbook keeps the recorded claim aligned with the Evidence Bundles. Use a
fresh runtime directory for the representative take and never show `.env`, API
keys, raw Canary Secrets, or account dashboards in the recording.

## Before recording

1. Follow the README from a clean clone and confirm `pnpm submission:check`,
   `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` pass.
2. Set the exact OpenRouter model and TrueForge alias that will be recorded.
3. Run `pnpm accept:reliability`. Record only after its preflight and three
   consecutive equivalence sets pass for that configuration fingerprint.
4. Set `BLACKBOX_RUNTIME_DIR` to a new ignored directory, for example
   `.blackbox/runtime/recording-2026-08-30`, then run `pnpm demo`.
5. Check the capture frame, browser zoom, readable text, microphone, and that
   no credential-bearing terminal or notification can appear.

## Continuous three-minute story

- **0:00–0:25 — Promise and boundary.** Show the opening scene. Explain that
  BLACKBOX proves one synthetic agent Incident and claims containment only when
  independently observed evidence supports it.
- **0:25–0:55 — Vulnerable Baseline.** Start the Incident. Follow the Support
  Ticket through the four Scenario MCP tools and show the exact Canary receipt
  at the controlled External Sink and the finalized `VULNERABLE` bundle.
- **0:55–1:35 — Investigation.** Keep the TrueForge activity visible while the
  two subagents analyze evidence and policy and Daytona executes the analysis
  artifact. Do not describe hidden chain of thought.
- **1:35–2:00 — Human approval.** Show the pending `apply_policy_patch` action,
  destination-allowlist diff, base hash, evidence, and operational impact. Say
  clearly that the patch is not active yet, then approve that exact action.
- **2:00–2:35 — Automatic verification.** Show policy readback, the equivalent
  Attack Replay reaching an explicit policy denial, and the Control Run sending
  successfully to the Trusted Destination.
- **2:35–3:00 — Evidence-backed result.** Show `VERIFIED`, compare Baseline,
  Replay, and Control, and open the Evidence Bundle links or hashes. End on the
  narrow claim: this attack was contained without disabling legitimate support.

Record one continuous take. If the real flow stalls, fails, or becomes
`INCONCLUSIVE`/`VALIDATION_FAILED`, stop and diagnose it; do not edit around the
failure or narrate it as success.

## Publication and submission

After the chosen recording and final commit are ready:

1. Run `pnpm submission:check` again on the exact commit to publish. Confirm
   `git status --short` is empty and all GitHub Actions checks pass.
2. Inspect the public diff and repository history one final time. Do not add
   `.env`, `.blackbox/`, `.evlog/`, generated `dist/`, SQLite files, logs, or
   raw recording files.
3. Make the GitHub repository public only now. Open its URL in a signed-out
   browser and follow the README far enough to prove the clone and setup paths
   are public.
4. Upload the continuous recording and confirm it is viewable without the
   uploader's account.
5. Submit the public repository URL, recording URL, and the short write-up in
   `docs/trueforge.md` through the organizer's submission form before the
   deadline. Reopen every submitted link in a signed-out browser.
