# PHYSIOS 1.1.0: validation report

Date: 11 November 2026 · Branch `physical-ai-manager-v2` · Environment: cloud sandbox (Ubuntu
24.04, Python 3.12/3.13, Node 20, Chromium via Playwright), **no robot, no GPU**.

This report checks PHYSIOS 1.1.0 against the PHYSIOS brief (Version 4). Per section 7 of the
brief, simulated tests are **not** a claim of completion on hardware. Section 4 lists what has
to be checked on the robot PC.

## 1. Requirements traceability

| Brief requirement | Where it is met | Evidence | Status |
|---|---|---|---|
| Independent frontend and UI | `physios/frontend` (Vite + React 18 + TS), own shell, router, design system | builds stand-alone; does not import or need `physical_ai_manager` | met |
| Independent backend and API layer | `physios/backend/physios_gateway` (`/api/v1`, `/ros`) | 20 gateway tests | met |
| Independent navigation, design system, branding | rail 01–06 + R, PHYSIOS name and mark, `theme.css` | screenshots in `documentation/screenshots/` | met |
| Independent configuration and storage | `configuration/physios.env`, `PHYSIOS_*`, `physios/var` (or Docker volume) | `--check-config`, Settings page | met |
| Independent start-up and shutdown | `start_physios.sh` / `stop_physios.sh`; `docker/physios-docker.sh` | script and container runs | met |
| No dependency on the old UI runtime | the gateway serves its own `frontend/dist` | works with the `physical_ai_manager` container stopped | met |
| Authentication layer | `services/auth.py`, sign-in screen | 3 unit/integration tests + browser 5/5 | met (shared operator token) |
| Docker configuration and deployment scripts | `docker/Dockerfile`, `docker/docker-compose.yml`, `docker/physios-docker.sh` | built and run; healthy | met (substitute base image, see §3) |
| All V4 modules preserved | Home/Dashboard, Planning, Record, Data, Training (+ Optimize, Evaluate, Compare, Queue, Storage), Inference (+ Host rollout, Container), Robots (URDF, readiness), Settings | e2e 14/14 covers each module | met (simulated) |
| Training optimisation (Feature A) | Training → Optimize; pam_trainer unchanged | e2e step 7; trainer pytest 91 passed | met (simulated) |
| Custom robots (Feature B) | Robots; pam_trainer robots unchanged | e2e steps 11–12 (108 commands, none before Start) | met (simulated arm) |
| Preserve SO-101 workflow | physical_ai_server unchanged; same ROS services and topics | planning pytest 45 passed; e2e steps 2–5 | met (stand-in) |
| UI optimisation: less whitespace, density, hierarchy, modern theme, consistency, responsiveness | `theme.css` v1.1 layer | before/after and phone-width screenshots | met |
| No automatic motion at start-up | scripts and container start only the gateway (and the trainer service) | code review; e2e step 12 counts zero commands before Start | met |
| Physical execution needs explicit initiation | Run / Start need a checklist plus typed `run`; the gateway enforces `confirm: true` (HTTP 428) | gateway test; e2e steps 10, 12 | met |
| README, architecture, report, IEEE paper, screenshots, test results, commits/version | `README.md`, `02-ARCHITECTURE.md`, `06-PROJECT-REPORT.md`, `paper/`, `screenshots/`, this file, `CHANGELOG.md`, `VERSION` | — | met |

## 2. Automated test results (11 Nov 2026, final build)

| Suite | Command | Result |
|---|---|---|
| Gateway (config, adapters, HTTP API, sign-in) | `cd physios/backend && python3 -m pytest -q tests` | **20 passed** |
| Frontend units (hardware-test sequencer, helpers) | `cd physios/frontend && npx vitest run` | **8 passed** |
| Type check + production build | `npx tsc --noEmit && npx vite build` | **clean** |
| Whole application in a browser | `tests/e2e/physios_e2e.py` against `tests/e2e/devstack.py --seed` | **14/14 steps** |
| Sign-in in a browser (script install) | `tests/e2e/auth_e2e.py` | **5/5** |
| Sign-in in a browser (Docker container) | `tests/e2e/auth_e2e.py` against the container | **5/5** |
| Training service (unchanged v4) | `cd physical_ai_trainer && python3 -m pytest -q` | **91 passed, 1 skipped** |
| Planning engine (unchanged v4) | `cd physical_ai_server && python3 -m pytest -q test/planning` | **45 passed** |
| Old UI with the compact theme patch | `physical_ai_manager/e2e/run_e2e.py`; `CI=true react-scripts build` | **26/26**; compiled |

The 14 browser steps: Home service checks; robot selection on physical_ai_server; plan
create/generate/validate/fix/approve/activate; plan-mode take with review; dataset library,
video, review and export; training with a token-confirmed command; optimisation diagnosis and
a control trial; robot evaluation with a confidence interval; inference compatibility and
dry-run load; host-rollout readiness and envelope; robot upload/validate/register/3D;
configuration, ROS checks and the authorised one-joint test; disconnected states; settings.

What the stand-ins are: the **real** PlanningService code behind a rosbridge stand-in with a
simulated recorder; the **real** pam_trainer with a stub `lerobot-train` (writes logs and
checkpoints, diverges on purpose for some settings); the **real** gateway; a simulated 3-DOF
arm for the hardware test.

## 3. Deployment validation

| Path | What was run | Result |
|---|---|---|
| Scripts | `start_physios.sh` / `stop_physios.sh` (earlier phase) and `python3 -m physios_gateway` | gateway healthy |
| Docker | `docker compose up -d --build` with `PHYSIOS_BASE_IMAGE` set to a locally imported Ubuntu 24.04 + Python 3.12.3 image, against the devstack | container *healthy*, runs as uid 1000, all six service checks OK, sign-in 5/5 |

Docker Hub (and other registries) cannot be reached from the sandbox, so the default base
`python:3.12-slim` was not pulled. The gateway needs only the Python standard library, so the
default base is expected to behave the same; confirm with `./physios-docker.sh up` on the
robot PC.

## 4. Not validated (needs the robot PC)

1. Real SO-101 through PHYSIOS:
   * recording start/stop and saved episodes;
   * camera streams;
   * `/task/status` fields;
   * robot-type switching (requires the Zenoh router before the bringup).
2. Real `lerobot-train` (SmolVLA on the RTX 3050) and an optimisation session from a real
   checkpoint.
3. Real model load (torch + LeRobot), dry run, supervised host rollout at low speed, and
   on-robot inference.
4. The supervised one-joint hardware test on the real arm.
5. `start_physios.sh --with-ros` and the Docker image next to the real containers.
6. Dataset health probe, Hugging Face and GitHub publishing with real accounts.

## 5. Screenshots

`documentation/screenshots/` holds 19 screenshots of 1.1.0, taken against the devstack. The
desktop shots are 1600 × 900 at 100 % zoom; there is also the sign-in screen and phone width
(390 × 844).
