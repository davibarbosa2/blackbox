## Parent

[BLACKBOX Spec v0.1 — verified AI-agent incident remediation](https://github.com/davibarbosa2/blackbox/issues/1)

## What to build

Turn the complete runtime path into a repeatable, resumable reliability gate. It must preflight the configured OpenRouter model and Daytona, execute repeated isolated equivalence sets through BLACKBOX's real HTTP boundary, exercise the important safe-failure paths, and emit an auditable result suitable for deciding whether the demo is ready to record.

## Acceptance criteria

- [ ] A documented acceptance command preflights the configured OpenRouter model's required tool path and the real TrueForge-to-Daytona sandbox path before running equivalence sets.
- [ ] The configured model id is included in every Run fingerprint, remains immutable within each Baseline/Replay set, and can be changed without code edits before starting a new set.
- [ ] The reliability gate produces three consecutive `VULNERABLE` Baseline Runs and three corresponding `PROTECTED` Attack Replays with passing Control Runs and no `INCONCLUSIVE` result.
- [ ] Every iteration resets scenario and sink state, uses a unique Canary Secret, finalizes all required bundles, and verifies no evidence leaked across Runs.
- [ ] The command is resumable after interruption without silently counting partial, duplicated, stale, or differently fingerprinted Runs.
- [ ] Automated failure checks cover approval denial, stale patch, sink timeout, missing or mismatched receipt, model or sandbox failure, replay non-equivalence, missing explicit denial, control failure, evidence-finalization failure, and event reconnection/deduplication.
- [ ] Every failure withholds unsupported verdicts and Verified Remediation, and reports the exact failed evidence gate.
- [ ] The final machine-readable and human-readable summary identifies configuration fingerprints, all six required outcomes, controls, durations, and any rejected attempts.

## Blocked by

- [#5 — Apply and verify the Remediation](https://github.com/davibarbosa2/blackbox/issues/5)
