## Parent

[BLACKBOX Spec v0.1 — verified AI-agent incident remediation](https://github.com/davibarbosa2/blackbox/issues/1)

## What to build

Deliver the executable BLACKBOX walking skeleton. A developer with valid OpenRouter and Daytona credentials can start the locally pinned BLACKBOX and TrueForge services with one command, select an OpenRouter model through documented configuration, and observe that model use TrueForge to execute generated Python in a real Daytona sandbox.

This ticket establishes the production runtime boundary and acceptance seam used by every later ticket. It must turn the existing exploratory spike into a reproducible product command without carrying over temporary spike state.

## Acceptance criteria

- [ ] A clean checkout with the documented Node.js and pnpm versions, `.env.example`, and valid credentials starts BLACKBOX and the pinned standalone TrueForge version through one documented command.
- [ ] The OpenRouter model id is selected through configuration and is not hard-coded in application logic or saved Agent Specs; `stealth/ox-alpha` may be the documented initially validated example.
- [ ] Startup waits for health checks and idempotently configures OpenRouter, Daytona, and the saved smoke Agent Spec without requiring dashboard setup.
- [ ] A capability preflight proves that the configured model can make the required tool call before the sandbox smoke proceeds.
- [ ] The smoke creates a real Daytona sandbox, executes generated Python, observes exit code `0` and expected stdout, reconciles persisted TrueForge events, and ends with `turn.done.status = done`.
- [ ] The acceptance output includes the exact provider/model fingerprint, `sandbox.created`, sandbox execution result, and terminal turn state without printing credentials.
- [ ] Runtime databases, credentials, and generated state stay ignored; the command has a safe repeatable shutdown path.
- [ ] Automated checks cover configuration validation, health-check failure, event reconciliation, and clean shutdown without requiring the real external smoke on every unit-test run.
- [ ] The implementation pull request receives a Qodo review, and every material finding is fixed or explicitly answered before merge.

## Blocked by

None (can start immediately).
