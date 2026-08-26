# BLACKBOX

This repository currently contains the executable TrueForge–Daytona runtime
harness for BLACKBOX. The acceptance command starts BLACKBOX and the pinned
standalone TrueForge service, configures the providers and smoke agent, checks
tool-calling support, and executes generated Python in a real Daytona sandbox.

## Requirements

- Node.js `22.23.2` (also pinned in `.nvmrc`)
- pnpm `11.16.0` (also pinned in `package.json`)
- Valid OpenRouter and Daytona API credentials

From a clean checkout:

```bash
nvm install
nvm use
corepack enable
corepack prepare pnpm@11.16.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env
```

Fill in `.env`. `OPENROUTER_MODEL_ID` selects the upstream model and is
required; `stealth/ox-alpha` is only the initially validated example. The
corresponding TrueForge model name is
`openrouter/${TRUEFORGE_MODEL_ALIAS}`.

## Runtime acceptance smoke

Run one command:

```bash
pnpm smoke:runtime
```

The command:

1. starts BLACKBOX and TrueForge `0.1.4` and waits for exact health checks;
2. idempotently upserts and reads back the OpenRouter configuration, then
   upserts Daytona and waits until it is ready;
3. creates or updates the saved `blackbox-runtime-smoke` Agent Spec;
4. proves the selected model can make a required tool call;
5. observes `sandbox.created`, an `exec` result with exit code `0` and
   `BLACKBOX_DAYTONA_OK`, matching live and persisted events, and
   `turn.done.status = done`.

Success output contains the requested and returned model fingerprints, sandbox
event, execution result, terminal turn state, and the local evidence path. It
does not print credentials. Evidence and TrueForge state persist under
`.blackbox/runtime/`, which is ignored by Git.

The command refuses occupied BLACKBOX or TrueForge ports and never attaches to
or stops a process it did not start. `Ctrl-C` cancels an active smoke, records
that cancellation, stops the owned services, and exits. Normal completion uses
the same shutdown path. Daytona sandboxes are configured to auto-stop after 5
minutes and auto-delete after 2 hours.

## Configuration

| Variable | Required | Default |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | yes | — |
| `OPENROUTER_MODEL_ID` | yes | — |
| `DAYTONA_API_KEY` | yes | — |
| `TRUEFORGE_MODEL_ALIAS` | no | `ox-alpha` |
| `BLACKBOX_HOST` | no | `127.0.0.1` |
| `BLACKBOX_PORT` | no | `3000` |
| `TRUEFORGE_HOST` | no | `127.0.0.1` |
| `TRUEFORGE_PORT` | no | `8790` |
| `BLACKBOX_RUNTIME_DIR` | no | `.blackbox/runtime` |

## Deterministic checks

These checks use local or in-memory boundaries and do not call OpenRouter or
Daytona:

```bash
pnpm typecheck
pnpm test
```
