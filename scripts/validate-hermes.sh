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

check_command hermes
check_command git
check_command docker
check_command ffmpeg
check_command node

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

if command -v hermes >/dev/null 2>&1; then
  hermes config check || failure=1
  hermes doctor || true
fi

if [ "$failure" -ne 0 ]; then
  printf '%s\n' 'Hermes is not ready to start; resolve the MISS/FAIL items above.' >&2
  exit 1
fi

printf '%s\n' 'Hermes is ready for gateway installation.'
