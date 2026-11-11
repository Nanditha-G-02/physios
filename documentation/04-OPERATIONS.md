# PHYSIOS operations: install, configure, run, troubleshoot, test

## 1. Requirements

| | |
|---|---|
| Robot PC | Ubuntu with Docker, the `physical_ai_server` container (ROS 2 Jazzy, rmw_zenoh) as in `docker/docker-compose.yml` |
| Python | 3.9+ on the host (standard library only; any conda base env works) |
| Node.js | 18+ only to build the frontend once (`npm ci && npm run build`). The built `frontend/dist` can be copied instead. |
| Training | the operator's LeRobot conda environment, discovered by `pam_trainer` |

## 2. Install on the robot PC

The repository at `/home/ihub/lerobot/physical_ai_tools` is already at v4. PHYSIOS arrives as
one more folder, `physios/`, plus three lines in `.gitignore`. Nothing else in the repository
changes.

```bash
cd /home/ihub/lerobot/physical_ai_tools
git apply --check /path/to/physios.patch && git apply /path/to/physios.patch
# or unpack physios.zip so that physical_ai_tools/physios/ exists
cd physios
./start_physios.sh --build --with-ros
```

The first build downloads the npm packages (needs internet once) and writes `frontend/dist`.

If `physios_rename.patch` was applied earlier, undo it. PHYSIOS is the new application, and
the old UI keeps its own name:
`git apply -R /home/ihub/Nanditha/AI/physicalai/physios_rename.patch`.

## 3. Configuration

```bash
cp configuration/physios.env.example configuration/physios.env
```

| Variable | Default | |
|---|---|---|
| `PHYSIOS_HOST` / `PHYSIOS_PORT` | `127.0.0.1` / `8700` | non-loopback needs `PHYSIOS_ALLOW_REMOTE=1` |
| `PHYSIOS_TRAINER_URL` | `http://127.0.0.1:8766` | pam_trainer |
| `PHYSIOS_ROSBRIDGE_URL` | `ws://127.0.0.1:9090` | rosbridge of physical_ai_server |
| `PHYSIOS_CAMERA_URL` | `http://127.0.0.1:8080` | web_video_server |
| `PHYSIOS_DATASET_ROOTS` | `<repo>/docker/huggingface/lerobot:~/.cache/huggingface/lerobot` | `:`-separated |
| `PHYSIOS_VAR_DIR` | `physios/var` | logs, pid files, activity |
| `PHYSIOS_ROS_TIMEOUT_S` | `20` | ROS service timeout |
| `PHYSIOS_MAX_UPLOAD_MB` | `128` | robot model uploads |

`python3 -m physios_gateway --check-config` (in `backend/`) prints the effective values and
any problems.

## 4. Running

```bash
./start_physios.sh                # gateway (+ pam_trainer if not running); prints URL and health
./start_physios.sh --with-ros     # also Zenoh router + physical_ai_server bringup in the container
./start_physios.sh --foreground   # gateway in this terminal
./stop_physios.sh                 # stops gateway and the trainer it started; tells a host rollout to stop
./stop_physios.sh --ros           # also stops router and bringup inside the container
```

Logs are in `physios/var/log/`: `gateway.log` (requests and events), `gateway.out`,
`trainer.log` and `build.log`.

**Development:** change `frontend/src`, then `cd frontend && npm run build` (output
`frontend/dist`, which the gateway serves) and reload the browser.

**Run at login (optional):** a systemd user unit can call
`start_physios.sh --foreground` with `WorkingDirectory=…/physios`.

**The old Physical AI Manager:** the container on port 80 is independent. Keep it as a
fallback or stop it with `docker stop physical_ai_manager`. PHYSIOS does not use it, but it
shows the same interface.

## 4a. Running in Docker (optional)

The image contains the gateway and the built frontend (Python standard library only, on
`python:3.12-slim`; no pip packages). The robot side and the training service keep running where they run
today.

```bash
cd /home/ihub/lerobot/physical_ai_tools/physios/docker
./physios-docker.sh up        # builds the image the first time, then http://127.0.0.1:8700
./physios-docker.sh status    # container state + service health
./physios-docker.sh logs
./physios-docker.sh down
```

* Host networking, like the other physical_ai_tools containers, so 127.0.0.1:9090 / 8080 /
  8766 are reachable.
* The repository is mounted read-only at `/repo` (datasets under
  `docker/huggingface/lerobot` and `pam_trainer.environment`), and `~/.cache/huggingface/lerobot`
  read-only at `/data/hf-lerobot`. Activity and logs go to the `physios-var` volume.
