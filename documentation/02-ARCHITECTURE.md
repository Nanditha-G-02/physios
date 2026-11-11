# PHYSIOS architecture

## Principle

```
PHYSIOS FRONTEND → PHYSIOS GATEWAY (API + adapters) → EXISTING SERVICES → ROBOT / HARDWARE
```

The frontend only talks to the gateway, on one origin: REST under `/api/v1`, the same-origin
paths the interface has always used (`/train-api`, `/camera-stream`, `/lerobot-data`), and one
WebSocket (`/ros`) to rosbridge. The gateway owns no robot logic. It translates requests and forwards them to
the service that already implements them, adds what was missing (aggregated health, CPU
utilisation, activity feed, dataset file serving and export, structured errors), and serves
the built frontend.

## Directory structure

```
physios/
├── start_physios.sh / stop_physios.sh     independent start-up and shutdown
├── configuration/physios.env.example      environment-based configuration
├── backend/physios_gateway/               application server (Python ≥3.9, standard library only)
│   ├── app.py                             HTTP server, routing, proxies, /ros WebSocket pipe, static files
│   ├── config.py                          defaults → physios.env → environment → flags
│   ├── errors.py                          {"error": {code, message, hint}}
│   ├── adapters/ws.py                     RFC 6455 client (rosbridge)
│   ├── adapters/rosbridge.py              persistent rosbridge client: service calls, reconnect, status
│   ├── adapters/datasets.py               LeRobot folders: resolve, Range files, tar.gz export (read-only)
│   ├── services/ros_api.py                typed operations on physical_ai_server (planning/data/task/…)
│   ├── services/health.py                 real checks of every dependency, cached 3 s
│   ├── services/system.py                 host metrics (reuses pam_trainer.environment; adds CPU %)
│   ├── services/activity.py               persistent activity feed
│   └── services/auth.py                   optional operator sign-in
├── backend/tests/test_gateway.py          unit + in-process integration tests
├── frontend/                              the PHYSIOS interface (React 19, Redux, Tailwind; CRA build → dist/)
│   └── src/                               pages/ (Home, Planning, Record, Data, Training, Inference,
│                                          Robots), features/, components/, AuthGate.js (sign-in)
├── docker/                                Dockerfile, docker-compose.yml, physios-docker.sh
├── tests/e2e/                             devstack.py (stand-ins), auth_e2e.py (sign-in)
└── documentation/
```

The proposed `integrations/` tree in the brief is implemented as `backend/.../adapters` and
`frontend/src/api`. A separate tree would duplicate existing ROS 2 and trainer packages, which
the brief also rules out.

## Why these technologies

* **Gateway in the Python standard library.** It runs on the host next to `pam_trainer` (same
  constraints: any Python ≥3.9, no packages, no virtualenv). It can import
  `pam_trainer.environment` instead of copying it. ROS stays in the container: the gateway
  speaks rosbridge, the same way the existing UI and the rollout worker do.
* **The interface operators already use.** Since 1.2.0 the frontend is PHYSIOS's own copy of
  the Physical AI Manager interface (v4 with the PHYSIOS name and the compact theme). It
  matches the screenshots of the running system page by page: Home, Planning (Define task →
  Validate & approve), Record (Plan mode / Free recording; Original, Processed, Simulation,
  Multi-panel; Camera check), Data (Overview, Episodes, Publish, Tools), Training (New
  training, Runs, Queue, Optimize, Evaluate, Compare, Storage, In container), Inference
  (Container inference, Host rollout) and Robots. It is built and served by PHYSIOS. It does not
  need the physical_ai_manager container or its nginx, because the gateway provides the
  same-origin paths that nginx used to provide. 1.1.0's separately written TypeScript
  frontend is kept in git (tag `physios-1.1.0`).

## Authentication, deployment

