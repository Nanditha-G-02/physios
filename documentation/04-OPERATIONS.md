# RawBot Studio operations: install, configure, run, update, troubleshoot, test

RawBot Studio 2.x is one self-contained repository, https://github.com/Nanditha-G-02/physios. These
steps need nothing else from GitHub. Docker images are built from this repository; the
base images and packages come from their public registries.

## 1. Requirements

| | Needed for |
|---|---|
| Ubuntu 22.04 or 24.04 | everything |
| Python 3.9+ on the host (standard library only; any conda base env works) | gateway, training service, scripts |
| Node.js 18+ and npm | building the frontend (`scripts/install.sh`) |
| Docker Engine with the compose plugin (v2.24+) | the robot runtime; the optional Docker deployment of the gateway |
| NVIDIA driver + NVIDIA container toolkit | on-robot inference on the GPU (used automatically when present) |
| A Python environment with LeRobot (e.g. your conda env) | training; discovered by the training service, never modified |
| Your arm's ROS 2 driver (robot bringup), on the same ROS domain | recording and inference on the real robot |

## 2. Install

```bash
git clone https://github.com/Nanditha-G-02/physios.git ~/physios
cd ~/physios
./scripts/install.sh
```

`install.sh`:
* checks the requirements;
* creates `configuration/physios.env` from the example (an existing one is kept);
* creates the data folder;
* builds the frontend into `frontend/dist`;
* validates the configuration.

It does not start anything. Options:

| Option | |
|---|---|
| `--robot` | build the robot runtime image `physios-robot:2.0.0` (ROS 2 Jazzy, LeRobot; ~20 GB disk, 20–40 min the first time) |
| `--docker` | build the gateway image `physios-gateway:2.0.0` |
| `--import-from DIR` | copy data from a PHYSIOS 1.x installation (section 7) |

## 3. Configuration

`configuration/physios.env` (from `physios.env.example`). Every value can also be set in the
environment. `cd backend && python3 -m physios_gateway --check-config` prints the effective
values and any problems.

| Variable | Default | |
|---|---|---|
| `PHYSIOS_HOST` / `PHYSIOS_PORT` | `127.0.0.1` / `8700` | non-loopback needs `PHYSIOS_ALLOW_REMOTE=1` and `PHYSIOS_AUTH_TOKEN` |
| `PHYSIOS_DATA_DIR` | `<physios>/data` | the data folder (section 3a) |
| `PHYSIOS_TRAINER_URL` | `http://127.0.0.1:8766` | training service |
| `PHYSIOS_ROSBRIDGE_URL` | `ws://127.0.0.1:9090` | rosbridge of the robot runtime |
| `PHYSIOS_CAMERA_URL` | `http://127.0.0.1:8080` | web_video_server of the robot runtime |
| `PHYSIOS_DATASET_ROOTS` | `$PHYSIOS_DATA_DIR/huggingface/lerobot:~/.cache/huggingface/lerobot` | `:`-separated, read by the gateway |
| `PHYSIOS_VAR_DIR` | `<physios>/var` | logs, pid files, activity |
| `PHYSIOS_AUTH_TOKEN`, `PHYSIOS_AUTH_SESSION_H` | off, `12` | operator sign-in (section 5) |
| `PHYSIOS_ROS_DOMAIN_ID` | `30` | ROS domain of the robot runtime; must match your arm's driver |
| `PHYSIOS_ROBOT_START_ZENOH` | `1` | the robot runtime starts the Zenoh router unless one is already listening on 7447; `0` to never start it |
| `PHYSIOS_ROBOT_GPU` | `auto` | `1`/`0` forces GPU access for the robot runtime |
| `PHYSIOS_ROBOT_BASE_IMAGE` | ROS 2 Jazzy + PyTorch 2.7 + CUDA 12.8 image | base of `docker/robot/Dockerfile`; with `ros:jazzy-ros-base` also set `PHYSIOS_ROBOT_INSTALL_TORCH=1` |
| `PHYSIOS_ROS_TIMEOUT_S`, `PHYSIOS_MAX_UPLOAD_MB` | `20`, `128` | |

### 3a. The data folder

All parts share one folder, `PHYSIOS_DATA_DIR`:

```
data/
├── huggingface/          LeRobot datasets (lerobot/<owner>/<name>) and downloaded models (hub/)
├── workspace/physios/    plans, recording progress, reviews, publish history, training runs,
│                         queue, optimisation sessions, evaluations, rollouts, robot library
├── workspace/rosbag2/    ROS bags written during recording
├── outputs/train/        checkpoints (host training and in-container training)
└── robot-config/         your own <robot>_config.yaml files for the robot server
```

| | sees `data/` as |
|---|---|
| gateway, training service (host) | `$PHYSIOS_DATA_DIR` |
| robot runtime container | `/physios/data`; `huggingface/` also at `/root/.cache/huggingface`, `workspace/` at `/workspace` |
| gateway container | `/physios/data`, read-only |

