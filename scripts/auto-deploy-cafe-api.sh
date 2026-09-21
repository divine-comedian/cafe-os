#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$project_root/compose.cafe.yml"
state_file="$project_root/runtime/cafe-api-deployed-commit"
lock_file="$project_root/runtime/cafe-api-auto-deploy.lock"
primary_port="${CAFE_API_PRIMARY_PORT:-8100}"
mvp_port="${CAFE_API_MVP_PORT:-8101}"

mkdir -p "$project_root/runtime"
exec 9>"$lock_file"
if ! flock -n 9; then
  printf 'Cafe OS deployment is already running.\n'
  exit 0
fi

cd "$project_root"
git fetch --quiet origin main

local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse refs/remotes/origin/main)"

if [[ "$local_head" != "$remote_head" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    printf 'Refusing Cafe OS deployment: the working tree is not clean.\n' >&2
    exit 1
  fi
  if ! git merge-base --is-ancestor "$local_head" "$remote_head"; then
    printf 'Refusing Cafe OS deployment: local main has diverged from origin/main.\n' >&2
    exit 1
  fi
  git merge --ff-only "$remote_head"
fi

target_commit="$(git rev-parse HEAD)"
image="cafe-os-api:$target_commit"
deployed_commit=""
if [[ -f "$state_file" ]]; then
  deployed_commit="$(<"$state_file")"
fi

container_uses_image() {
  local container="$1"
  [[ "$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null || true)" == "$image" ]]
}

endpoint_is_healthy() {
  local port="$1"
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$port/healthz" >/dev/null
}

if [[ "$deployed_commit" == "$target_commit" ]] \
  && container_uses_image "del_rio-cafe-api-1" \
  && container_uses_image "cafe-frontend-mvp-cafe-api-1" \
  && endpoint_is_healthy "$primary_port" \
  && endpoint_is_healthy "$mvp_port"; then
  printf 'Cafe OS is already deployed at %s.\n' "${target_commit:0:7}"
  exit 0
fi

npm --prefix services/cafe-api test -- --run
docker build -f services/cafe-api/Dockerfile -t "$image" .

CAFE_API_IMAGE_TAG="$target_commit" CAFE_API_PORT="$primary_port" \
  docker compose -p del_rio -f "$compose_file" up -d --no-build cafe-api
CAFE_API_IMAGE_TAG="$target_commit" CAFE_API_PORT="$mvp_port" \
  docker compose -p cafe-frontend-mvp -f "$compose_file" up -d --no-build cafe-api

wait_for_health() {
  local port="$1"
  local attempt
  for attempt in {1..30}; do
    if endpoint_is_healthy "$port"; then
      return 0
    fi
    sleep 1
  done
  printf 'Cafe OS failed its health check on port %s.\n' "$port" >&2
  return 1
}

wait_for_health "$primary_port"
wait_for_health "$mvp_port"
printf '%s\n' "$target_commit" >"$state_file"
printf 'Deployed Cafe OS %s on ports %s and %s.\n' \
  "${target_commit:0:7}" "$primary_port" "$mvp_port"
