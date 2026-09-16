# Cafe OS

Headless Hermes Agent deployment for a small coffee-roasting operation. The initial agent works through Discord and Telegram, routes inference through OpenRouter, transcribes voice notes, and uses this repository as its operating context.

The Hermes runtime is deliberately installed outside this repository at `~/.hermes`. This repo contains the reproducible configuration, operating instructions, and business notes; credentials and conversation state stay outside Git.

## Current server status

- Hermes Agent is installed per-user at `~/.hermes/hermes-agent`.
- The default provider is OpenRouter using `openrouter/auto`.
- OpenRouter routing excludes providers that may store or train on request data.
- Agent terminal commands run in a Docker sandbox with only this repository mounted and container networking disabled.
- Speech-to-text is enabled with the local provider.
- Discord and Telegram use Hermes' built-in adapters; no custom adapter fork is needed.
- The gateway service is not started until real API keys, bot tokens, and user allowlists are configured.
- A self-hosted Supabase `v0.8.1` stack is running on loopback-only ports; its `public` schema has no application tables.

## Finish setup

1. Read [Headless deployment](docs/headless-deployment.md).
2. Add the five required values without placing them in this repository:

   ```bash
   hermes config set OPENROUTER_API_KEY '...'
   hermes config set TELEGRAM_BOT_TOKEN '...'
   hermes config set TELEGRAM_ALLOWED_USERS '...'
   hermes config set DISCORD_BOT_TOKEN '...'
   hermes config set DISCORD_ALLOWED_USERS '...'
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
- `scripts/db.sh` — password-free shell into the local Supabase Postgres container.
- `docs/supabase.md` — self-hosted Supabase operations and security runbook.
- `docs/headless-deployment.md` — Telegram, Discord, OpenRouter, voice, and systemd runbook.
- `docs/project-roadmap.md` — phased product direction extracted from the project notes.
- `cafe del rio project exploration.md` — source meeting transcript.

## Security defaults

Both messaging adapters fail closed unless an allowlist is configured. Discord requires mentions in server channels by default. Do not enable `*_ALLOW_ALL_USERS`, Hermes YOLO mode, a host-local terminal backend, or unrestricted Docker networking on this server without a deliberate security review.
