# PHYSIOS: verification status (2026-11-13, version 2.0.0)

## Verified here (PHYSIOS 2.0.0, from a fresh clone of the repository)

The checks below ran in a folder that has no `physical_ai_tools` checkout anywhere, in a
cloud sandbox without ROS, a GPU or a robot.

| Area | How | Result |
|---|---|---|
| Self-contained repository | `trainer_tests/test_standalone.py`: no code refers to `physical_ai_tools`, `physical_ai_trainer` or a parent folder; data-folder paths; container path mapping; LeRobot lock; data import from a 1.x layout | 5 passed |
| Installation | `scripts/install.sh` in the fresh clone: requirements, `physios.env`, data folder, `npm ci` + build, config check | completed |
| Start-up | `./start_physios.sh`: training service and gateway start from `backend/`; health shows trainer `physios_trainer 2.0.0`, data root `data/`, robot LeRobot `0.2.0` from `robot/lerobot.lock`; `./stop_physios.sh` stops both | OK |
| Gateway | `backend/tests/test_gateway.py` | 22 passed |
| Training service | `backend/trainer_tests` (unchanged v4 tests, now against `physios_trainer`) | 91 passed, 1 skipped (+5 standalone) |
| Planning engine | `robot/src/physical_ai_server/test/planning` | 45 passed |
| Frontend build | `CI=true npm run build` (lint warnings fail the build) | compiled |
| Whole workflow in a browser | `tests/e2e/run_e2e.py http://127.0.0.1:8700` against `tests/e2e/devstack.py`: real PlanningService from `robot/src` behind a rosbridge stand-in with a simulated recorder, real training service with a stub `lerobot-train`, real gateway | 26/26 |
| Optimize tab | `tests/e2e/opt_ui_check.py` against `devstack.py --seed` | 9/9 |
| Sign-in | `tests/e2e/auth_e2e.py` | 6/6 |
| Gateway container | `./docker/physios-docker.sh up` with a substitute Ubuntu 24.04 + Python base (Docker Hub is unreachable here) | healthy; data folder at `/physios/data` |
| Robot image and compose | BuildKit checks of `docker/gateway/Dockerfile` and `docker/robot/Dockerfile`; `docker compose --profile robot config` with the GPU override | no warnings; mounts and environment as documented |
| Python sources | `compileall` of `backend`, `robot/src`, `scripts`, `tests` | OK |

The 26 steps:
* Home lists robot types.
* Planning: create, define the task, Dynamic configuration, the six planning types, generate,
  edit one episode, validate, fix, approve.
* Record:
  * plan-mode takes, auto-advance;
  * review off and on (reject, retake, approve); skip needs a reason;
  * Processed and Simulation views; free recording.
* Data:
  * overview with the plan link; episode viewer with video and timelines; processed playback;
  * review and delete; publish panel; Tools tab.
* Training: dataset hand-over, command reviewed and confirmed.
* Inference panel with the plan-instruction helper; plan progress in Planning.

## Not verified (needs the robot PC)

* **Building the robot image.** `docker/robot/Dockerfile` follows the recipe of the 1.x robot
  container: same base image, LeRobot commit and install steps, and colcon build. It was not
  built here, because Docker Hub cannot be reached from the sandbox. Build it once on the
  robot PC: `./scripts/install.sh --robot`.
* **The robot runtime with the real arm.** Every ROS interaction was exercised against
  stand-ins: the PlanningService code, the rosbridge protocol, topic names from the code, and
  a simulated recorder and arm. On the SO-101, check:
  * that the robot types (including your config in `data/robot-config/`) appear on Home;
  * recording start/stop and camera streams;
  * `/task/status`;
  * that the robot runtime and the arm's driver see each other (same ROS domain, one Zenoh
    router).
* **Real training and model loading.** `lerobot-train` was a stub. The rollout worker could
  not load a model here (no torch/LeRobot). A real host rollout and on-robot inference
  through the new image are therefore unverified.
* **Data import on the real 1.x installation.** It was tested on a synthetic copy of the 1.x
  layout. Run it with `--dry-run` first on the robot PC.
* **Dataset health analysis** runs in a LeRobot environment; the stub could not run it.
* **Hugging Face / GitHub publishing** needs accounts.

## Known limitations

* No pause/resume for recordings: physical_ai_server has no such command. Stop and Retry
  are offered instead.
* Sign-in is a shared operator token, not per-user accounts. There is no TLS in the gateway: put
  a reverse proxy with HTTPS in front of it on any network you do not trust.
* Custom robots: the generated server config is saved into `data/robot-config/` by hand,
  then the robot runtime is restarted.
* The hardware test is driven by the browser (unchanged from v4). If the tab dies mid-test, the
  last command holds. A wrongly mapped joint is caught in the 0.6 s pre-hold, before the
  intended motion.
* Container inference starts on a single click (the Physical AI Manager's behaviour); the
  typed-confirmation dialog of 1.1.0 is gone with that frontend. Host rollout keeps its two
  confirmations and the worker-side limits.
* With sign-in enabled there is no sign-out button in the interface: call
  `POST /api/v1/auth/logout` or let the session expire.
* The frontend is Create React App (react-scripts 5), as in the Physical AI Manager.
