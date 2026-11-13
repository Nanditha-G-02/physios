# RawBot Studio 2.0.0: validation report

Date: 13 November 2026 · Repository `github.com/Nanditha-G-02/physios`, version 2.0.0.

Environment: cloud sandbox (Ubuntu 24.04, Python 3.13, Node 22, Chromium via Playwright),
**no robot, no GPU, no ROS**. All checks ran from a fresh clone, in a folder with no
`physical_ai_tools` checkout anywhere.

This report checks 2.0.0 against the instruction of 13 Nov. RawBot Studio must be a completely
independent project with its own repository, backend, frontend, configuration, dependencies,
Docker setup and execution workflow. It must not need the ROBOTIS `physical_ai_tools`
repository or its `physical_ai_server` / `physical_ai_trainer` backends. Simulated tests
are **not** a claim of completion on hardware; section 4 lists what must be checked on the
robot PC.

## 1. Requirements traceability

| Requirement | Where it is met | Evidence | Status |
|---|---|---|---|
| Own repository, installable from it alone | `git clone` + `scripts/install.sh` | fresh-clone install, start-up, tests (section 2) | met |
| No `physical_ai_tools` checkout needed | nothing refers to a parent folder; no `PHYSIOS_REPO_ROOT` | `test_repository_is_self_contained` | met |
| Own backend instead of `physical_ai_trainer` | `backend/physios_trainer` (the v4 training service, maintained in RawBot Studio) | 91 + 1 skipped unchanged tests; started by `start_physios.sh` | met |
| Own robot backend instead of the ROBOTIS `physical_ai_server` container | `robot/src` (robot server incl. planning engine, interfaces, recorder) + `docker/robot` image `physios-robot` | planning tests 45; Dockerfile check; compose config. Image build and real robot: section 4 | met in code; build and hardware to confirm |
| Own frontend | `frontend/`, built by `install.sh`, served by the gateway | CI build; 26/26, 9/9, 6/6 | met |
| Own configuration | `configuration/physios.env` (`PHYSIOS_DATA_DIR`, robot runtime settings) | `--check-config`; install creates it | met |
| Own data storage | `data/` (`PHYSIOS_DATA_DIR`), shared by all parts at fixed paths | standalone tests; trainer reports `data_root`, container paths | met |
| Own dependencies | host: Python stdlib, Node for the build; robot image: ROS 2 Jazzy, LeRobot pinned in `robot/lerobot.lock` (upstream Hugging Face) | `install.sh` checks; lock test | met |
| Own Docker setup | `docker/gateway`, `docker/robot`, `docker-compose.yml` (+ GPU override), `physios-docker.sh` | gateway container healthy; robot image to build on the PC | met (robot image: section 4) |
| Own execution workflow | `start_physios.sh [--with-robot] [--no-gateway]`, `stop_physios.sh [--robot]`, `physios-docker.sh up [--with-robot]` | start/stop from the fresh clone | met |
| Keep existing data | `scripts/import-legacy-data.py` (copy, hard-link, path rewrite; old checkout untouched) | `test_import_legacy_data` | met (real data: section 4) |
| Keep the interface and the workflow | same pages; instruction texts and container paths updated only | walk-through 26/26 | met |
| No automatic motion at start-up | scripts and containers start services only | code review of `start_physios.sh` and `docker/robot/entrypoint.sh` | met |
| Third-party code credited | `NOTICE`, original headers kept | — | met |

## 2. Automated test results (13 Nov 2026, fresh clone of 2.0.0)

| Suite | Command | Result |
|---|---|---|
| Installation | `./scripts/install.sh` | completed (config, data folder, frontend build, config check) |
| Gateway | `cd backend && python3 -m pytest -q tests` | **22 passed** |
| Training service + standalone layout | `cd backend && python3 -m pytest -q trainer_tests` | **102 passed, 1 skipped** |
| Planning engine | `cd robot/src/physical_ai_server && python3 -m pytest -q test/planning` | **45 passed** |
| Frontend production build | `cd frontend && CI=true npm run build` | **compiled** |
| Whole workflow | `tests/e2e/run_e2e.py http://127.0.0.1:8700` against `tests/e2e/devstack.py` | **26/26** |
| Optimize tab | `tests/e2e/opt_ui_check.py` against `devstack.py --seed` | **9/9** |
| Sign-in | `tests/e2e/auth_e2e.py` | **6/6** |

## 3. Deployment validation

| Path | What was run | Result |
|---|---|---|
| Scripts | `./start_physios.sh` / `./stop_physios.sh` from the fresh clone | gateway and training service started from `backend/`; health lists `physios_trainer 2.0.0`; stopped cleanly |
| Docker, gateway | `./docker/physios-docker.sh up` with `PHYSIOS_BASE_IMAGE` = a locally available Ubuntu 24.04 + Python image | container *healthy*; data folder at `/physios/data` (read-only); dataset roots as documented |
| Docker, robot runtime | `docker build --check` of `docker/robot/Dockerfile`; `docker compose --profile robot config` with `docker-compose.gpu.yml` | no warnings; volumes, devices, environment and GPU reservation as documented. **Not built**: Docker Hub cannot be reached from the sandbox |

## 4. Not validated (needs the robot PC)

1. `./scripts/install.sh --robot`: the first build of `physios-robot:2.0.0`.
2. `./start_physios.sh --with-robot` with the real arm:
   * robot types on Home, including configs in `data/robot-config/`;
   * recording and camera streams;
   * `/task/status`;
   * ROS discovery with the arm's driver (same ROS domain, one Zenoh router).
3. Real `lerobot-train`, real model load; host rollout and container inference with the new
   image.
4. `scripts/import-legacy-data.py ~/lerobot/physical_ai_tools` on the real 1.x data (run with
   `--dry-run` first).
5. Dataset health probe; Hugging Face and GitHub publishing with real accounts.

## 5. Screenshots

`documentation/screenshots/` holds the screenshots of 1.2.0 (1600 × 900, against the
devstack). The interface of 2.0.0 is the same. The only changes are the instruction texts
that named the old folders (training service start command, robot config location, robot
image rebuild).
