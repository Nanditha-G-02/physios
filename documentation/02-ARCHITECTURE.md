# RawBot Studio architecture (2.0.0)

## Principle

```
FRONTEND → GATEWAY → SERVICES (training service, robot runtime) → ROBOT      (all RawBot Studio)
```

RawBot Studio is one repository that contains every layer it runs. The frontend only talks to the
gateway, on one origin:
* REST under `/api/v1`;
* the same-origin paths `/train-api`, `/camera-stream` and `/lerobot-data`;
* one WebSocket, `/ros`, to rosbridge.

The gateway owns no robot logic. It forwards requests to the RawBot Studio service that implements
them. It adds aggregated health, CPU utilisation, an activity feed, dataset file serving and
export, structured errors and sign-in, and it serves the built frontend.

The services are:

* **Training service** (`backend/physios_trainer`, host process, `127.0.0.1:8766`):
  * local training, the queue, optimisation sessions, evaluations and comparisons;
  * storage, host rollouts, the custom-robot library and dataset health reports.
* **Robot runtime** (`robot/`, `physios-robot` container, ROS 2 Jazzy):
  * the `physical_ai_server` node: robot types, recording into LeRobot datasets, on-robot
    inference, in-container training, and the RawBot Studio planning engine with its
    `/planning/command` and `/data/command` services;
  * the bag recorder;
  * rosbridge (`:9090`) and web_video_server (`:8080`).

The only things outside RawBot Studio:
* the arm's own ROS 2 driver, which publishes joint states and camera topics and accepts
  commands;
* the operator's LeRobot Python environment that training runs in;
* public base images and packages.

## Directory structure

```
physios/                                   the repository (github.com/Nanditha-G-02/physios)
├── README.md · CHANGELOG.md · VERSION · LICENSE · NOTICE
├── start_physios.sh / stop_physios.sh     start-up and shutdown (scripts deployment)
├── scripts/
│   ├── install.sh                         requirements, configuration, data folder, frontend build
│   └── import-legacy-data.py              copy data from a PHYSIOS 1.x installation
├── configuration/physios.env.example      environment-based configuration
├── frontend/                              the RawBot Studio interface (React 19, Redux, Tailwind; CRA → dist/)
│   └── src/                               pages/ (Home, Planning, Record, Data, Training, Inference,
│                                          Robots), features/, components/, AuthGate.js (sign-in)
├── backend/                               host processes, Python ≥3.9, standard library only
│   ├── physios_gateway/                   application server
│   │   ├── app.py                         HTTP server, routing, proxies, /ros WebSocket pipe, static files
│   │   ├── config.py                      defaults → physios.env → environment → flags
│   │   ├── errors.py                      {"error": {code, message, hint}}
│   │   ├── adapters/                      ws.py (RFC 6455), rosbridge.py, datasets.py (read-only, Range, export)
│   │   └── services/                      ros_api, health, system (CPU %), activity, auth
│   ├── physios_trainer/                   training service (HTTP API on 127.0.0.1:8766)
│   │   ├── server.py · service.py         API and operations
│   │   ├── runner.py · planner.py · jobqueue.py · catalog.py · introspect.py · environment.py
│   │   ├── diagnostics.py · tuning.py · optimizer.py · evaluations.py · storage.py
│   │   ├── rollout.py · rollout_worker.py host rollout (worker runs in the LeRobot environment)
│   │   ├── health_probe.py · datasets.py  dataset health
│   │   └── robots/                        custom robots: upload, URDF/xacro, readiness, library
│   ├── tests/                             gateway tests
│   └── trainer_tests/                     training-service tests, fixtures, standalone-layout tests
├── robot/                                 robot runtime (ROS 2 workspace sources)
│   ├── src/physical_ai_server/            robot server node; planning/ = RawBot Studio planning engine;
│   │                                      config/ = built-in robot configs; launch/; test/planning
│   ├── src/physical_ai_interfaces/        messages and services
│   ├── src/rosbag_recorder/               bag recording service
│   ├── lerobot.lock                       LeRobot commit installed in the robot image
│   └── README.md
├── docker/
│   ├── gateway/Dockerfile                 gateway + built frontend
│   ├── robot/Dockerfile, entrypoint.sh    robot runtime image
│   ├── docker-compose.yml                 physios-gateway; physios-robot (profile "robot")
│   ├── docker-compose.gpu.yml             GPU for the robot runtime (added automatically)
│   └── physios-docker.sh                  build / up / robot-up / logs / shell / status / down
├── tests/e2e/                             devstack.py (stand-ins), run_e2e.py, opt_ui_check.py,
│                                          auth_e2e.py, standin_server.py
├── documentation/
└── data/                                  (not in git) the data folder, see below
```

