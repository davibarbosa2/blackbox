# Prove Daytona Sandbox Access

Parent: [Chart the BLACKBOX Hackathon Project](../map.md)
Type: task
Status: resolved
Claimed by: `/root`
Claimed at: 2026-08-24 (America/Sao_Paulo)

## Question

Provision authorized Daytona access without committing secrets, then demonstrate that the selected TrueForge setup can create a cold sandbox and execute a minimal generated Python artifact; what verified setup facts or constraints must the executable system-shape decision respect?

## Answer

Authorized Daytona and OpenRouter credentials are stored only in the git-ignored local `.env`. TrueForge `0.1.4` was started in standalone mode with an isolated SQLite database, configured through its public settings API with the Daytona provider and an OpenAI-compatible OpenRouter provider, and exercised end to end on 2026-08-25.

The selected model for the spike was the pinned OpenRouter model `stealth/ox-alpha`. A direct compatibility probe produced the required function call, and the same model then completed a real TrueForge turn with sandbox access enabled:

1. TrueForge registered the Daytona sandbox image and advanced the provider from `pending` (`pulling`) to `ready`.
2. The turn emitted `sandbox.created` for Daytona sandbox `default.70a7fe84-9386-4eaa-9d6f-c41889dbe0da`.
3. The model called TrueForge's sandbox `exec` tool to create and execute `blackbox_spike.py`.
4. Daytona returned exit code `0` and exact stdout `BLACKBOX_DAYTONA_OK`.
5. The turn completed with status `done` in about 23.5 seconds and persisted merged tool-call, tool-response, sandbox, and terminal events.
6. A separate Daytona API readback confirmed that the referenced sandbox existed and was in state `started`.

### Constraints carried into the architecture

- Daytona API access is a real runtime dependency. The key needs sandbox and snapshot create/delete permissions because TrueForge registers its release image as a snapshot before cloning a session sandbox.
- Keep TrueForge on the pinned `0.1.4` server and persist its local SQLite data outside the repository. Provider credentials are configured in TrueForge's settings store and never enter the sandbox.
- OpenRouter works through TrueForge's custom OpenAI-compatible provider path at `https://openrouter.ai/api/v1`.
- Pin a literal model id for every equivalence set. Never use the rotating `openrouter/free` router for baseline/replay comparisons.
- Free-model availability is not deterministic: `z-ai/glm-5.2:free` returned `429` during the spike while other free models remained available. Run a model/tool preflight before every recorded demo and retain an explicitly selected fallback; never switch models inside one baseline/replay equivalence set.
- `stealth/ox-alpha` currently supports tools and completed the real Daytona run, but its alpha identity and zero price are external conditions to re-check before the reliability gate and recording.
- Qodo installation was completed by the developer for `davibarbosa2/blackbox`; the first implementation pull request must confirm that the review app actually posts its review.

No secret, TrueForge database, or Daytona artifact is committed to the repository.
