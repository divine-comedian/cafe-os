# Cafe OS

Headless Hermes Agent deployment for a small coffee-roasting operation. The public prototype works through Telegram, routes inference through OpenRouter, and transcribes voice notes.

The Hermes runtime is deliberately installed outside this repository at `~/.hermes`. This repo contains the reproducible configuration, operating instructions, and business notes; credentials and conversation state stay outside Git.

## Current server status

- Hermes Agent is installed per-user at `~/.hermes/hermes-agent`.
- The default provider is OpenRouter using `openrouter/auto`.
- OpenRouter routing excludes providers that may store or train on request data.
- Any future trusted terminal workflow runs in a Docker sandbox with only this repository mounted and container networking disabled.
- Speech-to-text is enabled with the local provider.
- Telegram uses Hermes' built-in adapter; Discord is disabled for the prototype.
- Telegram accepts messages from any user. Its public toolset excludes shell, file-write, cron, messaging, and shared-memory access.
- Remote admin slash commands are disabled; public users receive only the documented safe command set.
- The gateway service is not started until the OpenRouter key and Telegram bot token are configured.
- A self-hosted Supabase `v0.8.1` stack is running on loopback-only ports; its `public` schema has no application tables.

## Finish setup

1. Read [Headless deployment](docs/headless-deployment.md).
2. Add the two required secrets without placing them in this repository:

   ```bash
   hermes config set OPENROUTER_API_KEY '...'
   hermes config set TELEGRAM_BOT_TOKEN '...'
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
- `docs/headless-deployment.md` — Telegram, OpenRouter, voice, and systemd runbook.
- `docs/project-roadmap.md` — phased product direction extracted from the project notes.
- `cafe del rio project exploration.md` — source meeting transcript.

## Security defaults

Telegram is deliberately public for this prototype. Keep its reduced toolset and slash-command gate in place, monitor OpenRouter spend, and never add terminal, file, cron, messaging, or memory tools while anonymous access is enabled. The configured admin ID `0` is a deliberate no-user sentinel; administer Hermes over SSH until it is replaced with a real trusted Telegram user ID. Do not enable Hermes YOLO mode, a host-local terminal backend, or unrestricted Docker networking.
