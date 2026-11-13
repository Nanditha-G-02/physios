# RawBot Studio: The Operating System for Physical Intelligence

Version 2.0.0 · see `CHANGELOG.md` · https://github.com/Nanditha-G-02/physios

RawBot Studio was called **PHYSIOS** until 13 November 2026. Commands, folders, Docker
containers and settings keep the `physios` names (`./start_physios.sh`, `PHYSIOS_*`), so
existing installations keep working unchanged.

RawBot Studio is a standalone application for the whole imitation-learning loop on a real robot:
* plan demonstrations and record them;
* curate the dataset;
* train and optimise a policy on this PC, then evaluate it;
* run it on the robot under supervision.

**RawBot Studio is one self-contained repository.** It has its own frontend, gateway, training
service, robot runtime, configuration, data folder, Docker images and scripts. It installs,
runs and updates from this repository alone. It does **not** need a ROBOTIS
`physical_ai_tools` checkout, the `physical_ai_server` / `physical_ai_trainer` folders of one,
or the `physical_ai_manager` container.

## What is in the repository

| Part | Folder | Runs as |
|---|---|---|
| Frontend (React 19, Redux, Tailwind) | `frontend/` | built to `frontend/dist`, served by the gateway |
| Gateway: API, same-origin paths, sign-in, health | `backend/physios_gateway/` | host process or `physios-gateway` container, `:8700` |
| Training service: training, optimisation, evaluation, host rollout, custom robots | `backend/physios_trainer/` | host process, `127.0.0.1:8766` (uses your LeRobot Python environment and GPU) |
| Robot runtime (ROS 2 Jazzy): robot server with planning engine, recording, inference; rosbridge; camera streams | `robot/src/` | `physios-robot` container (`docker/robot/Dockerfile`) |
| Configuration | `configuration/physios.env` | read by every part |
| Data: datasets, plans, reviews, runs, checkpoints, extra robot configs | `data/` (or `PHYSIOS_DATA_DIR`) | shared by every part |
| Deployment | `scripts/`, `start_physios.sh`, `stop_physios.sh`, `docker/` | |

```
Browser ── RawBot Studio frontend (served by the gateway)
             │ /api/v1, /train-api, /camera-stream, /lerobot-data       │ /ros (WebSocket)
             ▼                                                          ▼
        RawBot Studio gateway  (backend/physios_gateway, 127.0.0.1:8700)
          ├─ trainer proxy ──► RawBot Studio training service (backend/physios_trainer, :8766, host)
          ├─ rosbridge ──────► RawBot Studio robot runtime (robot/, physios-robot container)
          │                      physical_ai_server node · planning engine · bag recorder
          ├─ camera proxy ───► web_video_server (:8080, in the robot runtime)
          └─ dataset files ──► data/huggingface/lerobot (read-only)
                                         │
                      robot runtime ◄── ROS 2 (rmw_zenoh) ──► your arm's ROS 2 driver
```

The arm's own ROS 2 driver is not part of RawBot Studio, as in 1.x. That driver is the robot
bringup that publishes joint states and camera topics and accepts commands. RawBot Studio's robot
runtime talks to it over ROS 2.

## Install

Requirements:
* Ubuntu 22.04/24.04;
* Python 3.9+, standard library only;
* Node.js 18+, to build the frontend;
* Docker with the compose plugin, for the robot runtime and the Docker deployment;
* the NVIDIA container toolkit, for on-robot inference on the GPU;
* for training, a Python environment with LeRobot (for example your conda env), which the
  training service discovers by itself.

```bash
git clone https://github.com/Nanditha-G-02/physios.git ~/physios
cd ~/physios
./scripts/install.sh            # checks requirements, creates configuration/physios.env and data/,
                                # builds the frontend
./scripts/install.sh --robot    # once: build the robot runtime image (ROS 2 + LeRobot, ~20-40 min)
```

