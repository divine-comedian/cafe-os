#!/usr/bin/env bash
set -euo pipefail

fail() {
  failure_code="${2:-1}"
  if [ "${log_ready:-0}" -eq 1 ]; then
    flush_failure_diagnostics
    log_event "request=$request_id event=failure stage=$current_stage exit_code=$failure_code elapsed_ms=$(elapsed_millis) message=$(log_safe "$1")"
  fi
  printf 'Parakeet transcription failed: %s\n' "$1" >&2
  exit "$failure_code"
}

log_safe() {
  printf '%s' "$1" | tr '\r\n\t ' '____'
}

now_millis() {
  date +%s%3N
}

elapsed_millis() {
  printf '%s' "$(( $(now_millis) - started_millis ))"
}

log_event() {
  local log_message="$1"
  (
    flock -x 9
    if [ -f "$log_path" ] \
      && [ "$(wc -c < "$log_path" | tr -d '[:space:]')" -ge 5242880 ]; then
      mv -f "$log_path" "$log_path.1"
      : > "$log_path"
      chmod 600 "$log_path"
    fi
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$log_message" >> "$log_path"
  ) 9>"$log_lock"
}

flush_failure_diagnostics() {
  [ "${diagnostics_flushed:-0}" -eq 0 ] || return
  diagnostics_flushed=1
  if [ -n "${diagnostic_log:-}" ] && [ -s "$diagnostic_log" ]; then
    while IFS= read -r diagnostic_line; do
      log_event "request=$request_id event=diagnostic detail=$(log_safe "$diagnostic_line")"
    done < <(tail -n 80 "$diagnostic_log")
  fi
}

[ "$#" -eq 2 ] || fail "usage: $0 INPUT_PATH OUTPUT_PATH"

input_path="$1"
output_path="$2"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hermes_home="${HERMES_HOME:-$HOME/.hermes}"
nemo_speech_bin="${NEMO_SPEECH_BIN:-$hermes_home/tools/nemo-speech/0.1.0/bin/nemo-speech}"
model_path="${PARAKEET_MODEL_PATH:-$hermes_home/models/parakeet-tdt-0.6b-v3/parakeet-tdt-0.6b-v3.q8_0.gguf}"
vocabulary_path="${VOICE_VOCABULARY_PATH:-$hermes_home/state/voice-vocabulary/vocabulary.json}"
vocabulary_resolver="${VOICE_VOCABULARY_RESOLVER:-$script_dir/resolve-stt-vocabulary.py}"
python_bin="${PYTHON_BIN:-python3}"
ffmpeg_bin="${FFMPEG_BIN:-ffmpeg}"
ffprobe_bin="${FFPROBE_BIN:-ffprobe}"
log_path="${PARAKEET_STT_LOG_PATH:-$hermes_home/logs/parakeet-stt.log}"
log_dir="$(dirname "$log_path")"
log_lock="$log_path.lock"
request_id="$(date -u +%Y%m%dT%H%M%S)-$$-$RANDOM"
started_millis="$(now_millis)"
current_stage="initialization"
diagnostic_log=""
diagnostics_flushed=0
log_ready=0

command -v flock >/dev/null 2>&1 || fail "flock is unavailable"
if ! install -d -m 700 "$log_dir" \
  || ! touch "$log_path" "$log_lock" \
  || ! chmod 600 "$log_path" "$log_lock"; then
  fail "internal log is unavailable"
fi
log_ready=1

[ -r "$input_path" ] || fail "input audio is not readable"
[ "$input_path" != "$output_path" ] || fail "input and output paths must differ"
[ -d "$(dirname "$output_path")" ] || fail "output directory does not exist"
[ -x "$nemo_speech_bin" ] || fail "NeMo-Speech.cpp runtime is unavailable"
[ -r "$model_path" ] || fail "Parakeet model is unavailable"
command -v "$ffmpeg_bin" >/dev/null 2>&1 || fail "ffmpeg is unavailable"
command -v "$ffprobe_bin" >/dev/null 2>&1 || fail "ffprobe is unavailable"
command -v iconv >/dev/null 2>&1 || fail "iconv is unavailable"
command -v "$python_bin" >/dev/null 2>&1 || fail "python3 is unavailable"
[ -r "$vocabulary_resolver" ] || fail "voice-vocabulary resolver is unavailable"

input_bytes="$(wc -c < "$input_path" | tr -d '[:space:]')"
log_event "request=$request_id event=start input_bytes=$input_bytes"

current_stage="temporary_directory"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/hermes-parakeet.XXXXXX")" \
  || fail "temporary directory could not be created"
trap 'rm -rf -- "$work_dir"' EXIT
diagnostic_log="$work_dir/diagnostic.log"
wav_path="$work_dir/input.wav"
transcript_path="$work_dir/transcript.txt"
utf8_path="$work_dir/transcript.utf8.txt"
resolved_path="$work_dir/transcript.resolved.txt"
vocabulary_report="$work_dir/vocabulary-report.json"
vocabulary_diagnostic="$work_dir/vocabulary-diagnostic.log"

