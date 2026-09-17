# Headless Hermes deployment

This server has no graphical session. Hermes runs as a background messaging gateway; Telegram makes an outbound connection, so the adapter needs no public inbound port. It should retain its default long-polling mode rather than using a webhook.

## 1. Install and configure the runtime

From the repository root:

```bash
./scripts/bootstrap-hermes.sh
```

The script skips provisioning Playwright/Chromium, desktop computer-use support, and the interactive wizard. The private Telegram agent supports text, images, voice-note transcription, and the Cafe OS MCP toolbelt. General web, browser, shell, repository file, cron, messaging, memory, and delegation tools are intentionally withheld.

The Docker sandbox remains configured for future trusted workflows, with only this repository mounted and container networking disabled. The gateway process itself retains outbound access for Telegram, OpenRouter, and configured tool providers.

## 2. Configure OpenRouter

Create an API key at [OpenRouter Keys](https://openrouter.ai/keys), then store it in Hermes' private environment file through its config command:

```bash
hermes config set OPENROUTER_API_KEY 'sk-or-v1-...'
```

The configured main model is `qwen/qwen3.8-flash` through OpenRouter. Routing is price-first, requires parameter support, and sets `data_collection: deny`. Change the model later from a chat with `/model`, or globally with:

```bash
hermes config set model.default 'provider/model-id'
```

## 3. Create the Telegram bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and run `/newbot`.
2. Choose a display name and a unique username ending in `bot`.
3. Store the token and the numeric Telegram user IDs permitted to operate Cafe OS:

   ```bash
   hermes config set TELEGRAM_BOT_TOKEN '123456789:...'
   hermes config set TELEGRAM_ALLOWED_USERS '123456789'
   ```

4. The bootstrap forces `TELEGRAM_ALLOW_ALL_USERS=false`. Without a non-empty allowlist, the gateway denies all Telegram users.

Only allowlisted IDs can consume model quota or access Cafe OS operations. For group use, BotFather privacy mode can remain enabled if the bot should respond only to commands, mentions, and replies.

The bootstrap also gates slash commands. Allowlisted operators can use `/help`, `/whoami`, `/status`, `/new`, `/reset`, `/usage`, `/voice`, and `/stop`; privileged commands are unavailable. Admin ID `0` is an intentional sentinel that matches no Telegram user, so administration remains SSH-only. To appoint a Telegram administrator later, replace `0` in both `allow_admin_from` settings with that trusted account's numeric user ID.

## 4. Voice notes

Inbound Telegram voice notes are enabled. The current provider is local `faster-whisper`, so audio stays on the server. Language detection is automatic for Spanish/English use. The base model is downloaded on first use and may take a moment.

If CPU or memory pressure is too high, use Groq Whisper instead:

```bash
hermes config set GROQ_API_KEY '...'
hermes config set stt.provider groq
```

OpenRouter does not provide Hermes' speech-to-text API. Do not put an OpenAI key in `OPENAI_API_KEY` merely for voice; Hermes uses `VOICE_TOOLS_OPENAI_KEY` for direct OpenAI transcription/TTS.

## 5. Validate and start at boot

```bash
./scripts/validate-hermes.sh
hermes gateway install
sudo loginctl enable-linger "$USER"
hermes gateway start
hermes gateway status
```

Follow logs without a GUI:

```bash
journalctl --user -u hermes-gateway -f
```

The user service plus lingering survives logout and starts at boot. Avoid installing the system-level unit at the same time; two gateways using the same bot tokens will conflict.

## 6. Smoke test

1. Send the Telegram bot `/status`, then send a short Spanish or English voice memo.
2. Repeat from a non-allowlisted Telegram account and confirm access is denied.
3. Ask the bot what tools it has and confirm Cafe OS tools are present while shell, file, web, cron, messaging, and memory tools are absent.
4. Check OpenRouter usage after the test.

## 7. Operating commands

```bash
hermes gateway status
hermes gateway restart
hermes doctor
hermes update
```

Secrets live in `~/.hermes/.env` with mode `0600`; configuration lives in `~/.hermes/config.yaml`; gateway logs and sessions live under `~/.hermes/`. Back these up securely and never copy them into this repository.
