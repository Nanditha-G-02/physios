#!/usr/bin/env bash
# PHYSIOS in Docker.
#   ./physios-docker.sh build [gateway|robot|all]   build images (default: gateway)
#   ./physios-docker.sh up [--with-robot]           start (http://127.0.0.1:8700)
#   ./physios-docker.sh robot-up | robot-down       start/stop only the robot runtime
#   ./physios-docker.sh down                        stop and remove the containers (data kept)
#   ./physios-docker.sh logs [gateway|robot]        follow a log
#   ./physios-docker.sh shell                       shell in the robot runtime (ROS sourced)
#   ./physios-docker.sh status                      containers and the gateway's service health
# Starting PHYSIOS never moves the robot; robot motion always needs an operator action.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PHYSIOS="$(cd "$HERE/.." && pwd)"
CONFIG="${PHYSIOS_CONFIG:-$PHYSIOS/configuration/physios.env}"
if [[ -f "$CONFIG" ]]; then set -a; # shellcheck disable=SC1090
  source "$CONFIG"; set +a; fi
export PHYSIOS_DATA_DIR="${PHYSIOS_DATA_DIR:-$PHYSIOS/data}"
mkdir -p "$PHYSIOS_DATA_DIR"/{huggingface/lerobot,workspace/physios,outputs/train,robot-config}
mkdir -p "${HOME:-/root}/.cache/huggingface/lerobot"
PORT="${PHYSIOS_PORT:-8700}"

FILES=(-f "$HERE/docker-compose.yml")
if [[ "${PHYSIOS_ROBOT_GPU:-auto}" == 1 ]] || { [[ "${PHYSIOS_ROBOT_GPU:-auto}" == auto ]] \
    && command -v nvidia-smi >/dev/null && docker info 2>/dev/null | grep -qi 'runtimes:.*nvidia'; }; then
  FILES+=(-f "$HERE/docker-compose.gpu.yml")
fi
DC=(docker compose "${FILES[@]}")

need_dist() {
  if [[ ! -f "$PHYSIOS/frontend/dist/index.html" ]]; then
    command -v npm >/dev/null || { echo "frontend/dist missing and npm not installed: install Node.js 18+ (see README)"; exit 1; }
    echo "[physios] building the frontend"; (cd "$PHYSIOS/frontend" && npm ci && npm run build)
  fi
}
wait_gateway() {
  for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/api/v1/auth/session" >/dev/null 2>&1 && break; sleep 1; done
  echo "[physios] open http://127.0.0.1:$PORT"
}

case "${1:-}" in
  build)
    case "${2:-gateway}" in
      gateway) need_dist; "${DC[@]}" build physios-gateway ;;
      robot) "${DC[@]}" --profile robot build physios-robot ;;
      all) need_dist; "${DC[@]}" --profile robot build ;;
      *) echo "build what? gateway | robot | all"; exit 2 ;;
    esac ;;
  up)
    need_dist
    if [[ "${2:-}" == --with-robot ]]; then "${DC[@]}" --profile robot up -d --build
    else "${DC[@]}" up -d --build physios-gateway; fi
    wait_gateway ;;
  robot-up) "${DC[@]}" --profile robot up -d physios-robot ;;
  robot-down) "${DC[@]}" --profile robot stop physios-robot ;;
  down) "${DC[@]}" --profile robot down ;;
  logs) "${DC[@]}" --profile robot logs -f "physios-${2:-gateway}" ;;
  shell) docker exec -it physios-robot physios-robot shell ;;
  status) "${DC[@]}" --profile robot ps
          curl -fsS "http://127.0.0.1:$PORT/api/v1/health" | python3 -m json.tool 2>/dev/null \
            || echo "(health needs the gateway running; with sign-in enabled use the browser)" ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