## The data folder

One folder, `PHYSIOS_DATA_DIR` (default `data/`), holds everything RawBot Studio produces. Every
part mounts it at a fixed place, so paths are stable between the host and the containers:

| Sub-folder | Contents | Host (gateway, trainer) | Robot runtime |
|---|---|---|---|
| `huggingface/` | LeRobot datasets (`lerobot/<owner>/<name>`), downloaded models | `$PHYSIOS_DATA_DIR/huggingface` | `/root/.cache/huggingface` |
| `workspace/physios/` | plans, progress, reviews, publish history; training runs, queue, sessions, evaluations, rollouts, robot library | `$PHYSIOS_DATA_DIR/workspace/physios` | `/workspace/physios` |
| `outputs/train/` | checkpoints | `$PHYSIOS_DATA_DIR/outputs/train` | `/physios/data/outputs/train` |
| `robot-config/` | operator robot configs | | installed into the robot server at start |

The training service translates a checkpoint path into the robot container's path (for
Inference, "load in container"). It reads the robot image's LeRobot version from
`robot/lerobot.lock`, so it can warn about mismatches.

## Why these technologies

* **Gateway and training service in the Python standard library.** They run on the host with
  any Python ≥3.9, without packages or a virtualenv. The training service has to be on the
  host, because it launches `lerobot-train` in the operator's existing conda environment and
  uses the GPU. The gateway imports `physios_trainer.environment` for host information
  instead of duplicating it.
* **ROS stays in a container.** The robot runtime needs ROS 2 Jazzy, LeRobot, real-time
  limits and device access. All of that goes into one image built from `docker/robot`. The
  gateway and the browser speak rosbridge to it.
* **The interface operators already use.** The frontend is RawBot Studio's own copy of the
  Physical AI Manager v4 interface, with the RawBot Studio name and the compact theme. It matches
  the screenshots of the running system page by page, as listed in `README.md`. It is built
  and served by RawBot Studio: the gateway provides the same-origin paths that nginx used to.

## Authentication, deployment

* **Authentication** (`services/auth.py`): optional operator sign-in.
  * Off on a loopback-only gateway, where the PC's user accounts are the boundary.
  * Required (`PHYSIOS_AUTH_TOKEN`) as soon as the gateway listens on the network.
  * Sessions are HttpOnly SameSite=Strict cookies; scripts use a Bearer token; failed
    sign-ins are rate-limited.
* **Deployment**, either way:
  * Scripts: `install.sh`, then `start_physios.sh [--with-robot]` / `stop_physios.sh`.
  * Docker: `physios-docker.sh up [--with-robot]`.

  In both cases the robot runtime is the `physios-robot` container and the training service
  is a host process.

```
Browser ─ RawBot Studio frontend ─┐
                            ▼
               RawBot Studio gateway (script or container, :8700)
   auth · API routing · app services · configuration · activity
      │                    │                     │                 │
  training service      robot runtime        data folder       infrastructure
  (physios_trainer,     (physios-robot:       (datasets, plans,  (health, host metrics,
   host: training,       physical_ai_server,   runs, checkpoints) GPU, Docker, config)
   optimisation,         planning engine,
   evaluation, host      recorder, inference,
   rollout, robots)      rosbridge, cameras)
```

## Interface

* **Colour rule: black, white and blue.** The whole interface uses one scheme: white and
  light-grey surfaces, black text and black/navy panels, and one blue (`#2457E6` and its
  shades) for accents. The reference is the training command panel: a navy-black panel,
  white text, blue headings. This applies to every page, card, button, navigation element,
  panel and interactive section, and to every future UI change.
  * In `tailwind.config.js`, the blue, indigo, violet, purple, cyan and teal palettes map to
    one blue scale (`BLUE`). The `sky` tokens hold the brand blue, and `night` holds the
    navy-black panels.
  * Two kinds of colour are allowed:
    1. status: red for errors, Stop and emergency stop, green for OK/alive/done, amber for
       warnings;
    2. data: object colours chosen in a plan and camera images.
  * The animated Home robot (`HeroArm.js`) keeps its own look and is not restyled by theme
    changes.
