#!/usr/bin/env bash
# PHYSIOS shutdown. Stops the PHYSIOS gateway and the training service if PHYSIOS started it.
# Training runs keep going (they are separate processes; the training service picks them up
# again on its next start). A running host rollout is told to stop first.
#
#   ./stop_physios.sh            stop gateway (+ trainer started by start_physios.sh)
#   ./stop_physios.sh --keep-trainer
#   ./stop_physios.sh --robot    also stop the PHYSIOS robot runtime container
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${PHYSIOS_CONFIG:-$HERE/configuration/physios.env}"
[[ -f "$CONFIG" ]] && { set -a; # shellcheck disable=SC1090
  source "$CONFIG"; set +a; }
VAR="${PHYSIOS_VAR_DIR:-$HERE/var}"
TRAINER_URL="${PHYSIOS_TRAINER_URL:-http://127.0.0.1:8766}"
KEEP_TRAINER=0; ROS=0
for a in "$@"; do
  case "$a" in --keep-trainer) KEEP_TRAINER=1 ;; --robot|--ros) ROS=1 ;; -h|--help) sed -n '2,9p' "$0"; exit 0 ;; esac
done
PY="${PHYSIOS_PYTHON:-python3}"

stop_pid() { # name pidfile
  local f="$2"
  if [[ -f "$f" ]] && kill -0 "$(cat "$f")" 2>/dev/null; then
    kill -TERM "$(cat "$f")"
    for _ in $(seq 1 20); do kill -0 "$(cat "$f")" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$(cat "$f")" 2>/dev/null && kill -KILL "$(cat "$f")"
    echo "  ✓ $1 stopped"
  else
    echo "  - $1 was not started by RawBot Studio (or is already stopped)"
  fi
  rm -f "$f"
}

# a host rollout must not be left running without its operator page
"$PY" - "$TRAINER_URL" <<'EOF' 2>/dev/null
import json, sys, urllib.request
base = sys.argv[1] + '/api/rollouts'
try:
    a = json.load(urllib.request.urlopen(base, timeout=2)).get('active')
    if a:
        r = urllib.request.Request('%s/%s/command' % (base, a['id']), data=b'{"command": "stop"}',
                                   headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(r, timeout=5)
        print('  ✓ active rollout %s told to stop' % a['id'])
except Exception:
    pass
EOF

stop_pid "RawBot Studio gateway" "$VAR/run/gateway.pid"
if [[ $KEEP_TRAINER == 0 ]]; then stop_pid "training service" "$VAR/run/trainer.pid"; fi
if [[ $ROS == 1 ]] && command -v docker >/dev/null; then
  "$HERE/docker/physios-docker.sh" robot-down >/dev/null 2>&1 && echo "  ✓ robot runtime stopped"
fi
echo "RawBot Studio stopped."
