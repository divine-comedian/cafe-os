# Ticket: add CPU-native Parakeet transcription to Hermes

Status: open

## Goal

Replace the production Telegram voice-note transcription path from local
`faster-whisper` `base` to `nvidia/parakeet-tdt-0.6b-v3`, provided it improves
Spanish/English accuracy without unacceptable latency on this headless server.

The target host has an Intel Core i3-1315U, 30 GiB RAM, and no NVIDIA GPU.
Use the official NVIDIA `NeMo-Speech.cpp` CPU runtime and the published Q8 GGUF
(approximately 714 MB), not the heavyweight NeMo/PyTorch runtime. Parakeet v3
supports English and Spanish but performs whole-utterance transcription rather
than cache-aware streaming, which is appropriate for completed Telegram voice
notes.

References:

- https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- https://github.com/NVIDIA/NeMo-Speech.cpp
- Hermes custom STT providers: `~/.hermes/hermes-agent/website/docs/user-guide/features/tts.md`

## Current state

- `scripts/bootstrap-hermes.sh` installs `faster-whisper==1.2.1` and configures
  `stt.provider=local` with automatic language detection.
- `docs/headless-deployment.md` documents local Whisper as the production voice
  path.
- Hermes supports named command-type STT providers with `{input_path}` and
  `{output_path}` placeholders, so no Hermes fork should be required.

## Implementation

1. Pin and install a known NeMo-Speech.cpp release for the CPU backend. Download
   and verify the official `parakeet-tdt-0.6b-v3.q8_0.gguf`; keep model files
   outside Git and make provisioning idempotent.
2. Add a small headless adapter script that:
   - accepts Hermes' input and output paths;
   - converts Telegram OGG/Opus input to mono 16 kHz PCM WAV when required;
   - invokes `nemo-speech transcribe` with Parakeet v3 and automatic language
     detection;
   - writes only the final transcript as UTF-8 text to the requested output;
   - uses a temporary directory, cleans it up, and returns a non-zero exit code
     with a concise diagnostic on failure.
3. Register the adapter under `stt.providers.parakeet` as a command provider and
   select `stt.provider=parakeet` in `scripts/bootstrap-hermes.sh`. Set a bounded
   timeout suitable for short voice notes. Do not silently fall back on failure.
4. Extend `scripts/validate-hermes.sh` to verify the runtime, model, adapter, and
   selected provider. Update `docs/headless-deployment.md` with installation,
   logs, smoke-test, and rollback instructions.
5. Preserve the existing faster-whisper installation and configuration path so
   rollback is one explicit provider change:

   ```bash
   hermes config set stt.provider local
   ```

## Evaluation

Before making Parakeet the default, compare it with the current Whisper `base`
and multilingual Whisper `small` on the same private fixture set:

- short Mexican Spanish notes;
- short English notes;
- Spanish/English code switching;
- amounts, kilograms, dates, and coffee terminology;
- synthetic provider and person names, including easily confused names such as
  `Chema`.

Record per-file transcript, wall time, peak memory, word/error review, and model
startup time. Do not commit real operational audio, supplier information, or
personal data. A transcription error must remain visible to the agent as text;
do not add model-specific guessing or automatic database writes in this ticket.

## Acceptance criteria

- A Telegram voice note is transcribed locally through Parakeet on a CPU-only
  rebooted host without interactive setup.
- Spanish and English are detected without a user language switch.
- Hermes receives clean transcript text; command logs or JSON never appear in
  the Telegram conversation.
- The benchmark shows a material accuracy improvement over Whisper `base`, with
  acceptable latency and memory for short voice notes.
- Provisioning and validation are repeatable, secrets are not logged, and the
  documented Whisper rollback works.
- Existing text-message, allowlist, Cafe MCP, and final-response-only behavior
  remains unchanged.

## Non-goals

- Live microphone streaming, diarization, or translation.
- Changing Cafe OS database/API behavior.
- Treating ASR output as confirmed operational data.
- Solving entity resolution solely in the transcription layer; provider-name
  lookup and fuzzy matching remain an agent/API concern.
