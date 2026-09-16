#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$project_root/compose.cafe.yml"

case "${1:-}" in
  start)
    "$project_root/scripts/configure-cafe-api.sh"
    exec docker compose -f "$compose_file" up -d --build
    ;;
  stop)
    exec docker compose -f "$compose_file" down
    ;;
  restart)
    "$project_root/scripts/configure-cafe-api.sh"
    docker compose -f "$compose_file" down
    exec docker compose -f "$compose_file" up -d --build
    ;;
  status)
    exec docker compose -f "$compose_file" ps
    ;;
  logs)
    exec docker compose -f "$compose_file" logs --tail 200 -f cafe-api
    ;;
  *)
    printf 'Usage: %s {start|stop|restart|status|logs}\n' "$0" >&2
    exit 2
    ;;
esac
