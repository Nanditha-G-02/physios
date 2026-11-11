# PHYSIOS 1.2.0: validation report

Date: 11 November 2026 · Branch `physical-ai-manager-v2` · Environment: cloud sandbox (Ubuntu
24.04, Python 3.12/3.13, Node 20, Chromium via Playwright), **no robot, no GPU**.

This report checks PHYSIOS 1.2.0 against the PHYSIOS brief (Version 4). It also checks the
11 Nov instruction to reproduce the running interface exactly, using the operator's 31
screenshots, without unnecessary changes. Per section 7 of the brief, simulated tests are
**not** a claim of completion on hardware; section 4 lists what has to be checked on the
robot PC.

## 1. Requirements traceability

| Requirement | Where it is met | Evidence | Status |
|---|---|---|---|
| Keep the existing interface exactly (screenshots of 11 Nov) | `physios/frontend` is PHYSIOS's copy of the Physical AI Manager interface (v4 + PHYSIOS name + compact theme) | 23 screenshots of 1.2.0 compared with the 31 reference screenshots: same pages, tabs, views and layout | met |
| Only necessary changes | (1) endpoints routed through the gateway, (2) Connected chip beside Robot Type (it covered the Processed-view label), (3) sign-in screen only when enabled | `diff -r physical_ai_manager/src physios/frontend/src`: 5 files changed, 1 added (`AuthGate.js`); `package.json` name, version, build path | met |
| Independent frontend and UI | own copy, built to `physios/frontend/dist`, served by the PHYSIOS gateway | runs with the physical_ai_manager container stopped (devstack has none) | met |
| Independent backend and API layer | `physios_gateway` (`/api/v1`, `/ros`, same-origin paths) | 22 gateway tests | met |
| Independent configuration, storage, start-up, shut-down | `configuration/physios.env`, scripts, Docker | script and container runs | met |
| Authentication layer | `services/auth.py`; `AuthGate.js` | 4 gateway tests + browser 6/6 (script) + 6/6 (container) | met (shared operator token) |
| Docker configuration and deployment scripts | `docker/` | built and run, healthy | met (substitute base image, §3) |
| All V4 modules preserved | the Physical AI Manager pages themselves | walk-through 26/26, Optimize 9/9 | met (simulated) |
| Preserve the SO-101 workflow | physical_ai_server unchanged; same ROS services and topics | planning tests 45 passed; walk-through | met (stand-in) |
| No automatic motion at start-up | scripts and container start only the gateway (and the trainer service) | code review | met |
| Physical execution needs explicit initiation | Record Start, Host rollout Load → Start moving, Container inference Start, hardware-test Start motion | walk-through; v4 suites | met |
| README, architecture, report, IEEE paper, screenshots, test results, version | `README.md`, `02-ARCHITECTURE.md`, `06-PROJECT-REPORT.md`, `paper/`, `screenshots/`, this file, `CHANGELOG.md`, `VERSION` | — | met |

## 2. Automated test results (11 Nov 2026, final build)

| Suite | Command | Result |
|---|---|---|
| Gateway (API, adapters, sign-in, same-origin paths) | `cd physios/backend && python3 -m pytest -q tests` | **22 passed** |
| Frontend production build (lint = error) | `cd physios/frontend && CI=true npm run build` | **compiled** |
| Frontend unit tests | `CI=true npx react-scripts test --watchAll=false` | `imageStats` passes; the stock CRA `App.test.js` suite fails to run, unchanged from the Physical AI Manager |
| Whole workflow, served by PHYSIOS on :8700 | `physical_ai_manager/e2e/run_e2e.py http://127.0.0.1:8700` against `tests/e2e/devstack.py` | **26/26** |
| Optimize tab, served by PHYSIOS | `opt_ui_check.py http://127.0.0.1:8700` against `devstack.py --seed` | **9/9** |
| Sign-in (script install / Docker container) | `tests/e2e/auth_e2e.py` | **6/6, 6/6** |
| Training service (unchanged v4) | `cd physical_ai_trainer && python3 -m pytest -q` | **91 passed, 1 skipped** |
| Planning engine (unchanged v4) | `cd physical_ai_server && python3 -m pytest -q test/planning` | **45 passed** |

What the stand-ins are:
* the **real** PlanningService code behind a rosbridge stand-in with a simulated recorder and
  camera topics;
* the **real** pam_trainer with a stub `lerobot-train`;
* the **real** gateway, serving the interface and every same-origin path.

## 3. Deployment validation

| Path | What was run | Result |
|---|---|---|
| Scripts / direct | `python3 -m physios_gateway` (devstack) | interface served; ROS, camera, trainer and dataset paths all through the gateway |
| Docker | `./physios-docker.sh up` with `PHYSIOS_BASE_IMAGE` set to a locally imported Ubuntu 24.04 + Python 3.12.3 image | container *healthy* as uid 1000; sign-in 6/6 |

Docker Hub cannot be reached from the sandbox, so the default base `python:3.12-slim` was not
pulled. Confirm with `./physios-docker.sh up` on the robot PC.

## 4. Not validated (needs the robot PC)

1. Real SO-101 through PHYSIOS:
   * recording;
   * camera streams through `/camera-stream`;
   * `/task/status`;
   * robot-type switching (Zenoh router before the bringup).
2. Real `lerobot-train`, real model load and a supervised host rollout; container inference on
   the robot.
3. The hardware test on the real arm; `--with-ros`; the Docker image next to the real
   containers.
4. Dataset health probe; Hugging Face and GitHub publishing with real accounts.

## 5. Screenshots

`documentation/screenshots/`: 23 screenshots of 1.2.0, taken at 1600 × 900 against the
devstack:
* Home and Planning;
* Record: plan mode, free recording, Processed, Simulation, Multi-panel;
* Data: Overview, Episodes, Publish, Tools;
* Training: all eight tabs;
* Inference: Container and Host rollout;
* Robots, and the sign-in screen.