Back it up like any folder. It is not tracked by git, so `git pull` never touches it.

## 4. Running

### 4.1 Scripts (recommended on the robot PC)

```bash
./start_physios.sh                # training service + gateway; prints URL and service health
./start_physios.sh --with-robot   # also the robot runtime container (built on first use)
./start_physios.sh --build        # rebuild the frontend first
./start_physios.sh --foreground   # gateway in this terminal
./start_physios.sh --no-gateway   # training service only (gateway runs in Docker)
./stop_physios.sh                 # gateway + the training service it started; stops an active host rollout
./stop_physios.sh --robot         # also the robot runtime container
```

The robot runtime runs:
* the Zenoh router, unless one is already running;
* `physical_ai_server_bringup.launch.py`: robot server, rosbridge `:9090`, bag recorder and
  web_video_server `:8080`.

It serves services and topics and never moves the robot. Your arm's driver must run on the
same ROS domain (`PHYSIOS_ROS_DOMAIN_ID`, default 30) with `RMW_IMPLEMENTATION=rmw_zenoh_cpp`.

Logs are in `var/log/`:
* `gateway.log` (requests and events) and `gateway.out`;
* `trainer.log`, `robot-up.log` and `build.log`;
* the robot runtime's own log: `./docker/physios-docker.sh logs robot`.

**Run at login (optional):** a systemd user unit can run
`start_physios.sh --with-robot --foreground` with `WorkingDirectory=%h/physios`.

### 4.2 Docker

```bash
./docker/physios-docker.sh up                 # gateway container, http://127.0.0.1:8700
./docker/physios-docker.sh up --with-robot    # gateway + robot runtime containers
./start_physios.sh --no-gateway               # training service on the host
./docker/physios-docker.sh status | logs [gateway|robot] | shell | down
./docker/physios-docker.sh build [gateway|robot|all]
```

| Container | Image | Notes |
|---|---|---|
| `physios-gateway` | `docker/gateway/Dockerfile` (`python:3.12-slim`, stdlib only) | uid 1000; data folder read-only; health check on `/api/v1/auth/session` |
| `physios-robot` (compose profile `robot`) | `docker/robot/Dockerfile` | privileged for `/dev` (USB serial adapters, cameras), real-time limits, GPU when available (`docker-compose.gpu.yml`); `physios-docker.sh shell` opens a shell with ROS sourced |

* Both containers use host networking.
* `physios-docker.sh` reads `configuration/physios.env` first, like the scripts.
* Use either the gateway container or `start_physios.sh` for the gateway, not both on the
  same port.

### 4.3 Robot configurations

The robot server lists one robot type per `<robot>_config.yaml`. The built-in ones are in
`robot/src/physical_ai_server/config/`. To add yours, for example the file exported from
**Robots → Recording with physical_ai_server**:
1. Save it in `data/robot-config/`.
2. Restart the robot runtime: `./stop_physios.sh --robot && ./start_physios.sh --with-robot`.

It is installed at every container start and survives image rebuilds.

## 5. Operator sign-in (optional; required for network access)

```bash
# configuration/physios.env
PHYSIOS_AUTH_TOKEN=choose-a-long-random-token     # 12+ characters
# to serve other machines on a trusted network:
PHYSIOS_HOST=0.0.0.0
PHYSIOS_ALLOW_REMOTE=1
```

The browser then shows a sign-in screen.
* Sessions last 12 hours (`PHYSIOS_AUTH_SESSION_H`). A gateway restart signs everyone out.
* Scripts send `Authorization: Bearer <token>`.
* After five wrong tokens from one address within a minute, that address waits a minute.
* Use HTTPS (a reverse proxy) if the network is not trusted.

## 6. Updating

```bash
cd ~/physios
git pull
./scripts/install.sh                          # rebuilds the frontend
./docker/physios-docker.sh build all          # when docker/ or robot/ changed (see CHANGELOG)
./stop_physios.sh --robot && ./start_physios.sh --with-robot
```

## 7. Moving from PHYSIOS 1.x

PHYSIOS 1.x lived in `~/lerobot/physical_ai_tools/physios` and used the checkout's data
folders. To move:

1. Install 2.x as in section 2, in its own folder (for example `~/physios`).
2. Copy your data:
   ```bash
   python3 scripts/import-legacy-data.py ~/lerobot/physical_ai_tools --dry-run   # what would be copied
   python3 scripts/import-legacy-data.py ~/lerobot/physical_ai_tools
   ```

What the import copies:

| From the old checkout | To |
|---|---|
| `docker/huggingface/` | `data/huggingface/` |
| `docker/workspace/physical_ai_manager/` | `data/workspace/physios/` |
| `docker/workspace/rosbag2/` | `data/workspace/rosbag2/` |
| `lerobot/outputs/train/` | `data/outputs/train/` |
| robot configs in `physical_ai_server/config/` that RawBot Studio does not ship | `data/robot-config/` |

