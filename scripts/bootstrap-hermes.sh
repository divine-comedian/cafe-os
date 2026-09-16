#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hermes_home="${HERMES_HOME:-$HOME/.hermes}"
hermes_cmd="$(command -v hermes || true)"

if [ -z "$hermes_cmd" ]; then
  curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
    | bash -s -- --skip-setup --skip-browser --skip-computer-use --non-interactive
  hermes_cmd="$hermes_home/hermes-agent/venv/bin/hermes"
fi

"$hermes_home/bin/uv" pip install \
  --python "$hermes_home/hermes-agent/venv/bin/python" \
  "python-telegram-bot[webhooks]==22.8" \
  "discord.py[voice]==2.7.1" \
  "brotlicffi==1.2.0.2" \
  "aiohttp==3.14.3" \
  "faster-whisper==1.2.1" \
  "sounddevice==0.5.5" \
  "numpy==2.4.3"

"$hermes_cmd" config set model.provider openrouter
"$hermes_cmd" config set model.default openrouter/auto
"$hermes_cmd" config set model.base_url https://openrouter.ai/api/v1
"$hermes_cmd" config set provider_routing.sort price
"$hermes_cmd" config set provider_routing.data_collection deny
"$hermes_cmd" config set provider_routing.require_parameters true
"$hermes_cmd" config set database.journal_mode delete

"$hermes_cmd" config set terminal.backend docker
"$hermes_cmd" config set terminal.cwd "$project_root"
"$hermes_cmd" config set terminal.home_mode profile
"$hermes_cmd" config set terminal.docker_mount_cwd_to_workspace true
"$hermes_cmd" config set terminal.docker_run_as_host_user true
"$hermes_cmd" config set terminal.docker_network false

"$hermes_cmd" config set timezone America/Mexico_City
"$hermes_cmd" config set group_sessions_per_user true
"$hermes_cmd" config set stt.enabled true
"$hermes_cmd" config set stt.provider local
"$hermes_cmd" config set stt.language ""
"$hermes_cmd" config set approvals.mode smart
"$hermes_cmd" config set gateway.systemd_watchdog_seconds 120
"$hermes_cmd" config set display.background_process_notifications concise

"$hermes_cmd" config set platform_toolsets.telegram \
  "[terminal,file,web,vision,skills,todo,memory,session_search,tts,cronjob,messaging]"
"$hermes_cmd" config set platform_toolsets.discord \
  "[terminal,file,web,vision,skills,todo,memory,session_search,tts,cronjob,messaging]"

"$hermes_cmd" config check

printf '%s\n' \
  'Hermes headless defaults are configured.' \
  'Next: add secrets with `hermes config set`, run scripts/validate-hermes.sh,' \
  'then install and start the gateway service.'