format_name="$("$ffprobe_bin" -v error -show_entries format=format_name -of default=noprint_wrappers=1:nokey=1 "$input_path" 2>>"$diagnostic_log" || true)"
codec_name="$("$ffprobe_bin" -v error -select_streams a:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "$input_path" 2>>"$diagnostic_log" || true)"
sample_rate="$("$ffprobe_bin" -v error -select_streams a:0 -show_entries stream=sample_rate -of default=noprint_wrappers=1:nokey=1 "$input_path" 2>>"$diagnostic_log" || true)"
channels="$("$ffprobe_bin" -v error -select_streams a:0 -show_entries stream=channels -of default=noprint_wrappers=1:nokey=1 "$input_path" 2>>"$diagnostic_log" || true)"
duration_seconds="$("$ffprobe_bin" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$input_path" 2>>"$diagnostic_log" || true)"
log_event "request=$request_id event=probe format=$(log_safe "${format_name:-unknown}") codec=$(log_safe "${codec_name:-unknown}") sample_rate=$(log_safe "${sample_rate:-unknown}") channels=$(log_safe "${channels:-unknown}") duration_seconds=$(log_safe "${duration_seconds:-unknown}")"

if [[ ",$format_name," == *,wav,* ]] \
  && [ "$codec_name" = "pcm_s16le" ] \
  && [ "$sample_rate" = "16000" ] \
  && [ "$channels" = "1" ]; then
  transcription_input="$input_path"
  log_event "request=$request_id event=conversion skipped=true reason=compatible_pcm_wav"
else
  current_stage="audio_conversion"
  if ! "$ffmpeg_bin" -nostdin -hide_banner -loglevel error -y \
    -i "$input_path" -map 0:a:0 -ac 1 -ar 16000 -c:a pcm_s16le \
    "$wav_path" 2>>"$diagnostic_log"; then
    fail "audio conversion did not complete"
  fi
  transcription_input="$wav_path"
  log_event "request=$request_id event=conversion skipped=false output_bytes=$(wc -c < "$wav_path" | tr -d '[:space:]')"
fi

# Omitting --language enables Parakeet's multilingual automatic detection.
current_stage="nemo_transcription"
log_event "request=$request_id event=nemo_start runtime_version=0.1.0 device=cpu model=parakeet-tdt-0.6b-v3.q8_0"
set +e
LC_ALL=C.UTF-8 "$nemo_speech_bin" transcribe "$transcription_input" \
  --model "$model_path" --device cpu --format text \
  --output "$transcript_path" --force \
  >"$work_dir/nemo-stdout.log" 2>>"$diagnostic_log"
nemo_status=$?
set -e
if [ "$nemo_status" -ne 0 ]; then
  fail "NeMo-Speech.cpp did not complete" "$nemo_status"
fi
log_event "request=$request_id event=nemo_complete stdout_bytes=$(wc -c < "$work_dir/nemo-stdout.log" | tr -d '[:space:]') diagnostic_bytes=$(wc -c < "$diagnostic_log" | tr -d '[:space:]')"

current_stage="transcript_validation"
[ -s "$transcript_path" ] || fail "NeMo-Speech.cpp returned an empty transcript"
if ! iconv -f UTF-8 -t UTF-8 "$transcript_path" > "$utf8_path"; then
  fail "NeMo-Speech.cpp returned invalid UTF-8"
fi
[ -s "$utf8_path" ] || fail "NeMo-Speech.cpp returned an empty transcript"

current_stage="vocabulary_resolution"
if "$python_bin" "$vocabulary_resolver" \
  --vocabulary "$vocabulary_path" --input "$utf8_path" \
  --output "$resolved_path" --report "$vocabulary_report" \
  2>"$vocabulary_diagnostic"; then
  [ -s "$resolved_path" ] || fail "voice-vocabulary resolver returned an empty transcript"
  vocabulary_stats="$(tr -d '\r\n' < "$vocabulary_report")"
  log_event "request=$request_id event=vocabulary_complete stats=$(log_safe "$vocabulary_stats")"
else
  # Vocabulary suggestions are advisory. Preserve delivery of the raw ASR output
  # while recording the internal failure for debugging.
  cp "$utf8_path" "$resolved_path" || fail "raw transcript fallback could not be prepared"
  log_event "request=$request_id event=vocabulary_failure fallback=raw_transcript"
  while IFS= read -r diagnostic_line; do
    log_event "request=$request_id event=vocabulary_diagnostic detail=$(log_safe "$diagnostic_line")"
  done < <(tail -n 20 "$vocabulary_diagnostic")
fi

current_stage="output_write"
if ! install -m 600 "$resolved_path" "$output_path"; then
  fail "transcript output could not be written"
fi
log_event "request=$request_id event=success transcript_bytes=$(wc -c < "$resolved_path" | tr -d '[:space:]') elapsed_ms=$(elapsed_millis)"
