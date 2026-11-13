# PHYSIOS: The Operating System for Physical Intelligence

Version 1.2.0 · see `CHANGELOG.md`

> **Where to put this repository.** PHYSIOS runs next to the ROBOTIS
> [physical_ai_tools](https://github.com/ROBOTIS-GIT/physical_ai_tools) back ends
> (physical_ai_server, physical_ai_trainer). Clone it **inside** that checkout as `physios/`:
>
> ```bash
> cd ~/lerobot/physical_ai_tools
> git clone https://github.com/<owner>/<this-repo>.git physios
> cd physios/frontend && npm ci && npm run build && cd ..   # or use the release zip, which ships the built UI
> ./start_physios.sh --with-ros                             # http://127.0.0.1:8700
> ```
>
> The training service, custom-robot and v4 optimisation features live in
> `physical_ai_trainer/` of that checkout, at the branch `physical-ai-manager-v2` (v4).

PHYSIOS is a standalone application for the whole imitation-learning loop on a real robot:
plan demonstrations, record them, curate the dataset, train and optimise a policy on this PC,
evaluate it, and run it on the robot under supervision.

It has its own application server, configuration, start/stop scripts and Docker deployment.
Its frontend is the interface operators already use: PHYSIOS's own copy of the Physical AI
Manager interface, with the PHYSIOS name and the compact theme. It is built and served by
PHYSIOS, so it does **not** need the physical_ai_manager container or its nginx. It reuses the existing,
working back ends unchanged:

| Back end | What PHYSIOS uses it for |
|---|---|
| `physical_ai_server` (ROS 2 node, container) | planning engine, recording, datasets, reviews, publishing, on-robot inference |
| `physical_ai_trainer` / `pam_trainer` (host service) | local training, optimisation, evaluation log, host rollout, custom robots |
| `web_video_server` (container) | live camera streams |
| LeRobot dataset folders | episode videos and export (read-only) |

```
Browser ── PHYSIOS frontend (physios/frontend, served by the gateway)
              │ /api/v1, /train-api, /camera-stream, /lerobot-data    │ /ros (WebSocket)
              ▼                     ▼
         PHYSIOS gateway (physios/backend, 127.0.0.1:8700)
           ├─ rosbridge adapter ──► physical_ai_server (ROS 2, rmw_zenoh)
           ├─ trainer proxy ──────► pam_trainer (127.0.0.1:8766)
           ├─ camera proxy ───────► web_video_server (:8080)
           └─ dataset files ──────► LeRobot folders (read-only)
```

## Quick start (robot PC)

```bash
cd /home/ihub/lerobot/physical_ai_tools/physios
./start_physios.sh --with-ros      # physios.zip ships the built frontend; from source, the first run builds it (Node.js 18+)
# open the printed URL, default http://127.0.0.1:8700
./stop_physios.sh
```

Or in Docker (gateway + frontend only; the robot side and the training service stay as they are):

```bash
cd /home/ihub/lerobot/physical_ai_tools/physios/docker
./physios-docker.sh up             # http://127.0.0.1:8700
```

`--with-ros` starts the Zenoh router and the physical_ai_server bringup inside the
`physical_ai_server` container if they are not already running. Neither of these moves the robot.
Without it, start them yourself; PHYSIOS shows which services are missing and how to start them.

## Modules

Exactly the pages of the running interface (see `documentation/screenshots/`):

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

On a loopback-only gateway (default) no sign-in is needed. Set `PHYSIOS_AUTH_TOKEN` in
`configuration/physios.env` to require an operator token. It is mandatory before PHYSIOS may
listen on the network (`PHYSIOS_HOST`, `PHYSIOS_ALLOW_REMOTE=1`).

## Documentation

| File | Contents |
|---|---|
| `documentation/01-ANALYSIS.md` | Phase 1: repository and patch analysis, dependency map |
| `documentation/02-ARCHITECTURE.md` | architecture, directory structure, modules, safety model |
| `documentation/03-API.md` | gateway API contract (`/api/v1`, `/ros`) |
| `documentation/04-OPERATIONS.md` | installation, configuration, execution, troubleshooting, testing |
| `documentation/05-STATUS.md` | what was verified, how, and what was not |
| `documentation/06-PROJECT-REPORT.md` | full report: v4 phases, PHYSIOS, renaming, tests, commits, pending tasks |
| `documentation/07-VALIDATION.md` | requirements traceability, test results, deployment validation |
| `documentation/paper/physios-ieee.pdf` | IEEE-format technical paper (LaTeX source alongside) |
| `documentation/screenshots/` | screenshots of every module (desktop and phone width) |
| `docker/` | Dockerfile, compose file and `physios-docker.sh` |

## Safety

The robot moves only after an explicit operator action:

* **Start** in Record: the follower mirrors the leader arm.
* **Load model**, then **Start moving** in Host rollout: two confirmations, and the worker
  enforces the joint envelope, step limits, heartbeat and stale-data holds, and the emergency
  stop.
* **Start** in Container inference.
* **Start motion** in the one-joint hardware test: a server-authorised plan.

Start-up never moves the robot.
