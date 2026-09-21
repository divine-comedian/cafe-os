#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
template_root="$project_root/deploy/systemd"
unit_root="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
temp_file="$(mktemp)"
trap 'rm -f "$temp_file"' EXIT

mkdir -p "$unit_root"

render_unit() {
  local source="$1"
  local destination="$2"
  local content
  content="$(<"$source")"
  content="${content//@PROJECT_ROOT@/$project_root}"
  printf '%s\n' "$content" >"$temp_file"
  install -m 0644 "$temp_file" "$unit_root/$destination"
}

render_unit "$template_root/cafe-os-auto-deploy.service.in" "cafe-os-auto-deploy.service"
render_unit "$template_root/cafe-os-auto-deploy.timer" "cafe-os-auto-deploy.timer"

systemctl --user daemon-reload
systemctl --user enable --now cafe-os-auto-deploy.timer
systemctl --user start cafe-os-auto-deploy.service
systemctl --user --no-pager status cafe-os-auto-deploy.timer