* Settings come from `configuration/physios.env`, the same file the scripts use.
* It runs as uid/gid 1000 (`PHYSIOS_UID`, `PHYSIOS_GID` to change), with a health check on
  `/api/v1/auth/session`.
* Use either Docker or `start_physios.sh` for the gateway, not both on the same port.
  `start_physios.sh` still starts pam_trainer if needed; with Docker, start it yourself
  (`cd physical_ai_trainer && python3 -m pam_trainer`).
* GPU information comes from `nvidia-smi` through pam_trainer. Inside the container the
  gateway reports what pam_trainer reports.

## 4b. Operator sign-in (optional; required for network access)

```bash
# configuration/physios.env
PHYSIOS_AUTH_TOKEN=choose-a-long-random-token     # 12+ characters
# to serve other machines on a trusted network:
PHYSIOS_HOST=0.0.0.0
PHYSIOS_ALLOW_REMOTE=1
```

The browser then shows a sign-in screen. Sessions last 12 hours
(`PHYSIOS_AUTH_SESSION_H`). To sign out, call `POST /api/v1/auth/logout` or let the session
expire; a gateway restart signs everyone out. Scripts send
`Authorization: Bearer <token>`. After five wrong tokens from one address within a minute,
that address waits a minute. Without a token the gateway refuses to start on a non-loopback
address. Use HTTPS (a reverse proxy) if the network is not trusted.

## 5. Troubleshooting

| Symptom (PHYSIOS) | Cause | Fix |
|---|---|---|
| "Robot side (ROS 2) disconnected", rosbridge down | bringup not running | `./start_physios.sh --with-ros`, or in the container: `ros2 run rmw_zenoh_cpp rmw_zenohd` then `ros2 launch physical_ai_server physical_ai_server_bringup.launch.py` |
| rosbridge OK but ROS node "Service … does not exist" | no Zenoh router: nodes cannot see each other with rmw_zenoh | start the router **first**, then restart the bringup |
| "Training service disconnected" | pam_trainer not running | `./start_physios.sh` starts it; if port 8766 is taken, `ss -ltnp \| grep 8766`, then check with `curl 127.0.0.1:8766/api/health` |
| Cameras "No image … retrying" | web_video_server down or wrong topic | it starts with the bringup; select the robot type so the server loads camera topics |
| No robots in the Home robot card | robot side down | as above |
| Robot card Confirm disabled on Home | a task is running | stop the recording/inference first |
| Frontend page "gateway is running, frontend not built" | no `frontend/dist` | `./start_physios.sh --build` |
| "port 8700 is used by another program" | another process (or the Docker container) | `./physios-docker.sh down`, or `PHYSIOS_PORT=8710 ./start_physios.sh` |
| Sign-in screen, token unknown | `PHYSIOS_AUTH_TOKEN` is set | read it from `configuration/physios.env`; remove it to turn sign-in off (loopback only) |
| Host rollout load fails "No module named lerobot" | the run's environment lacks LeRobot | train/run in the LeRobot conda env |
| Recording start rejected | server message is shown as is; usually robot type not set or a task running | follow the message |

`curl -s 127.0.0.1:8700/api/v1/health | python3 -m json.tool` shows the same checks as the UI.

## 6. Tests

```bash
# gateway (22 tests, in-process fakes of rosbridge, trainer, camera; sign-in and same-origin paths)
cd physios/backend && python3 -m pytest -q tests

# production build (lint warnings fail the build)
cd physios/frontend && CI=true npm run build

# browser walk-throughs of the interface served by PHYSIOS, against stand-ins (no ROS / GPU)
cd physios/tests/e2e
python3 devstack.py /tmp/physios-dev             # terminal 1 (add --seed for the Optimize check)
cd ../../../physical_ai_manager/e2e
python3 run_e2e.py http://127.0.0.1:8700 /tmp/physios-shots    # 26 steps, whole workflow
python3 opt_ui_check.py http://127.0.0.1:8700 /tmp/opt-shots   # Optimize tab (needs --seed)

# sign-in walk-through against a gateway started with a token
PHYSIOS_PORT=8710 PHYSIOS_AUTH_TOKEN=lab-operator-2026 python3 -m physios_gateway   # in backend/
python3 auth_e2e.py http://127.0.0.1:8710 lab-operator-2026
```

The devstack runs the **real** PlanningService (behind a rosbridge stand-in that simulates the
recorder), the **real** pam_trainer (with a stub `lerobot-train`), and the **real** gateway.
The e2e also starts a simulated 3-DOF arm for the custom-robot hardware test. Needs
`pip install playwright websockets` and the existing back-end test fixtures.