* **Authentication** (`backend/physios_gateway/services/auth.py`): optional operator sign-in.
  Off on a loopback-only gateway (the PC's user accounts are the boundary). It is required
  (`PHYSIOS_AUTH_TOKEN`) as soon as the gateway listens on the network. Sessions are HttpOnly
  SameSite=Strict cookies; scripts use a Bearer token; failed sign-ins are rate-limited.
* **Deployment**: either the scripts (`start_physios.sh` / `stop_physios.sh`), or Docker
  (`docker/Dockerfile`, `docker/docker-compose.yml`, `docker/physios-docker.sh`). The image
  holds the gateway and the built frontend only. It runs with host networking next to the
  existing physical_ai_server and physical_ai_manager containers, as an unprivileged user,
  with the repository and LeRobot cache mounted read-only. The training service stays on the
  host because it needs the operator's LeRobot conda environment and the GPU.

```
Browser ─ PHYSIOS frontend ─┐
                            ▼
               PHYSIOS gateway (script or container, :8700)
   auth · API routing · app services · configuration · activity
      │              │                 │                │
  AI services     robotics          data services     infrastructure
  (pam_trainer:   (physical_ai_     (planning engine,  (health, host metrics,
   training,       server via        recorder,          GPU via pam_trainer,
   optimisation,   rosbridge;        LeRobot dataset    Docker, configuration)
   evaluation,     URDF/robots in    folders)
   host rollout)   pam_trainer)
```

## Interface

* **Design.** Paper/ink/sky tokens, Geist Sans and Geist Mono (bundled), with the compact
  theme: 14 px root, 14 px cards with hairline borders, a dot-grid canvas, a 78 px numbered
  rail (01 Home … 06 Inference, R Robots) with the "Select and confirm a robot on Home first."
  guard, and Link/Robot status at the rail foot.
* **Same-origin paths served by the gateway** (formerly nginx in the physical_ai_manager
  container):

  | Path | Gateway |
  |---|---|
  | `/ros` | WebSocket pipe to rosbridge (the interface no longer connects to `:9090` directly) |
  | `/train-api/*` | training service `/api/*` (X-Forwarded-Host, upload limit) |
  | `/camera-stream/*` | web_video_server, path and query unchanged |
  | `/lerobot-data/<owner>/<name>/<file>` | dataset files, read-only, Range |

* **Changes against the screenshot UI**, all small:
  * the endpoints above;
  * Robot Type and the Connected chip sit side by side on Record and Inference, so the chip no
    longer covers the "PROCESSED · display only" label;
  * an optional sign-in screen, shown only when `PHYSIOS_AUTH_TOKEN` is set.

## Module → back end map

| Module | Gateway route(s) | Existing implementation |
|---|---|---|
| 01 Home (robot selection, workflow) | `/ros` (`/get_robot_types`, `/set_robot_type`, planning services, `/task/status`, `/heartbeat`), `/train-api/health` | physical_ai_server, pam_trainer |
| 02 Planning | `/ros` planning services | `physical_ai_server/planning` |
| 03 Record (views, camera check, review) | `/ros` (`/task/command`, record services, topics), `/camera-stream` | recorder in physical_ai_server, web_video_server |
| 04 Data (Overview, Episodes, Publish, Tools) | `/ros` data/HF services, `/lerobot-data`, `/train-api/health-report` | planning/datasets.py, HF worker, health_probe.py |
| 05 Training (+ Optimize, Evaluate, Compare, Queue, Storage) | `/train-api/*` | pam_trainer runner/planner, diagnostics, optimizer, evaluations, storage |
| 05 Training · In container | `/ros` (original ROBOTIS training services) | physical_ai_server training |
| 06 Inference · Container inference | `/ros` (`/task/command` start_inference), `/camera-stream` | physical_ai_server inference |
| 06 Inference · Host rollout | `/train-api/rollouts*` | rollout.py, rollout_worker.py |
| R Robots | `/train-api/robots/*`, `/ros` (ROS checks, hardware test) | pam_trainer/robots |
| (gateway) health, config, activity, auth | `/api/v1/*` | gateway |

## Live data

`/ros` is a byte-level pipe to rosbridge after the WebSocket upgrade (Origin checked, and
sign-in when enabled). As in the Physical AI Manager, the interface uses roslib over this pipe
for topics and for physical_ai_server service calls (task commands, planning and data
services). The gateway's own REST API (`/api/v1`) remains available for scripts and tools.

## Safety model

| Action | Who can trigger it | Guard |
|---|---|---|
| Recording | Start take / Start recording | operator click; the human leader arm drives the follower |
| On-robot inference | Inference · Container inference → Start | operator click, as in the Physical AI Manager (the call goes over `/ros`). The gateway's `POST /api/v1/ros/task` keeps its `"confirm": true` rule (HTTP 428) for scripts. |
| Host rollout load | Inference · Host rollout → Load model | compatibility + checklist; worker publishes nothing |
| Host rollout run | Inference · Host rollout → Start moving | second confirmation; worker enforces envelope, per-step limits, stale-data and heartbeat holds, duration cap; emergency stop kills the worker |
| Hardware test | Robot Management | Stage 2, connected, checklist, typed robot name → server token (180 s, single use) → Start motion; pre-hold detects wrong mapping; STOP; server re-checks samples |

A software stop holds position. It is not a hardware emergency stop. The operator keeps the
power switch or e-stop within reach, and the checklists say so.

## Independence

* Startup: `start_physios.sh` starts the gateway (and `pam_trainer` if needed). The old UI
  container may keep running on port 80 or be stopped; PHYSIOS does not use it.
* Data: no new storage format. Plans, reviews, runs and robots stay where their services keep
  them. The gateway stores only its own activity log and logs in `physios/var/`.
* Removal: deleting `physios/` removes PHYSIOS. Nothing else in the repository was modified.