* **Design.** Paper/ink/sky tokens, Geist Sans and Geist Mono (bundled), with the compact
  theme:
  * 14 px root, 14 px cards with hairline borders, a dot-grid canvas;
  * a 78 px numbered rail (01 Home … 06 Inference, R Robots) with the "Select and confirm a
    robot on Home first." guard;
  * Link/Robot status at the rail foot.
* **Same-origin paths served by the gateway:**

  | Path | Gateway |
  |---|---|
  | `/ros` | WebSocket pipe to rosbridge of the robot runtime |
  | `/train-api/*` | training service `/api/*` (X-Forwarded-Host, upload limit) |
  | `/camera-stream/*` | web_video_server, path and query unchanged |
  | `/lerobot-data/<owner>/<name>/<file>` | dataset files, read-only, Range |

## Module → back end map

| Module | Gateway route(s) | Implementation in RawBot Studio |
|---|---|---|
| 01 Home (robot selection, workflow) | `/ros` (`/get_robot_types`, `/set_robot_type`, planning services, `/task/status`, `/heartbeat`), `/train-api/health` | robot runtime, training service |
| 02 Planning | `/ros` planning services | `robot/src/physical_ai_server/physical_ai_server/planning` |
| 03 Record (views, camera check, review) | `/ros` (`/task/command`, record services, topics), `/camera-stream` | robot server recorder, web_video_server |
| 04 Data (Overview, Episodes, Publish, Tools) | `/ros` data/HF services, `/lerobot-data`, `/train-api/health-report` | `planning/datasets.py`, HF worker, `physios_trainer/health_probe.py` |
| 05 Training (+ Optimize, Evaluate, Compare, Queue, Storage) | `/train-api/*` | `physios_trainer` runner/planner, diagnostics, optimizer, evaluations, storage |
| 05 Training · In container | `/ros` (training services) | robot server training (LeRobot in the robot image) |
| 06 Inference · Container inference | `/ros` (`/task/command` start_inference), `/camera-stream` | robot server inference |
| 06 Inference · Host rollout | `/train-api/rollouts*` | `physios_trainer/rollout.py`, `rollout_worker.py` |
| R Robots | `/train-api/robots/*`, `/ros` (ROS checks, hardware test) | `physios_trainer/robots` |
| (gateway) health, config, activity, auth | `/api/v1/*` | gateway |

## Live data

After the WebSocket upgrade, `/ros` is a byte-level pipe to rosbridge. The gateway checks the
Origin, and sign-in when it is enabled. The interface uses roslib over this pipe for topics
and for robot-server service calls (task commands, planning and data services). The gateway's
own REST API (`/api/v1`) remains available for scripts and tools.

## Safety model

| Action | Who can trigger it | Guard |
|---|---|---|
| Recording | Start take / Start recording | operator click; the human leader arm drives the follower |
| On-robot inference | Inference · Container inference → Start | operator click (over `/ros`); the gateway's `POST /api/v1/ros/task` keeps its `"confirm": true` rule (HTTP 428) for scripts |
| Host rollout load | Inference · Host rollout → Load model | compatibility + checklist; worker publishes nothing |
| Host rollout run | Inference · Host rollout → Start moving | second confirmation; worker enforces envelope, per-step limits, stale-data and heartbeat holds, duration cap; emergency stop kills the worker |
| Hardware test | Robot Management | Stage 2, connected, checklist, typed robot name → server token (180 s, single use) → Start motion; pre-hold detects wrong mapping; STOP; server re-checks samples |
| Start-up | scripts, containers | start services only; the robot-runtime bringup serves ROS services and topics and never commands motion |

A software stop holds position. It is not a hardware emergency stop. The operator keeps the
power switch or e-stop within reach, and the checklists say so.

## Independence

* **Code:** everything RawBot Studio runs is in this repository. The robot runtime packages derive
  from ROBOTIS physical_ai_tools (Apache-2.0, see `NOTICE`) and are maintained here.
* **Installation:** `git clone` + `scripts/install.sh`. No other checkout is used.
* **Data:** one data folder (`PHYSIOS_DATA_DIR`), not tracked by git.
* **Removal:** stop RawBot Studio (`./stop_physios.sh --robot`, `./docker/physios-docker.sh down`),
  remove the images, then delete the repository folder and, if you want, the data folder.
