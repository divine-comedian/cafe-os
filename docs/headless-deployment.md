# Headless Hermes deployment

This server has no graphical session. Hermes runs as a background messaging gateway; Discord and Telegram make outbound connections, so neither adapter needs a public inbound port. Telegram should retain its default long-polling mode rather than using a webhook.

## 1. Install and configure the runtime

From the repository root:

```bash
./scripts/bootstrap-hermes.sh
```

The script skips provisioning Playwright/Chromium, desktop computer-use support, and the interactive wizard. Browser and desktop-control toolsets are not exposed to the messaging agents. Hermes still supports text, files, images, voice-note transcription, terminal/file work in its Docker sandbox, memory, skills, and cron jobs.

The sandbox mounts this repository as its workspace but has container networking disabled. The gateway process itself retains outbound access for Discord, Telegram, OpenRouter, and configured tool providers.

## 2. Configure OpenRouter

Create an API key at [OpenRouter Keys](https://openrouter.ai/keys), then store it in Hermes' private environment file through its config command:

```bash
hermes config set OPENROUTER_API_KEY 'sk-or-v1-...'
```

The configured main model is `openrouter/auto`, allowing OpenRouter to choose a model for each request. Routing is price-first, requires parameter support, and sets `data_collection: deny`. Change the model later from a chat with `/model`, or globally with:

```bash
hermes config set model.default 'provider/model-id'
```

## 3. Create the Telegram bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and run `/newbot`.
2. Choose a display name and a unique username ending in `bot`.
3. Store the token:

   ```bash
   hermes config set TELEGRAM_BOT_TOKEN '123456789:...'
   ```

4. Send the new bot a message, then determine your numeric Telegram user ID with a trusted ID bot or Hermes' gateway setup flow.
5. Restrict access:

   ```bash
   hermes config set TELEGRAM_ALLOWED_USERS '123456789'
   ```

For group use, BotFather privacy mode can remain enabled if the team will use commands, mentions, and replies. If it is disabled so Hermes can see normal group chatter, remove and re-add the bot afterward and explicitly restrict allowed chats.

## 4. Create the Discord bot

The Discord Developer Portal is a browser-only external step; complete it from another computer at [Discord Applications](https://discord.com/developers/applications).

1. Create an application and bot.
2. Enable **Message Content Intent**. Enable **Server Members Intent** when using usernames or role allowlists; numeric user IDs avoid that dependency.
3. Copy the bot token and store it:

   ```bash
   hermes config set DISCORD_BOT_TOKEN '...'
   hermes config set DISCORD_ALLOWED_USERS '123456789012345678'
   ```

4. Under Installation/OAuth2, invite it with the `bot` and `applications.commands` scopes. Grant only the channel permissions it needs: view channel, send messages, read message history, attach files, embed links, add reactions, and use application commands.
5. Keep the bot limited to private operations channels. Hermes requires an `@mention` in server channels by default and isolates group context per user.

Use Discord Developer Mode and **Copy User ID** for the allowlist. Never use `DISCORD_ALLOW_ALL_USERS=true` for this deployment.

## 5. Voice notes

Inbound Discord and Telegram voice notes are enabled. The current provider is local `faster-whisper`, so audio stays on the server. Language detection is automatic for Spanish/English use. The base model is downloaded on first use and may take a moment.

If CPU or memory pressure is too high, use Groq Whisper instead:

```bash
hermes config set GROQ_API_KEY '...'
hermes config set stt.provider groq
```

OpenRouter does not provide Hermes' speech-to-text API. Do not put an OpenAI key in `OPENAI_API_KEY` merely for voice; Hermes uses `VOICE_TOOLS_OPENAI_KEY` for direct OpenAI transcription/TTS.

## 6. Validate and start at boot

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

## 7. Smoke test

1. DM the Telegram bot `/status`, then send a short voice memo.
2. DM the Discord bot `/status`.
3. In the private Discord operations channel, mention the bot and ask it to summarize `AGENTS.md`.
4. Confirm an unlisted account gets no response.
5. Run `/sethome` in the chosen private channel if cron reports should be delivered there.

## 8. Operating commands

```bash
hermes gateway status
hermes gateway restart
hermes doctor
hermes update
```

Secrets live in `~/.hermes/.env` with mode `0600`; configuration lives in `~/.hermes/config.yaml`; gateway logs and sessions live under `~/.hermes/`. Back these up securely and never copy them into this repository.