**Moving from PHYSIOS 1.x** (inside `~/lerobot/physical_ai_tools`)? Copy your datasets, plans,
runs, checkpoints and robot configs into the new data folder. The old checkout is not changed:

```bash
./scripts/install.sh --import-from ~/lerobot/physical_ai_tools
```

## Run

```bash
./start_physios.sh --with-robot   # robot runtime container + training service + gateway
# open http://127.0.0.1:8700
./stop_physios.sh --robot         # stop everything RawBot Studio started
```

* `./start_physios.sh` starts the training service and the gateway only. Use it for planning
  data, training and evaluation without the robot.
* `--with-robot` starts the `physios-robot` container: Zenoh router, robot server, rosbridge,
  bag recorder and web_video_server. It never moves the robot.

Or everything in Docker (the training service stays a host process because it needs your
LeRobot environment and GPU):

```bash
./docker/physios-docker.sh up --with-robot     # gateway + robot runtime containers
./start_physios.sh --no-gateway                # training service on the host
```

See `documentation/04-OPERATIONS.md` for configuration, updating, troubleshooting and tests.

## Update

```bash
cd ~/physios && git pull
./scripts/install.sh                         # rebuilds the frontend
./docker/physios-docker.sh build all         # if docker/ or robot/ changed
./stop_physios.sh --robot && ./start_physios.sh --with-robot
```

Your data folder and `configuration/physios.env` are not tracked by git and are kept.

## Modules

These are the pages of the running interface (see `documentation/screenshots/`):

* 01 Home: robot selection, workflow.
* 02 Planning: Define task, Planning type, Configure, Plan & edit, Validate & approve.
* 03 Record:
  * Plan mode or Free recording;
  * views: Original, Processed, Simulation, Multi-panel;
  * Review episodes, Camera check.
* 04 Data: Overview, Episodes, Publish, Tools.
* 05 Training: New training, Runs, Queue, Optimize, Evaluate, Compare, Storage, In container.
* 06 Inference: Container inference, Host rollout.
* R Robots.

## Access

On a loopback-only gateway (the default) no sign-in is needed. Set `PHYSIOS_AUTH_TOKEN` in
`configuration/physios.env` to require an operator token. It is mandatory before RawBot Studio may
listen on the network (`PHYSIOS_HOST`, `PHYSIOS_ALLOW_REMOTE=1`).

## Documentation

| File | Contents |
|---|---|
| `documentation/02-ARCHITECTURE.md` | architecture, directory structure, data folder, modules, safety model |
| `documentation/03-API.md` | gateway API contract (`/api/v1`, `/ros`) |
| `documentation/04-OPERATIONS.md` | install, configure, run, Docker, update, migrate from 1.x, troubleshoot, test |
| `documentation/05-STATUS.md` | what was verified, how, and what was not |
| `documentation/07-VALIDATION.md` | requirements traceability, test results, deployment validation |
| `documentation/01-ANALYSIS.md`, `06-PROJECT-REPORT.md`, `paper/` | history: analysis, v4 phases and 1.x report, IEEE paper |
| `robot/README.md` | the robot runtime packages and robot configs |
| `NOTICE` | third-party code included in RawBot Studio (ROBOTIS physical_ai_tools, Apache-2.0) |

## Safety

The robot moves only after an explicit operator action:

* **Start** in Record: the follower mirrors the leader arm.
* **Load model**, then **Start moving** in Host rollout: two confirmations, and the worker
  enforces the joint envelope, step limits, heartbeat and stale-data holds, and the emergency
  stop.
* **Start** in Container inference.
* **Start motion** in the one-joint hardware test: a server-authorised plan.

Start-up (scripts, containers) never moves the robot. A software stop holds position. It is
not a hardware emergency stop, so keep the power switch or e-stop within reach.

## Licence

Apache License 2.0 (`LICENSE`). RawBot Studio includes code derived from ROBOTIS physical_ai_tools
(Apache-2.0); see `NOTICE`.
