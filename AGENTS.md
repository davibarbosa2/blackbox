# BLACKBOX Engineering Guide

This file defines the repository-wide working agreement for humans and coding
agents. Keep it short, enforceable, and updated when the same failure recurs.

## Start With a Contract

Before editing, state:

1. Goal — the observable outcome.
2. Context — the issue, files, evidence, and external systems in scope.
3. Constraints — safety boundaries and changes that are out of scope.
4. Done when — the commands or acceptance evidence that prove completion.

For multi-step or ambiguous work, write a brief plan whose steps each end in a
verification check. Ask before choosing between interpretations that materially
change behavior or architecture.

## Domain and Scope

- Read `CONTEXT.md` before changing domain terminology, Incident lifecycle,
  evidence, verdicts, Remediation, Capability Policy, or approval behavior. Use
  its canonical terms in code and documentation.
- Treat the SQLite Evidence Ledger and durable remediation state as sources of
  truth. Operational logs are diagnostic telemetry, not verdict evidence.
- Preserve the human approval boundary: proposing and dry-running a Policy
  Patch must not apply it.
- Make surgical changes. Every changed line must trace to the issue or to an
  orphan created by that change. Record unrelated problems instead of folding
  them into the current patch.

## Development Loop

1. Reproduce the requested behavior or failure with the smallest useful test.
2. For behavior changes, make the test red for the intended reason.
3. Implement the minimum change that makes it green.
4. Run focused tests and typecheck while iterating.
5. Refactor only after green, and only within the changed seam.
6. Before handoff, run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
   `git diff --check`.

Use Node.js 22.23.2 and pnpm 11.16.0. Runtime acceptance commands use real
OpenRouter and Daytona resources; deterministic checks must not depend on them.
When a change affects a real-runtime boundary, run the relevant acceptance
command from `README.md` and report infrastructure failures separately from
product failures.

## Git Checkpoints

- Work on a branch scoped to one issue or coherent outcome.
- Commit every coherent green milestone. A milestone includes its tests and
  leaves the repository buildable; do not accumulate a finished feature as one
  oversized working-tree diff.
- Prefer semantic commits such as `feat(policy): ...`, `fix(runtime): ...`,
  `test(investigation): ...`, or `docs: ...`. Reference the issue when useful.
- Before each commit, inspect `git diff --staged` and run the focused checks for
  that milestone. Before the final commit, run all deterministic gates.
- Preserve useful local milestones. Amend only the current unpublished commit
  for a small correction to that same milestone.
- Treat pushed or shared history as immutable. Rebase, reset, squash, or
  force-push it only with explicit human approval and a stated recovery path.
- Never mix generated runtime state, credentials, `.env`, `.blackbox/runtime/`,
  or `.evlog/logs/` into commits.

## Review and Handoff

- Review the complete diff against both repository standards and the issue's
  acceptance criteria.
- Check invalid inputs, retry ordering, reconnection, durable identifiers,
  approval boundaries, and unintended capability widening when those concerns
  are in scope.
- Keep the worktree clean at handoff. Report the branch, commits, checks run,
  real acceptance evidence, and any remaining caveat. Do not claim an external
  acceptance passed when it was skipped or blocked.

Work is done only when the requested behavior is implemented, relevant tests
and documentation agree with it, deterministic gates pass, review findings are
resolved, and the result is recorded in coherent commits.

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues using the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Triage labels

This repo uses the five default canonical triage labels. See
`docs/agents/triage-labels.md`.

### Domain docs

This repo uses a single-context domain layout. See `docs/agents/domain.md`.
