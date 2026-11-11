#!/usr/bin/env bash
# PHYSIOS in Docker.
#   ./physios-docker.sh build     build the image (builds the frontend first if needed)
#   ./physios-docker.sh up        build if needed and start (http://127.0.0.1:8700)
#   ./physios-docker.sh down      stop and remove the container (data volume is kept)
#   ./physios-docker.sh logs      follow the gateway log
#   ./physios-docker.sh status    container state and the gateway's service health
# Starting PHYSIOS never moves the robot; robot motion always needs an operator action.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PHYSIOS="$(cd "$HERE/.." && pwd)"
DC=(docker compose -f "$HERE/docker-compose.yml")
PORT="${PHYSIOS_PORT:-8700}"
[[ -f "$PHYSIOS/configuration/physios.env" ]] && PORT="$(grep -E '^PHYSIOS_PORT=' "$PHYSIOS/configuration/physios.env" | tail -1 | cut -d= -f2 || echo 8700)"
PORT="${PORT:-8700}"

need_dist() {
  if [[ ! -f "$PHYSIOS/frontend/dist/index.html" ]]; then
    command -v npm >/dev/null || { echo "frontend/dist missing and npm not installed: use physios.zip (it ships the built frontend) or install Node.js 18+"; exit 1; }
    echo "[physios] building the frontend"; (cd "$PHYSIOS/frontend" && npm ci && npm run build)
  fi
}

case "${1:-}" in
  build) need_dist; "${DC[@]}" build ;;
  up) need_dist; "${DC[@]}" up -d --build
      for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/api/v1/auth/session" >/dev/null 2>&1 && break; sleep 1; done
      echo "[physios] open http://127.0.0.1:$PORT" ;;
  down) "${DC[@]}" down ;;
  logs) "${DC[@]}" logs -f ;;
  status) "${DC[@]}" ps; curl -fsS "http://127.0.0.1:$PORT/api/v1/health" | python3 -m json.tool 2>/dev/null || echo "(health needs the gateway running; with sign-in enabled use the browser)" ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
