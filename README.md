# PHYSIOS: The Operating System for Physical Intelligence

PHYSIOS is a standalone application for the whole imitation-learning loop on a real robot:
plan demonstrations, record them, curate the dataset, train and optimise a policy on this PC,
evaluate it, and run it on the robot under supervision.

It has its own frontend, application server, navigation, design system and start/stop
scripts. It does **not** use or need the old Physical AI Manager web UI. It reuses the existing,
working back ends unchanged:

| Back end | What PHYSIOS uses it for |
|---|---|
| `physical_ai_server` (ROS 2 node, container) | planning engine, recording, datasets, reviews, publishing, on-robot inference |
| `physical_ai_trainer` / `pam_trainer` (host service) | local training, optimisation, evaluation log, host rollout, custom robots |
| `web_video_server` (container) | live camera streams |
| LeRobot dataset folders | episode videos and export (read-only) |

```
Browser ── PHYSIOS frontend (physios/frontend, served by the gateway)
              │ /api/v1 (REST)      │ /ros (WebSocket)
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
./start_physios.sh --with-ros      # first run builds the frontend (needs Node.js 18+)
# open the printed URL, default http://127.0.0.1:8700
./stop_physios.sh
```

`--with-ros` starts the Zenoh router and the physical_ai_server bringup inside the
`physical_ai_server` container if they are not already running. Neither of these moves the robot.
Without it, start them yourself; PHYSIOS shows which services are missing and how to start them.

## Modules

Same look, navigation and page layouts as the Physical AI Manager:

01 Home (robot selection, workflow, service overview) · 02 Planning · 03 Record · 04 Data ·
05 Training (new training, runs, queue, optimize, evaluate, compare, storage) · 06 Inference
(model check, host rollout, container inference) · R Robots · Settings.

## Documentation

| File | Contents |
|---|---|
| `documentation/01-ANALYSIS.md` | Phase 1: repository and patch analysis, dependency map |
| `documentation/02-ARCHITECTURE.md` | architecture, directory structure, modules, safety model |
| `documentation/03-API.md` | gateway API contract (`/api/v1`, `/ros`) |
| `documentation/04-OPERATIONS.md` | installation, configuration, execution, troubleshooting, testing |
| `documentation/05-STATUS.md` | what was verified, how, and what was not |

## Safety

The robot moves only after an explicit operator action: Start take (recording, with the
leader arm), Run (host rollout, after a checklist and a typed confirmation), Start on-robot
inference (checklist and typed confirmation, with `confirm: true` enforced by the gateway), or
Start motion (one-joint hardware test, server-authorised plan). Start-up never moves the robot.
