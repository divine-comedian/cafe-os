#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
supabase_env="$project_root/supabase/.env"

if [ "$#" -ne 1 ]; then
  printf 'Usage: %s operator@example.com\n' "$0" >&2
  exit 1
fi
if [ ! -f "$supabase_env" ]; then
  printf 'Supabase environment not found at %s\n' "$supabase_env" >&2
  exit 1
fi
command -v curl >/dev/null || { printf 'curl is required.\n' >&2; exit 1; }
command -v jq >/dev/null || { printf 'jq is required.\n' >&2; exit 1; }

email="$1"
if [[ ! "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  printf 'Enter a valid email address.\n' >&2
  exit 1
fi

read -r -s -p "Temporary password (12+ characters): " password
printf '\n'
read -r -s -p "Repeat password: " password_confirmation
printf '\n'
if [ "${#password}" -lt 12 ]; then
  printf 'Password must contain at least 12 characters.\n' >&2
  exit 1
fi
if [ "$password" != "$password_confirmation" ]; then
  printf 'Passwords do not match.\n' >&2
  exit 1
fi

read_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$supabase_env" | head -n 1
}

service_key="$(read_value SERVICE_ROLE_KEY)"
supabase_url="$(read_value SUPABASE_PUBLIC_URL)"
if [ -z "$service_key" ] || [ -z "$supabase_url" ]; then
  printf 'SERVICE_ROLE_KEY or SUPABASE_PUBLIC_URL is missing.\n' >&2
  exit 1
fi

response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT
payload="$(jq -cn --arg email "$email" --arg password "$password"   '{email: $email, password: $password, email_confirm: true}')"
http_code="$(
  printf '%s' "$payload" |
    curl --silent --show-error       --output "$response_file"       --write-out '%{http_code}'       --request POST       --header "apikey: $service_key"       --header "Authorization: Bearer $service_key"       --header 'Content-Type: application/json'       --data-binary @-       "$supabase_url/auth/v1/admin/users"
)"

unset password password_confirmation payload service_key
if [ "$http_code" != "200" ] && [ "$http_code" != "201" ]; then
  message="$(jq -r '.msg // .message // .error_description // "Supabase rejected the request."' "$response_file")"
  printf 'Could not create operator (HTTP %s): %s\n' "$http_code" "$message" >&2
  exit 1
fi

jq -r '"Created operator " + .email + " (" + .id + ")."' "$response_file"
