#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
profile_name="${1:-cafe-eval}"
hermes_root="${HERMES_HOME:-$HOME/.hermes}"
profile_home="$hermes_root/profiles/$profile_name"
pending_state_dir="$profile_home/state/cafe-mcp"

if [ ! -d "$profile_home" ]; then
  hermes profile create "$profile_name" --clone --no-alias \
    --description "Isolated Cafe OS operations evaluation profile; no messaging channels or production data."
fi

install -m 600 "$project_root/config/hermes/SOUL.md" "$profile_home/SOUL.md"
install -d -m 700 "$pending_state_dir"
provider_policy_dir="$profile_home/plugins/model-providers/openrouter"
install -d -m 700 "$provider_policy_dir"
install -m 600 "$project_root/config/hermes/plugins/model-providers/openrouter/__init__.py" "$provider_policy_dir/__init__.py"
install -m 600 "$project_root/config/hermes/plugins/model-providers/openrouter/plugin.yaml" "$provider_policy_dir/plugin.yaml"
router_plugin_dir="$profile_home/plugins/cafe-tool-router"
install -d -m 700 "$router_plugin_dir"
install -m 600 "$project_root/config/hermes/plugins/cafe-tool-router/__init__.py" "$router_plugin_dir/__init__.py"
install -m 600 "$project_root/config/hermes/plugins/cafe-tool-router/plugin.yaml" "$router_plugin_dir/plugin.yaml"

mcp_config="$(node -e '
const root = process.argv[1];
const pendingState = process.argv[2];
const contextId = process.argv[3];
process.stdout.write(JSON.stringify({
  command: "node",
  args: [`${root}/services/cafe-mcp/dist/server.js`],
  env: {
    CAFE_API_URL: "${CAFE_EVAL_API_URL}",
    CAFE_API_TOKEN: "${CAFE_EVAL_API_TOKEN}",
    CAFE_MCP_UPLOAD_ROOTS: "${CAFE_EVAL_UPLOAD_ROOT}",
    CAFE_MCP_STATE_DIR: pendingState,
    CAFE_MCP_CONTEXT_ID: contextId
  },
  trust: "full",
  tools: { resources: false, prompts: false }
}));
' "$project_root" "$pending_state_dir" "$profile_name")"
trusted_dirs="$(node -e 'process.stdout.write(JSON.stringify([process.argv[1]]))' "$project_root")"

hermes -p "$profile_name" config set --force mcp_servers.cafe_os "$mcp_config"
hermes -p "$profile_name" config set skills.trusted_project_dirs "$trusted_dirs"
hermes -p "$profile_name" config set --force plugins.enabled '["cafe-tool-router"]'
hermes -p "$profile_name" config set --force plugins.entries.cafe-tool-router.granted_capabilities '["tools.override"]'
hermes -p "$profile_name" config set tools.tool_search.enabled off
hermes -p "$profile_name" config set --force agent.reasoning_effort medium
# Hermes adds one tool-free wrap-up call after exhaustion: 19 iterations + 1 grace call = 20 hops maximum.
hermes -p "$profile_name" config set agent.max_turns 19
hermes -p "$profile_name" config set --force agent.disabled_toolsets \
  '["web","browser","terminal","file","skills","todo","memory","session_search","code_execution","delegation","cronjob","tts","vision","image_gen","video_gen","computer_use","clarify","connections","homeassistant","kanban"]'
hermes -p "$profile_name" config set agent.budget_warning_ratio 0.8
hermes -p "$profile_name" config set agent.run_budget_seconds 90
hermes -p "$profile_name" config set model.max_tokens 16384
hermes -p "$profile_name" config set platforms.telegram.enabled false
hermes -p "$profile_name" config set platforms.discord.enabled false
hermes -p "$profile_name" config check

printf 'Hermes eval profile ready: %s\n' "$profile_name"
