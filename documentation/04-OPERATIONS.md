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

**Development:** run `./start_physios.sh`, then `cd frontend && npm run dev`. Open
http://localhost:5173: Vite serves the UI with hot reload and forwards `/api` and `/ros` to the
gateway.

**Run at login (optional):** a systemd user unit can call
`start_physios.sh --foreground` with `WorkingDirectory=…/physios`.

**The old Physical AI Manager:** the container on port 80 is independent. Keep it as a
fallback or stop it with `docker stop physical_ai_manager`. PHYSIOS does not use it.

## 5. Troubleshooting

| Symptom (PHYSIOS) | Cause | Fix |
|---|---|---|
| "Robot side (ROS 2) disconnected", rosbridge down | bringup not running | `./start_physios.sh --with-ros`, or in the container: `ros2 run rmw_zenoh_cpp rmw_zenohd` then `ros2 launch physical_ai_server physical_ai_server_bringup.launch.py` |
| rosbridge OK but ROS node "Service … does not exist" | no Zenoh router: nodes cannot see each other with rmw_zenoh | start the router **first**, then restart the bringup |
| "Training service disconnected" | pam_trainer not running | `./start_physios.sh` starts it; if port 8766 is taken, `ss -ltnp \| grep 8766`, then check with `curl 127.0.0.1:8766/api/health` |
| Cameras "No image … retrying" | web_video_server down or wrong topic | it starts with the bringup; select the robot type so the server loads camera topics |
| No robots in the Home robot card | robot side down | as above |
| Header robot select disabled | a task is running | stop the recording/inference first |
| Frontend page "gateway is running, frontend not built" | no `frontend/dist` | `./start_physios.sh --build` |
| "port 8700 is used by another program" | another process | `PHYSIOS_PORT=8710 ./start_physios.sh` |
| Host rollout load fails "No module named lerobot" | the run's environment lacks LeRobot | train/run in the LeRobot conda env |
| Recording start rejected | server message is shown as is; usually robot type not set or a task running | follow the message |

`curl -s 127.0.0.1:8700/api/v1/health | python3 -m json.tool` shows the same checks as the UI.

## 6. Tests

```bash
# gateway (17 tests, in-process fakes of rosbridge, trainer, camera)
cd physios/backend && python3 -m pytest -q tests

# frontend unit tests (hardware-test sequencer against a simulated servo, router, URDF, format)
cd physios/frontend && npm test

# type check + production build
cd physios/frontend && npm run build

# full browser walk-through of every module against stand-ins (no ROS / GPU needed)
cd physios/tests/e2e
python3 devstack.py /tmp/physios-dev --seed      # terminal 1
python3 physios_e2e.py /tmp/physios-dev /tmp/physios-shots
```

The devstack runs the **real** PlanningService (behind a rosbridge stand-in that simulates the
recorder), the **real** pam_trainer (with a stub `lerobot-train`), and the **real** gateway.
The e2e also starts a simulated 3-DOF arm for the custom-robot hardware test. Needs
`pip install playwright websockets` and the existing back-end test fixtures.
