# PHYSIOS architecture

## Principle

```
PHYSIOS FRONTEND → PHYSIOS GATEWAY (API + adapters) → EXISTING SERVICES → ROBOT / HARDWARE
```

The frontend only talks to the gateway: REST under `/api/v1`, plus one WebSocket (`/ros`) for
live ROS topics. The gateway owns no robot logic. It translates requests and forwards them to
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
│   └── services/activity.py               persistent activity feed
├── backend/tests/test_gateway.py          unit + in-process integration tests
├── frontend/                              Vite + React 18 + TypeScript
│   └── src/
│       ├── app/            shell (numbered rail, nav guard, link/robot status, services/notifications), router, system state
│       ├── design/         theme.css (Physical AI Manager tokens and classes), ui.tsx (components), charts.tsx, icons.tsx
│       ├── api/            http.ts (errors), gateway.ts, trainer.ts, rosbridge.ts (live topics)
│       ├── hooks/          useLoad/useAction/useTopic/useNow
│       ├── lib/            urdf.ts (URDF → three.js), hardwareTest.ts (one-joint test sequencer)
│       └── modules/        home (+ dashboard overview), planning, recording, datasets, training
│                           (+ optimization, evaluation tabs), inference (+ rollout tabs), robots, settings
├── tests/e2e/                             devstack.py (stand-ins), physios_e2e.py (browser walk-through)
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
* **New frontend on Vite + React + TypeScript.** CRA (old UI) is deprecated. TypeScript catches
  contract drift. Dependencies are react, react-dom, three (URDF viewer) and two local font
  packages (works offline). There is no router, state, chart or UI library: those are a few
  hundred lines here, and the result is one consistent design system.

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

## Design system and navigation

PHYSIOS uses the design language of the existing Physical AI Manager, so operators see the
same application they already know:

* **v1.1 compact professional layer** (end of `theme.css`): the same components with
  less whitespace: 14 px card radius with hairline borders, a faint dot-grid canvas, a 78 px
  rail, 30 px page titles, 44 px panel headers, compact controls and tables, work areas up to
  1760 px wide. It is responsive: the console stacks below 1100 px, and below 640 px the rail
  becomes a bottom navigation bar.
* **Tokens.** Paper greys (`#F3F4F6`, `#ECEEF1`, `#E1E4E8`), ink (`#0B0C0E` … `#B4B9C1`), sky
  blue accents (`#D6E3FF`, `#2457E6`), green / orange / red signals, 22 px card radius, pill
  buttons and chips, Geist Sans and Geist Mono (bundled, offline). Light theme only, as before.
* **Shell.** The 96 px left rail with numbered steps (01 Home … 06 Inference, R Robots), a
  black capsule for the current page, green ticks for earlier steps and the "Select and
  confirm a robot on Home first." guard; Link / Robot status and the services, notifications
  and settings buttons at the foot of the rail.
* **Page layouts.** Hero pages ("05 · Training" label, light fading title, grey intro, chips and
  segmented tabs on the right) for Training, Robots and Settings; the Home page with the robot
  drawing, robot selection card and six workflow tiles; the workbench layout (white list sheet
  on the left, detail on the right) for Planning and Data; the console layout (robot type and
  connection at the top left, cameras in the middle, white side sheet, Start / Stop / Retry /
  Next / Finish control bar at the bottom) for Record and Inference.
* **Navigation.** Training holds New training, Runs, Queue, Optimize, Evaluate, Compare and
  Storage as tabs (`/training/...`). Inference holds Model check (dry run), Host rollout and
  Container inference as tabs (`/inference`, `/inference/rollout`, `/inference/container`).
  Settings is reached from the rail foot.

## Module → back end map

| Module | Gateway route(s) | Existing implementation |
|---|---|---|
| Home (robot selection, workflow, overview) | `ros/robot_type`, `health`, `system`, `activity`, `trainer/runs`, `trainer/optimization/sessions`, `trainer/rollouts`, `data/data.list_datasets`; `/ros` `/task/status`, `/heartbeat` | gateway, pam_trainer, physical_ai_server |
| Planning Studio | `planning/plan.*`, `planning/meta`, `planning/robot.profile` | `physical_ai_server/planning` (engine, validation, versioning) |
| Recording Studio | `planning/record.*`, `ros/task`, `ros/cameras`, `camera/stream`, `data/data.review`; `/ros` topics | recorder in physical_ai_server, web_video_server |
| Dataset Library | `data/data.*`, `datasets/<id>/files/*`, `datasets/<id>/export`, `trainer/health-report`, `ros/hf`, `data/github.*` | planning/datasets.py, health_probe.py, HF worker |
| Training Studio | `trainer/envs`, `datasets`, `models`, `plan`, `runs*`, `queue*`, `storage` | pam_trainer runner/planner |
| Training · Optimize tab | `trainer/runs/<id>/diagnostics`, `trainer/optimization/*`, `trainer/compare`, `trainer/runs/<id>/watch` | diagnostics.py, tuning.py, optimizer.py |
| Training · Evaluate / Compare tabs | `trainer/evaluations*`, `trainer/compare` | evaluations.py |
| Inference · Model check tab | `trainer/rollouts/prepare`, `trainer/rollouts` (dry run), `rollouts/<id>`, `ros/policies` | rollout.py, rollout_worker.py |
| Inference · Host rollout / Container tabs | `trainer/rollouts*` (run/pause/stop/estop/heartbeat/limits), `ros/task` (`start_inference` with `confirm`) | rollout_worker.py; physical_ai_server inference |
| Robot Management | `trainer/robots/*`, `/ros` (ROS checks, live joints, hardware test) | pam_trainer/robots (archive, xacro, urdf, store, readiness) |
| Settings | `config`, `health`, `trainer/envs`, `trainer/system` | gateway, pam_trainer |

## Live data

`/ros` is a byte-level pipe to rosbridge after the WebSocket upgrade (Origin checked). The
frontend's `api/rosbridge.ts` is a small rosbridge v2 client with reconnection. It subscribes
(throttled) to `/task/status`, `/heartbeat`, joint states and HF status. The one browser-side
publisher is the supervised hardware test, which is unchanged from v4 by design: the server
issues the capped plan and verifies the samples. Every other command with an effect uses
REST, so the gateway can validate it and log it.

## Safety model

| Action | Who can trigger it | Guard |
|---|---|---|
| Recording | Start take / Start recording | operator click; the human leader arm drives the follower |
| On-robot inference | Inference · Container inference | checklist + typed `run`; gateway rejects `start_inference` without `"confirm": true` (HTTP 428) |
| Host rollout load | Inference · Host rollout / Model check | compatibility + token from `prepare`; worker publishes nothing |
| Host rollout run | Inference · Host rollout / Container tabs | readiness all green + 4-item checklist + typed `run`; worker enforces envelope, per-step limits, stale-data and heartbeat holds, duration cap; E-STOP kills the worker after 0.5 s |
| Hardware test | Robot Management | Stage 2, connected, checklist, typed robot name → server token (180 s, single use) → Start motion; pre-hold detects wrong mapping; STOP; server re-checks samples |

A software stop holds position. It is not a hardware emergency stop. The operator keeps the
power switch or e-stop within reach, and the checklists say so.

## Independence

* Startup: `start_physios.sh` starts the gateway (and `pam_trainer` if needed). The old UI
  container may keep running on port 80 or be stopped; PHYSIOS does not use it.
* Data: no new storage format. Plans, reviews, runs and robots stay where their services keep
  them. The gateway stores only its own activity log and logs in `physios/var/`.
* Removal: deleting `physios/` removes PHYSIOS. Nothing else in the repository was modified.
