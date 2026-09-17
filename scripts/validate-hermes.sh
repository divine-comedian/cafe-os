#!/usr/bin/env bash
set -euo pipefail

failure=0

check_command() {
  if command -v "$1" >/dev/null 2>&1; then
    printf 'ok   command: %s\n' "$1"
  else
    printf 'FAIL command missing: %s\n' "$1" >&2
    failure=1
  fi
}

check_env_value() {
  variable="$1"
  env_file="${HERMES_HOME:-$HOME/.hermes}/.env"
  if [ -f "$env_file" ] && grep -Eq "^${variable}=.+" "$env_file"; then
    printf 'ok   environment value configured: %s\n' "$variable"
  else
    printf 'MISS environment value not configured: %s\n' "$variable"
    failure=1
  fi
}

check_qwen_budget_policy() {
  hermes_root="${HERMES_HOME:-$HOME/.hermes}"
  python_bin="$hermes_root/hermes-agent/venv/bin/python"
  if [ ! -x "$python_bin" ]; then
    printf "FAIL Hermes Python missing: %s\n" "$python_bin" >&2
    failure=1
    return
  fi
  cap="$("$python_bin" -c "from providers import get_provider_profile; print(get_provider_profile(\"openrouter\").get_max_tokens(\"qwen/qwen3.8-flash\"))" 2>/dev/null || true)"
  if [ "$cap" = "16384" ]; then
    printf "ok   Qwen wire output cap: %s tokens\n" "$cap"
  else
    printf "FAIL Qwen wire output cap: expected 16384, got %s\n" "${cap:-unset}" >&2
    failure=1
  fi
}

check_model_failover_policy() {
  if ! command -v hermes >/dev/null 2>&1; then
    return
  fi

  fallback_provider="$(hermes config get fallback_model.provider 2>/dev/null || true)"
  fallback_model="$(hermes config get fallback_model.model 2>/dev/null || true)"
  fallback_effort="$(hermes config get agent.reasoning_overrides.z-ai/glm-5.3-flash 2>/dev/null || true)"
  api_retries="$(hermes config get agent.api_max_retries 2>/dev/null || true)"
  telegram_busy_ack="$(hermes config get display.platforms.telegram.busy_steer_ack_enabled 2>/dev/null || true)"

  if [ "$fallback_provider" = "openrouter" ] \
    && [ "$fallback_model" = "z-ai/glm-5.3-flash" ]; then
    printf 'ok   model fallback: %s via %s\n' "$fallback_model" "$fallback_provider"
  else
    printf 'FAIL model fallback must be z-ai/glm-5.3-flash via openrouter\n' >&2
    failure=1
  fi

  if [ "$fallback_effort" = "high" ]; then
    printf 'ok   GLM fallback reasoning tier: high\n'
  else
    printf 'FAIL GLM fallback reasoning tier must be high, got %s\n' "${fallback_effort:-unset}" >&2
    failure=1
  fi

  if [ "$api_retries" = "1" ]; then
    printf 'ok   API attempts before model failover: %s\n' "$api_retries"
  else
    printf 'FAIL agent.api_max_retries must be 1, got %s\n' "${api_retries:-unset}" >&2
    failure=1
  fi

  if [ "$telegram_busy_ack" = "false" ]; then
    printf 'ok   Telegram mid-run steering acknowledgements: hidden\n'
  else
    printf 'FAIL Telegram busy steering acknowledgements must be false\n' >&2
    failure=1
  fi
}

check_cafe_mcp_policy() {
  if ! command -v hermes >/dev/null 2>&1; then
    return
  fi

  pending_ttl_ms="$(hermes config get mcp_servers.cafe_os.env.CAFE_MCP_PENDING_TTL_MS 2>/dev/null || true)"
  if [ "$pending_ttl_ms" = "604800000" ]; then
    printf 'ok   Cafe pending proposal TTL: 7 days\n'
  else
    printf 'FAIL Cafe pending proposal TTL must be 604800000 ms, got %s\n' "${pending_ttl_ms:-unset}" >&2
    failure=1
  fi
}

check_parakeet_stt() {
  project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  adapter="$project_root/scripts/transcribe-parakeet.sh"
  installer="$project_root/scripts/install-parakeet-stt.sh"
  resolver="$project_root/scripts/resolve-stt-vocabulary.py"
  parakeet_log="${HERMES_HOME:-$HOME/.hermes}/logs/parakeet-stt.log"
  vocabulary_file="${HERMES_HOME:-$HOME/.hermes}/state/voice-vocabulary/vocabulary.json"
  vocabulary_server="$project_root/services/cafe-mcp/dist/voice-vocabulary-server.js"

  if [ -x "$installer" ] && bash -n "$installer"; then
    printf 'ok   Parakeet installer: %s\n' "$installer"
  else
    printf 'FAIL Parakeet installer is missing, non-executable, or invalid: %s\n' "$installer" >&2
    failure=1
  fi

  if [ -x "$adapter" ] && bash -n "$adapter"; then
    printf 'ok   Parakeet adapter: %s\n' "$adapter"
  else
    printf 'FAIL Parakeet adapter is missing, non-executable, or invalid: %s\n' "$adapter" >&2
    failure=1
  fi

  if [ -x "$resolver" ] && python3 -c 'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"), sys.argv[1], "exec")' "$resolver"; then
    printf 'ok   STT vocabulary resolver: %s\n' "$resolver"
  else
    printf 'FAIL STT vocabulary resolver is missing, non-executable, or invalid: %s\n' "$resolver" >&2
    failure=1
  fi

  if [ -f "$vocabulary_file" ] && [ -r "$vocabulary_file" ] \
    && [ "$(stat -c %a "$vocabulary_file" 2>/dev/null || true)" = "600" ] \
    && python3 -c 'import json,sys; value=json.load(open(sys.argv[1], encoding="utf-8")); assert value.get("version") == 1 and isinstance(value.get("entries"), list)' "$vocabulary_file"; then
    printf 'ok   private STT vocabulary: %s\n' "$vocabulary_file"
  else
    printf 'FAIL private STT vocabulary must be valid JSON with mode 0600: %s\n' "$vocabulary_file" >&2
    failure=1
  fi

  if [ -f "$vocabulary_server" ]; then
    printf 'ok   voice-vocabulary MCP server: %s\n' "$vocabulary_server"
  else
    printf 'FAIL voice-vocabulary MCP server is not built: %s\n' "$vocabulary_server" >&2
    failure=1
  fi

  if [ -f "$parakeet_log" ] && [ -w "$parakeet_log" ] \
    && [ "$(stat -c %a "$parakeet_log" 2>/dev/null || true)" = "600" ]; then
    printf 'ok   Parakeet private log: %s\n' "$parakeet_log"
  else
    printf 'FAIL Parakeet private log must exist, be writable, and have mode 0600: %s\n' "$parakeet_log" >&2
    failure=1
  fi

  if [ -x "$installer" ] && "$installer" --verify-only; then
    :
  else
    failure=1
  fi

  if command -v hermes >/dev/null 2>&1; then
    selected_provider="$(hermes config get stt.provider 2>/dev/null || true)"
    if [ "$selected_provider" = "parakeet" ]; then
      printf 'ok   selected STT provider: parakeet\n'
    else
      printf 'FAIL selected STT provider: expected parakeet, got %s\n' "${selected_provider:-unset}" >&2
      failure=1
    fi

    provider_type="$(hermes config get stt.providers.parakeet.type 2>/dev/null || true)"
    if [ "$provider_type" = "command" ]; then
      printf 'ok   Parakeet Hermes provider: command\n'
    else
      printf 'FAIL Parakeet Hermes command provider is not configured\n' >&2
      failure=1
    fi

    provider_command="$(hermes config get stt.providers.parakeet.command 2>/dev/null || true)"
    expected_command="$adapter {input_path} {output_path}"
    if [ "$provider_command" = "$expected_command" ]; then
      printf 'ok   Parakeet provider adapter path and placeholders\n'
    else
      printf 'FAIL Parakeet provider command does not match the repository adapter\n' >&2
      failure=1
    fi

    provider_format="$(hermes config get stt.providers.parakeet.format 2>/dev/null || true)"
    provider_timeout="$(hermes config get stt.providers.parakeet.timeout 2>/dev/null || true)"
    if [ "$provider_format" = "txt" ] && [ "$provider_timeout" = "180" ]; then
      printf 'ok   Parakeet provider output: txt, timeout: 180 seconds\n'
    else
      printf 'FAIL Parakeet provider requires txt output and a 180-second timeout\n' >&2
      failure=1
    fi

    vocabulary_command="$(hermes config get mcp_servers.voice_vocabulary.command 2>/dev/null || true)"
    vocabulary_arg="$(hermes config get mcp_servers.voice_vocabulary.args.0 2>/dev/null || true)"
    if [ "$vocabulary_command" = "node" ] && [ "$vocabulary_arg" = "$vocabulary_server" ]; then
      printf 'ok   voice-vocabulary MCP tool configured\n'
    else
      printf 'FAIL voice-vocabulary MCP tool is not configured with the repository server\n' >&2
      failure=1
    fi
  fi
}

check_command hermes
check_command git
check_command docker
check_command curl
check_command ffmpeg
check_command ffprobe
check_command flock
check_command iconv
check_command python3
check_command node
check_command sha256sum
check_command tar

check_env_value OPENROUTER_API_KEY
check_env_value TELEGRAM_BOT_TOKEN
check_env_value TELEGRAM_ALLOW_ALL_USERS
check_env_value TELEGRAM_ALLOWED_USERS
check_env_value CAFE_API_TOKEN
check_env_value CAFE_TOOL_ROUTER_CLI
if grep -Eq '^TELEGRAM_ALLOW_ALL_USERS=false$' "${HERMES_HOME:-$HOME/.hermes}/.env"; then
  printf 'ok   Telegram public access disabled\n'
else
  printf 'FAIL TELEGRAM_ALLOW_ALL_USERS must be false\n' >&2
  failure=1
fi
check_qwen_budget_policy
check_model_failover_policy
check_cafe_mcp_policy
check_parakeet_stt

if command -v hermes >/dev/null 2>&1; then
  hermes config check || failure=1
  hermes doctor || true
fi

if [ "$failure" -ne 0 ]; then
  printf '%s\n' 'Hermes is not ready to start; resolve the MISS/FAIL items above.' >&2
  exit 1
fi

printf '%s\n' 'Hermes is ready for gateway installation.'
