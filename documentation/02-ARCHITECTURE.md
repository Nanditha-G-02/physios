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
│       ├── app/            shell (rail, header, connection pills, robot selector, notifications), router, system state
│       ├── design/         theme.css (tokens, light/dark), ui.tsx (components), charts.tsx, icons.tsx
│       ├── api/            http.ts (errors), gateway.ts, trainer.ts, rosbridge.ts (live topics)
│       ├── hooks/          useLoad/useAction/useTopic/useNow
│       ├── lib/            urdf.ts (URDF → three.js), hardwareTest.ts (one-joint test sequencer)
│       └── modules/        dashboard, planning, recording, datasets, training, optimization,
│                           evaluation, inference, rollout, robots, settings
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

## Module → back end map

| Module | Gateway route(s) | Existing implementation |
|---|---|---|
| Dashboard | `health`, `system`, `activity`, `trainer/runs`, `trainer/optimization/sessions`, `trainer/rollouts`, `data/data.list_datasets`; `/ros` `/task/status`, `/heartbeat` | gateway, pam_trainer, physical_ai_server |
| Planning Studio | `planning/plan.*`, `planning/meta`, `planning/robot.profile` | `physical_ai_server/planning` (engine, validation, versioning) |
| Recording Studio | `planning/record.*`, `ros/task`, `ros/cameras`, `camera/stream`, `data/data.review`; `/ros` topics | recorder in physical_ai_server, web_video_server |
| Dataset Library | `data/data.*`, `datasets/<id>/files/*`, `datasets/<id>/export`, `trainer/health-report`, `ros/hf`, `data/github.*` | planning/datasets.py, health_probe.py, HF worker |
| Training Studio | `trainer/envs`, `datasets`, `models`, `plan`, `runs*`, `queue*`, `storage` | pam_trainer runner/planner |
| Optimization Studio | `trainer/runs/<id>/diagnostics`, `trainer/optimization/*`, `trainer/compare`, `trainer/runs/<id>/watch` | diagnostics.py, tuning.py, optimizer.py |
| Evaluation Studio | `trainer/evaluations*`, `trainer/compare` | evaluations.py |
| Inference Studio | `trainer/rollouts/prepare`, `trainer/rollouts` (dry run), `rollouts/<id>`, `ros/policies` | rollout.py, rollout_worker.py |
| Robot Rollout | `trainer/rollouts*` (run/pause/stop/estop/heartbeat/limits), `ros/task` (`start_inference` with `confirm`) | rollout_worker.py; physical_ai_server inference |
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
| On-robot inference | Robot Rollout, "policy on the robot side" | checklist + typed `run`; gateway rejects `start_inference` without `"confirm": true` (HTTP 428) |
| Host rollout load | Robot Rollout / Inference Studio | compatibility + token from `prepare`; worker publishes nothing |
| Host rollout run | Robot Rollout | readiness all green + 4-item checklist + typed `run`; worker enforces envelope, per-step limits, stale-data and heartbeat holds, duration cap; E-STOP kills the worker after 0.5 s |
| Hardware test | Robot Management | Stage 2, connected, checklist, typed robot name → server token (180 s, single use) → Start motion; pre-hold detects wrong mapping; STOP; server re-checks samples |

A software stop holds position. It is not a hardware emergency stop. The operator keeps the
power switch or e-stop within reach, and the checklists say so.

## Independence

* Startup: `start_physios.sh` starts the gateway (and `pam_trainer` if needed). The old UI
  container may keep running on port 80 or be stopped; PHYSIOS does not use it.
* Data: no new storage format. Plans, reviews, runs and robots stay where their services keep
  them. The gateway stores only its own activity log and logs in `physios/var/`.
* Removal: deleting `physios/` removes PHYSIOS. Nothing else in the repository was modified.
