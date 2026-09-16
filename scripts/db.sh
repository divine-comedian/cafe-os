#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
supabase_dir="${SUPABASE_DIR:-$project_root/supabase}"

if [ ! -f "$supabase_dir/docker-compose.yml" ] || [ ! -f "$supabase_dir/.env" ]; then
  printf 'Supabase deployment not found at %s\n' "$supabase_dir" >&2
  exit 1
fi

compose_tty=()
if [ ! -t 0 ]; then
  compose_tty=(-T)
fi

cd "$supabase_dir"
exec docker compose exec "${compose_tty[@]}" db \
  psql -X -U postgres -d "${PGDATABASE:-postgres}" "$@"
