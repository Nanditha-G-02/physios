#!/usr/bin/env bash
# PHYSIOS start-up. Starts the PHYSIOS gateway (which serves the PHYSIOS frontend) and, when it
# is not running yet, the host training service. Checks every dependency and prints the URL
# and service health. It NEVER starts robot motion, recording or a rollout.
#
#   ./start_physios.sh              start (build the frontend first if it was never built)
#   ./start_physios.sh --build      rebuild the frontend, then start
#   ./start_physios.sh --with-ros   also start the Zenoh router and the physical_ai_server
#                                   bringup inside the physical_ai_server container, if they
#                                   are not running
#   ./start_physios.sh --no-trainer do not start the training service
#   ./start_physios.sh --foreground run the gateway in this terminal (Ctrl+C stops it)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
BUILD=0; WITH_ROS=0; TRAINER=1; FG=0
for a in "$@"; do
  case "$a" in
    --build) BUILD=1 ;;
    --with-ros) WITH_ROS=1 ;;
    --no-trainer) TRAINER=0 ;;
    --foreground) FG=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $a (see --help)"; exit 2 ;;
  esac
done

c_ok=$'\e[32m'; c_warn=$'\e[33m'; c_err=$'\e[31m'; c_dim=$'\e[2m'; c_off=$'\e[0m'
say()  { printf '%s[physios]%s %s\n' "$c_dim" "$c_off" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$c_ok" "$c_off" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_warn" "$c_off" "$*"; }
fail() { printf '  %s✗%s %s\n' "$c_err" "$c_off" "$*"; exit 1; }

# ---- 1. configuration ------------------------------------------------------------------
CONFIG="${PHYSIOS_CONFIG:-$HERE/configuration/physios.env}"
if [[ -f "$CONFIG" ]]; then
  set -a; # shellcheck disable=SC1090
  source "$CONFIG"; set +a
  say "configuration: $CONFIG"
else
  say "configuration: defaults (copy configuration/physios.env.example to physios.env to change them)"
fi
export PHYSIOS_REPO_ROOT="${PHYSIOS_REPO_ROOT:-$REPO}"
HOST="${PHYSIOS_HOST:-127.0.0.1}"; PORT="${PHYSIOS_PORT:-8700}"
TRAINER_URL="${PHYSIOS_TRAINER_URL:-http://127.0.0.1:8766}"
ROSBRIDGE_URL="${PHYSIOS_ROSBRIDGE_URL:-ws://127.0.0.1:9090}"
VAR="${PHYSIOS_VAR_DIR:-$HERE/var}"
mkdir -p "$VAR/run" "$VAR/log"

# ---- 2. dependencies ---------------------------------------------------------------------
say "checking dependencies"
PY="${PHYSIOS_PYTHON:-$(command -v python3 || true)}"
[[ -n "$PY" ]] || fail "python3 not found"
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || fail "Python 3.9+ needed ($("$PY" -V))"
ok "$("$PY" -V) ($PY)"
DIST="${PHYSIOS_FRONTEND_DIST:-$HERE/frontend/dist}"
if [[ $BUILD == 1 || ! -f "$DIST/index.html" ]]; then
  command -v npm >/dev/null || fail "the frontend is not built and npm is missing (install Node.js 18+, or copy a built frontend/dist)"
  say "building the frontend (npm ci && npm run build)"
  ( cd "$HERE/frontend" && { [[ -d node_modules ]] || npm ci --no-audit --no-fund; } && npm run build ) >"$VAR/log/build.log" 2>&1 \
    || fail "frontend build failed, see $VAR/log/build.log"
  ok "frontend built"
else
  ok "frontend: $DIST"
fi
( cd "$HERE/backend" && "$PY" -m physios_gateway --check-config >"$VAR/log/config.json" ) \
  || { cat "$VAR/log/config.json"; fail "configuration invalid (see problems above)"; }
ok "configuration valid"

