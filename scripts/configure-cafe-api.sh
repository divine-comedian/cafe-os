#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
supabase_env="$project_root/supabase/.env"
runtime_dir="$project_root/runtime"
api_env="$runtime_dir/cafe-api.env"

if [ ! -f "$supabase_env" ]; then
  printf 'Supabase environment not found at %s\n' "$supabase_env" >&2
  exit 1
fi

read_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$supabase_env" | head -n 1
}

service_key="$(read_value SERVICE_ROLE_KEY)"
if [ -z "$service_key" ]; then
  printf 'SERVICE_ROLE_KEY is missing from %s\n' "$supabase_env" >&2
  exit 1
fi

api_token=""
if [ -f "$api_env" ]; then
  api_token="$(sed -n 's/^CAFE_API_TOKEN=//p' "$api_env" | head -n 1)"
fi
if [ -z "$api_token" ]; then
  api_token="$(openssl rand -hex 32)"
fi

mkdir -p "$runtime_dir"
temp_env="$(mktemp "$runtime_dir/cafe-api.env.XXXXXX")"
chmod 600 "$temp_env"
{
  printf 'SUPABASE_URL=http://api-gw:8000\n'
  printf 'SUPABASE_SERVICE_ROLE_KEY=%s\n' "$service_key"
  printf 'CAFE_API_TOKEN=%s\n' "$api_token"
  printf 'PURCHASE_DOCUMENT_BUCKET=purchase-documents\n'
  printf 'PORT=8100\n'
  printf 'MAX_UPLOAD_BYTES=15728640\n'
} > "$temp_env"
mv "$temp_env" "$api_env"
chmod 600 "$api_env"

printf 'Cafe API environment configured at %s (credentials not displayed).\n' "$api_env"