* On the same disk, files are hard-linked, so they take no extra space.
* Paths inside the copied run, plan and checkpoint records are updated.
* Nothing in the old checkout is changed.

3. Stop the old containers and services:
   ```bash
   cd ~/lerobot/physical_ai_tools/docker && docker compose down
   ~/lerobot/physical_ai_tools/physios/stop_physios.sh
   ```
   This stops `physical_ai_server` and `physical_ai_manager`, and 1.x's gateway and trainer.
   RawBot Studio 2.x uses the same ports (8700, 8766, 9090 and 8080).
4. Start 2.x: `./start_physios.sh --with-robot`. Check Home (robot types), Data (datasets)
   and Training → Runs.
5. The old checkout is no longer used. Keep it until you have checked everything, then
   delete it yourself if you want.

## 8. Troubleshooting

| Symptom (RawBot Studio) | Cause | Fix |
|---|---|---|
| "Robot side (ROS 2) disconnected", rosbridge down | robot runtime not running | `./start_physios.sh --with-robot`; see `./docker/physios-docker.sh logs robot` |
| rosbridge OK but ROS node "Service … does not exist" | no Zenoh router, or the arm's driver is on another ROS domain | one router per PC (`PHYSIOS_ROBOT_START_ZENOH`); same `ROS_DOMAIN_ID` everywhere |
| No robot types on Home, or yours is missing | robot runtime down, or the config is not installed | section 4.3 |
| "Training service disconnected" | training service not running | `./start_physios.sh` (or `--no-gateway` with Docker); `curl 127.0.0.1:8766/api/health`; log `var/log/trainer.log` |
| Cameras "No image … retrying" | web_video_server down or wrong topic | it runs in the robot runtime; select the robot type so the server loads camera topics |
| `physios-docker.sh build robot` fails pulling the base image | registry not reachable, or a different architecture | set `PHYSIOS_ROBOT_BASE_IMAGE` (with `PHYSIOS_ROBOT_INSTALL_TORCH=1` for `ros:jazzy-ros-base`) |
| robot runtime starts but cannot open the arm or cameras | device access | the container is privileged and mounts `/dev`; check that the device exists on the host (`ls /dev/ttyACM* /dev/video*`) |
| robot server dies at start-up with an `ImportError` about NumPy (`requires NumPy 2`) | a Python package in the robot image is newer than ROS 2 Jazzy's NumPy 1.x allows | add an upper limit for that package to `robot/constraints.txt`, then `./docker/physios-docker.sh build robot` (the build imports the robot server and stops if this happens) |
| GPU not used for inference | NVIDIA toolkit missing | install it; `PHYSIOS_ROBOT_GPU=1` to force |
| Frontend page "gateway is running, frontend not built" | no `frontend/dist` | `./scripts/install.sh` or `./start_physios.sh --build` |
| "port 8700 is used by another program" | another process, the gateway container, or PHYSIOS 1.x | `./docker/physios-docker.sh down`, stop 1.x, or `PHYSIOS_PORT=8710` |
| Sign-in screen, token unknown | `PHYSIOS_AUTH_TOKEN` is set | read it from `configuration/physios.env`; remove it to turn sign-in off (loopback only) |
| Host rollout load fails "No module named lerobot" | the run's environment lacks LeRobot | train and run in the LeRobot environment |
| Recording start rejected | the server's message is shown as is; usually robot type not set, or a task running | follow the message |

`curl -s 127.0.0.1:8700/api/v1/health | python3 -m json.tool` shows the same checks as the UI.

## 9. Tests

Everything runs from the repository itself, without ROS, a GPU or a robot:

```bash
cd backend
python3 -m pytest -q tests            # gateway: 22
python3 -m pytest -q trainer_tests    # training service + standalone layout: 102 (1 skipped)
cd ../robot/src/physical_ai_server
python3 -m pytest -q test/planning    # planning engine: 45
cd ../../../frontend && CI=true npm run build   # production build, lint warnings fail it

# browser walk-throughs against stand-ins (pip install playwright websockets)
python3 tests/e2e/devstack.py /tmp/physios-dev [--seed]                 # terminal 1
python3 tests/e2e/run_e2e.py http://127.0.0.1:8700 /tmp/physios-shots   # 26 steps
python3 tests/e2e/opt_ui_check.py http://127.0.0.1:8700                 # Optimize tab (needs --seed)
cd backend && PHYSIOS_PORT=8710 PHYSIOS_AUTH_TOKEN=lab-operator-2026 python3 -m physios_gateway &
python3 tests/e2e/auth_e2e.py http://127.0.0.1:8710 lab-operator-2026   # sign-in, 6 steps
```

The dev stack runs three real components and one stand-in:
* the **real** PlanningService from `robot/src`, behind a rosbridge stand-in that simulates
  the recorder;
* the **real** training service, with a stub `lerobot-train`;
* the **real** gateway.