http_ok() { "$PY" - "$1" <<'EOF' 2>/dev/null
import sys, urllib.request
try:
    urllib.request.urlopen(sys.argv[1], timeout=2).read(); sys.exit(0)
except Exception:
    sys.exit(1)
EOF
}
port_open() { "$PY" -c "import socket,sys; s=socket.socket(); s.settimeout(1); sys.exit(0 if s.connect_ex(('$1',$2))==0 else 1)"; }
alive() { [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }

# ---- 3. training service ---------------------------------------------------------------------
say "training service ($TRAINER_URL)"
if http_ok "$TRAINER_URL/api/health"; then
  ok "already running"
elif [[ $TRAINER == 1 ]]; then
  ( cd "$REPO/physical_ai_trainer" && { nohup "$PY" -m pam_trainer >>"$VAR/log/trainer.log" 2>&1 </dev/null & echo $! >"$VAR/run/trainer.pid"; } )
  for _ in $(seq 1 40); do http_ok "$TRAINER_URL/api/health" && break; sleep 0.25; done
  http_ok "$TRAINER_URL/api/health" && ok "started (pid $(cat "$VAR/run/trainer.pid"), log $VAR/log/trainer.log)" \
    || warn "did not answer; training, optimisation and robot management will show as disconnected (see $VAR/log/trainer.log)"
else
  warn "not running (--no-trainer)"
fi

# ---- 4. ROS 2 side ----------------------------------------------------------------------------
RB_HOST="$(echo "$ROSBRIDGE_URL" | sed -E 's#ws://([^:/]+).*#\1#')"; RB_PORT="$(echo "$ROSBRIDGE_URL" | sed -E 's#.*:([0-9]+).*#\1#')"
say "ROS 2 side (rosbridge $ROSBRIDGE_URL)"
if [[ $WITH_ROS == 1 ]]; then
  if command -v docker >/dev/null && docker ps --format '{{.Names}}' | grep -qx physical_ai_server; then
    if ! docker exec physical_ai_server pgrep -f rmw_zenohd >/dev/null 2>&1; then
      docker exec -d physical_ai_server bash -ic 'ros2 run rmw_zenoh_cpp rmw_zenohd' && ok "Zenoh router started in physical_ai_server"
      sleep 2
    else ok "Zenoh router already running"; fi
    if ! port_open "$RB_HOST" "$RB_PORT"; then
      docker exec -d physical_ai_server bash -ic 'ros2 launch physical_ai_server physical_ai_server_bringup.launch.py' \
        && ok "physical_ai_server bringup started (no motion: it only serves services and topics)"
      for _ in $(seq 1 60); do port_open "$RB_HOST" "$RB_PORT" && break; sleep 0.5; done
    fi
  else
    warn "container physical_ai_server is not running; start it with docker compose in docker/"
  fi
fi
if port_open "$RB_HOST" "$RB_PORT"; then ok "rosbridge reachable"; else warn "rosbridge not reachable: planning, recording and datasets need it (use --with-ros, or start the bringup)"; fi

# ---- 5. gateway ------------------------------------------------------------------------------
say "PHYSIOS gateway (http://$HOST:$PORT)"
if alive "$VAR/run/gateway.pid"; then
  warn "already running (pid $(cat "$VAR/run/gateway.pid")); use ./stop_physios.sh first to restart"
elif port_open "$HOST" "$PORT"; then
  fail "port $PORT is used by another program (set PHYSIOS_PORT)"
elif [[ $FG == 1 ]]; then
  say "foreground mode, Ctrl+C stops PHYSIOS"
  cd "$HERE/backend" && exec "$PY" -m physios_gateway
else
  ( cd "$HERE/backend" && { nohup "$PY" -m physios_gateway >>"$VAR/log/gateway.out" 2>&1 </dev/null & echo $! >"$VAR/run/gateway.pid"; } )
  for _ in $(seq 1 40); do http_ok "http://$HOST:$PORT/api/v1/health" && break; sleep 0.25; done
  http_ok "http://$HOST:$PORT/api/v1/health" || fail "gateway did not start, see $VAR/log/gateway.out"
  ok "started (pid $(cat "$VAR/run/gateway.pid"), log $VAR/log/gateway.log)"
fi

# ---- 6. health report -----------------------------------------------------------------------
say "service health"
"$PY" - "http://$HOST:$PORT/api/v1/health?force=1" <<'EOF' || true
import json, sys, urllib.request
try:
    h = json.load(urllib.request.urlopen(sys.argv[1], timeout=15))
except Exception as e:
    print('  \033[31m✗\033[0m gateway not answering: %s' % e)
    sys.exit(1)
for k, s in h['services'].items():
    mark = '\033[32m✓\033[0m' if s['status'] == 'ok' else '\033[33m!\033[0m'
    print('  %s %-10s %s' % (mark, k, s.get('detail', '')))
    if s['status'] != 'ok' and s.get('hint'):
        print('               \033[2m%s\033[0m' % s['hint'])
EOF
echo
printf '  %sPHYSIOS is running:%s  http://%s:%s\n' "$c_ok" "$c_off" "$HOST" "$PORT"
echo   "  Stop with ./stop_physios.sh. Nothing moves the robot until you start it in the app."
