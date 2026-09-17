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

The configured main model is `qwen/qwen3.8-flash` through OpenRouter. Routing is price-first, requires parameter support, and sets `data_collection: deny`. If the primary request fails because the model is rate-limited or unavailable, Hermes makes one primary attempt and then switches the same in-progress turn to `z-ai/glm-5.3-flash` through OpenRouter. Hermes preserves the conversation and tool state across that switch.

GLM 5.3 Flash currently exposes `low`, `high`, and `max` reasoning tiers rather than `medium`. The fallback is pinned to `high` and is availability insurance only: the Cafe plugin allows it for rate limits, model-unavailable responses, upstream service outages, and transport timeouts. It does not retry semantic mistakes, malformed tool use, validation errors, billing, or authentication failures on GLM. Change the model later from a chat with `/model`, or globally with:

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

Telegram is configured for final-response-only delivery. Tool progress, model reasoning, interim assistant narration, streaming drafts, and mid-run steering acknowledgements remain available in server logs where appropriate but are not posted into the operator conversation. A follow-up message still redirects the active run; suppressing its acknowledgement avoids an internal Hermes status message without discarding the correction.

Production uses the full Cafe tool catalog, so an ordinary Telegram turn does not make a separate intent-classifier model call. Each `API call #N` entry in `~/.hermes/logs/agent.log` is a main-model hop. A message sent while a model request is active can abort that request and redirect the run, which may create another model request even though only one final reply is delivered.

Telegram conversations have no idle timeout: a routed conversation remains active across quiet periods and gateway restarts. Only an explicit `/new` or `/reset`, `/stop`, or an unrecoverable context-compression boundary starts a replacement session. Pending Cafe proposals are stored separately under `~/.hermes/state/cafe-mcp`, survive gateway restarts, and remain resumable for seven days by default. Natural approvals such as “ship it,” “I approve it,” “go ahead,” and “sí, guárdalo” resume the exact stored proposal.

For a request that requires several related records, the bot presents one consolidated field list. One approval authorizes all non-destructive creates, updates, and evidence uploads named in that prompt during the confirmation turn, up to eight writes. It does not authorize an unlisted action, a deletion, or confirming/voiding a roast; those remain separate approvals. Purchases and green-coffee lots have no status and are active when created.

## 4. Voice notes

Inbound Telegram voice notes are enabled. The production provider is NVIDIA Parakeet TDT 0.6B v3 through the CPU-only NeMo-Speech.cpp runtime, so audio stays on the server. The bootstrap downloads the pinned native runtime and official Q8 GGUF into `~/.hermes/`, verifies both SHA-256 digests, and registers `scripts/transcribe-parakeet.sh` as Hermes' `parakeet` command provider. Provisioning is idempotent and model files remain outside Git.

Telegram OGG/Opus is converted to mono 16 kHz PCM WAV in a private temporary directory. Parakeet performs whole-utterance transcription with automatic language detection. A local resolver then compares the raw text with the private vocabulary at `~/.hermes/state/voice-vocabulary/vocabulary.json`. It never rewrites the raw transcript: when it finds an explicit alias, conservative spelling near-match, or unambiguous bilingual phonetic match, it appends a marked, unverified suggestion block for the agent. One synthetic canonical entry such as `Ximena` can therefore cover renderings such as `Jimena` and `Gimena`; aliases remain available for exceptional cases. If two canonical terms share the same coarse phonetic key, automatic phonetic matching for that key is disabled to avoid choosing between them. The agent must still confirm the intended name before using it in an operational record. If the resolver fails, the adapter delivers the raw transcript and records the failure internally. Temporary files are removed afterward.

The `voice_vocabulary` MCP server lets the allowlisted agent list, add, update, or remove terms. Ask the bot, “Remember the voice term Ximena,” and the idempotent upsert happens immediately without a confirmation round trip. You can still supply aliases for a genuinely exceptional rendering; an explicit alias update replaces the complete alias list, while omitting aliases preserves an existing list. The agent may also save an exact Cafe entity it resolves during normal work, but it never learns solely from an unverified transcript suggestion. Removal remains destructive and requires second-turn approval. Writes are atomic and the file uses mode `0600`.

Confirm the installed runtime and model at any time:

```bash
./scripts/install-parakeet-stt.sh --verify-only
~/.hermes/tools/nemo-speech/0.1.0/bin/nemo-speech doctor
```

To smoke-test the adapter over SSH without exposing the transcript in shell history, write it to a private file:

```bash
test_dir="$(mktemp -d)"
./scripts/transcribe-parakeet.sh /path/to/private-note.ogg "$test_dir/transcript.txt"
sed -n '1,5p' "$test_dir/transcript.txt"
```

Remove the temporary test directory after reviewing it. Do not copy operational audio or transcripts into this repository.

Follow gateway failures in the headless service log:

```bash
journalctl --user -u hermes-gateway -f
```

The adapter also writes private structured diagnostics to `~/.hermes/logs/parakeet-stt.log` with mode `0600`. It records request-local stages, media format, sample rate, channel count, duration, byte counts, vocabulary entry/match counts, elapsed time, and up to 80 native diagnostic lines on failure. It never records transcript text, vocabulary terms, aliases, or audio content. The log rotates to `parakeet-stt.log.1` at 5 MiB. Inspect recent failures with:

```bash
tail -n 100 ~/.hermes/logs/parakeet-stt.log
```

The existing `faster-whisper==1.2.1` installation remains available. Roll back explicitly and restart the gateway:

```bash
hermes config set stt.provider local
hermes gateway restart
```

Restore Parakeet with `hermes config set stt.provider parakeet` after testing. Never configure an automatic fallback: a failed transcription must remain visible as a failure.

If an operator explicitly chooses cloud transcription because CPU or memory pressure is too high, use Groq Whisper instead:

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

1. Send the Telegram bot `/status`, then send separate short Spanish and English voice memos and one code-switched memo.
2. Repeat from a non-allowlisted Telegram account and confirm access is denied.
3. Ask the bot what tools it has and confirm Cafe OS tools are present while shell, file, web, cron, messaging, and memory tools are absent.
4. Check OpenRouter usage after the test.

Before accepting Parakeet for production, compare it on the same private fixture set against the retained Whisper `base` and Whisper `small` models. Record each transcript, wall time, peak memory, first-run/model-startup time, and a human word/error review. Include Mexican Spanish, English, code switching, amounts, kilograms, dates, coffee terms, and synthetic confusable names such as `Ximena`. Keep the fixtures and results outside Git when they contain operational, supplier, or personal data. If Parakeet does not materially improve accuracy within acceptable latency and memory, use the explicit Whisper rollback above.

## 7. Operating commands

```bash
hermes gateway status
hermes gateway restart
hermes doctor
hermes update
```

Secrets live in `~/.hermes/.env` with mode `0600`; configuration lives in `~/.hermes/config.yaml`; gateway logs and sessions live under `~/.hermes/`. Back these up securely and never copy them into this repository.
