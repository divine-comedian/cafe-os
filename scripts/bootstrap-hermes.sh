#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hermes_home="${HERMES_HOME:-$HOME/.hermes}"
hermes_cmd="$(command -v hermes || true)"
api_env="$project_root/runtime/cafe-api.env"

mkdir -p "$hermes_home"
install -m 600 "$project_root/config/hermes/SOUL.md" "$hermes_home/SOUL.md"
provider_policy_dir="$hermes_home/plugins/model-providers/openrouter"
install -d -m 700 "$provider_policy_dir"
install -m 600 "$project_root/config/hermes/plugins/model-providers/openrouter/__init__.py" "$provider_policy_dir/__init__.py"
install -m 600 "$project_root/config/hermes/plugins/model-providers/openrouter/plugin.yaml" "$provider_policy_dir/plugin.yaml"
router_plugin_dir="$hermes_home/plugins/cafe-tool-router"
install -d -m 700 "$router_plugin_dir"
install -m 600 "$project_root/config/hermes/plugins/cafe-tool-router/__init__.py" "$router_plugin_dir/__init__.py"
install -m 600 "$project_root/config/hermes/plugins/cafe-tool-router/plugin.yaml" "$router_plugin_dir/plugin.yaml"
install -d -m 700 "$hermes_home/state/cafe-mcp"

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
"$hermes_cmd" config set model.default qwen/qwen3.8-flash
"$hermes_cmd" config set model.base_url https://openrouter.ai/api/v1
"$hermes_cmd" config set model.max_tokens 16384
"$hermes_cmd" config set --force agent.reasoning_effort high
# Hermes adds one tool-free wrap-up call after exhaustion: 19 iterations + 1 grace call = 20 hops maximum.
"$hermes_cmd" config set agent.max_turns 19
"$hermes_cmd" config set --force agent.disabled_toolsets \
  '["web","browser","terminal","file","skills","todo","memory","session_search","code_execution","delegation","cronjob","tts","vision","image_gen","video_gen","computer_use","clarify","connections","homeassistant","kanban"]'
"$hermes_cmd" config set agent.budget_warning_ratio 0.8
"$hermes_cmd" config set provider_routing.sort price
"$hermes_cmd" config set provider_routing.data_collection deny
"$hermes_cmd" config set provider_routing.require_parameters true
"$hermes_cmd" config set --force plugins.enabled '["cafe-tool-router"]'
"$hermes_cmd" config set --force plugins.entries.cafe-tool-router.granted_capabilities '["tools.override"]'
"$hermes_cmd" config set tools.tool_search.enabled off
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
"$hermes_cmd" config set display.platforms.telegram.tool_progress '"off"'
"$hermes_cmd" config set display.platforms.telegram.show_reasoning false
"$hermes_cmd" config set display.platforms.telegram.interim_assistant_messages false
"$hermes_cmd" config set display.platforms.telegram.streaming false
"$hermes_cmd" config set display.tool_progress_command false

"$hermes_home/hermes-agent/venv/bin/python" -c \
  "from hermes_cli.config import save_env_value_secure; save_env_value_secure('TELEGRAM_ALLOW_ALL_USERS', 'false')"
"$hermes_cmd" config set platforms.telegram.enabled true
"$hermes_cmd" config set platforms.discord.enabled false
"$hermes_cmd" config set platforms.telegram.extra.allow_admin_from '["0"]'
"$hermes_cmd" config set platforms.telegram.extra.group_allow_admin_from '["0"]'
"$hermes_cmd" config set platforms.telegram.extra.user_allowed_commands \
  '["status","new","reset","usage","voice","stop"]'
"$hermes_cmd" config set platforms.telegram.extra.group_user_allowed_commands \
  '["status","new","reset","usage","voice","stop"]'
"$hermes_cmd" config set --force platform_toolsets.telegram '[]'

if [ -f "$api_env" ]; then
  "$hermes_home/hermes-agent/venv/bin/python" - "$api_env" "$project_root/services/cafe-mcp/dist/tool-router-cli.js" <<'PY'
from pathlib import Path
import sys

from hermes_cli.config import save_env_value_secure

values = {}
for line in Path(sys.argv[1]).read_text().splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        key, value = line.split("=", 1)
        values[key] = value
token = values.get("CAFE_API_TOKEN", "").strip()
if not token:
    raise SystemExit("CAFE_API_TOKEN is missing from the Cafe API runtime environment")
router_cli = Path(sys.argv[2]).resolve()
if not router_cli.is_file():
    raise SystemExit(f"Cafe tool router is not built at {router_cli}")
save_env_value_secure("CAFE_API_TOKEN", token)
save_env_value_secure("CAFE_TOOL_ROUTER_CLI", str(router_cli))
PY
  install -d -m 700 "$hermes_home/cache" "$hermes_home/state/cafe-mcp"
  mcp_config="$(node -e '
const root = process.argv[1];
const home = process.argv[2];
process.stdout.write(JSON.stringify({
  command: "node",
  args: [`${root}/services/cafe-mcp/dist/server.js`],
  env: {
    CAFE_API_URL: "http://127.0.0.1:8100",
    CAFE_API_TOKEN: "${CAFE_API_TOKEN}",
    CAFE_MCP_UPLOAD_ROOTS: `${home}/cache`,
    CAFE_MCP_STATE_DIR: `${home}/state/cafe-mcp`,
    CAFE_MCP_CONTEXT_ID: "cafe-operations"
  },
  trust: "full",
  tools: { resources: false, prompts: false }
}));
' "$project_root" "$hermes_home")"
  "$hermes_cmd" config set --force mcp_servers.cafe_os "$mcp_config"
else
  printf 'Cafe API environment not found at %s; Cafe MCP was not configured.\n' "$api_env" >&2
fi

"$hermes_cmd" config check

printf '%s\n' \
  'Hermes headless defaults are configured.' \
  'Next: add secrets with `hermes config set`, run scripts/validate-hermes.sh,' \
  'then install and start the gateway service.'
