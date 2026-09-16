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

check_secret() {
  variable="$1"
  env_file="${HERMES_HOME:-$HOME/.hermes}/.env"
  if [ -f "$env_file" ] && grep -Eq "^${variable}=.+" "$env_file"; then
    printf 'ok   secret configured: %s\n' "$variable"
  else
    printf 'MISS secret not configured: %s\n' "$variable"
    failure=1
  fi
}

check_command hermes
check_command git
check_command docker
check_command ffmpeg

check_secret OPENROUTER_API_KEY
check_secret TELEGRAM_BOT_TOKEN
check_secret TELEGRAM_ALLOWED_USERS
check_secret DISCORD_BOT_TOKEN
check_secret DISCORD_ALLOWED_USERS

if command -v hermes >/dev/null 2>&1; then
  hermes config check || failure=1
  hermes doctor || true
fi

if [ "$failure" -ne 0 ]; then
  printf '%s\n' 'Hermes is not ready to start; resolve the MISS/FAIL items above.' >&2
  exit 1
fi

printf '%s\n' 'Hermes is ready for gateway installation.'
