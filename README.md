# Cafe OS

Headless Hermes Agent deployment for a small coffee-roasting operation. The private operations prototype works through Telegram, routes inference through OpenRouter, and transcribes voice notes.

The Hermes runtime is deliberately installed outside this repository at `~/.hermes`. This repo contains the reproducible configuration, operating instructions, and business notes; credentials and conversation state stay outside Git.

## Current server status

- Hermes Agent is installed per-user at `~/.hermes/hermes-agent`.
- The default provider is OpenRouter using `qwen/qwen3.8-flash`.
- OpenRouter routing excludes providers that may store or train on request data.
- Any future trusted terminal workflow runs in a Docker sandbox with only this repository mounted and container networking disabled.
- Speech-to-text is enabled with the local provider.
- Telegram uses Hermes' built-in adapter; Discord is disabled for the prototype.
- Telegram accepts messages only from explicitly allowlisted operator IDs. Shell, file-write, cron, messaging, and shared-memory access remain disabled.
- Remote admin slash commands are disabled; allowlisted operators receive only the documented safe command set.
- The gateway runs as an enabled per-user systemd service and starts automatically at boot.
- A self-hosted Supabase `v0.8.1` stack is running on loopback-only ports with the four-table Cafe OS schema and invite-only email Auth.
- The TypeScript Cafe API and authenticated React operations UI are served on `127.0.0.1:8100`.
- A ten-tool TypeScript MCP adapter, DeepSeek Flash intent router, exact pending-confirmation store, and guarded Hermes operations skill are connected to the allowlisted Telegram profile. General-purpose tools remain disabled.

## Finish setup

1. Read [Headless deployment](docs/headless-deployment.md).
2. Add the required private settings without placing them in this repository:

   ```bash
   hermes config set OPENROUTER_API_KEY '...'
   hermes config set TELEGRAM_BOT_TOKEN '...'
   hermes config set TELEGRAM_ALLOWED_USERS '123456789'
   ```

3. Validate, install, and start the service:

   ```bash
   ./scripts/validate-hermes.sh
   hermes gateway install
   sudo loginctl enable-linger "$USER"
   hermes gateway start
   hermes gateway status
   ```

The user service plus systemd lingering is intentional on this headless host: it starts at boot and survives logout, while `hermes update` can restart it without root.

## Repository layout

- `AGENTS.md` — operational scope and safety rules injected into agent context.
- `.env.example` — names of required and optional secrets; never commit real values.
- `scripts/bootstrap-hermes.sh` — idempotent headless runtime/config setup.
- `scripts/validate-hermes.sh` — non-secret readiness checks.
- `scripts/setup-hermes-eval.sh` — isolated no-channel Hermes profile for semantic evals.
- `scripts/db.sh` — password-free shell into the local Supabase Postgres container.
- `scripts/cafe-api.sh` — build and operate the loopback-only TypeScript API.
- `services/cafe-api/` — Fastify REST API, Auth token validation, static UI hosting, and tests.
- `services/cafe-web/` — responsive React operations UI for providers, purchases, lots, and roasts.
- `services/cafe-mcp/` — compact TypeScript MCP adapter for trusted Hermes profiles.
- `evals/hermes-operations/` — bilingual semantic, trajectory, hop, and token eval suite.
- `config/hermes/SOUL.md` — versioned Cafe OS organizational identity.
- `.hermes/skills/cafe-os-operations/` — repo-local operating workflow and safety rules.
- `docs/hermes-toolbelt.md` — MCP tools, configuration, and rollout runbook.
- `compose.cafe.yml` — API deployment joined to the private Supabase network.
- `db/migrations/` — ordered SQL migrations for the Cafe OS database.
- `docs/database.md` — current schema, calculations, Storage convention, and access posture.
- `docs/backend-service.md` — REST routes, middleware, validation, and operations.
- `docs/frontend.md` — Auth model, operator setup, UI workflows, and headless access.
- `docs/supabase.md` — self-hosted Supabase operations and security runbook.
- `docs/headless-deployment.md` — Telegram, OpenRouter, voice, and systemd runbook.
- `docs/project-roadmap.md` — phased product direction extracted from the project notes.
- `cafe del rio project exploration.md` — source meeting transcript.

## Security defaults

Telegram is restricted to explicit numeric user IDs because it can access operational records. Keep the reduced toolset, two-stage write confirmations, and slash-command gate in place, and monitor OpenRouter spend. The configured admin ID `0` remains a deliberate no-user sentinel; administer Hermes over SSH unless a separate admin decision is made. Do not enable Hermes YOLO mode, a host-local terminal backend, or unrestricted Docker networking.
