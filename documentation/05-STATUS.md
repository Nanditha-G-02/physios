# PHYSIOS: verification status (2026-11-11, version 1.2.0)

## Verified here (PHYSIOS 1.2.0, final build)

| Area | How | Result |
|---|---|---|
| Gateway | `backend/tests/test_gateway.py`: config, path traversal, Range, task-info typing, motion confirmation (428), activity, ROS errors, health, trainer proxy, camera proxy, dataset files/export, SPA serving, `/ros` pipe, sign-in, and the interface's same-origin paths (`/train-api`, `/camera-stream`, `/lerobot-data`, incl. traversal and sign-in) | 22 passed |
| Frontend build | `CI=true npm run build` (lint warnings fail the build) | compiled |
| Frontend unit tests | `react-scripts test` | `imageStats` passes; the stock CRA `App.test.js` suite fails to run, unchanged from the Physical AI Manager |
| Whole workflow in a browser, served by PHYSIOS | `physical_ai_manager/e2e/run_e2e.py http://127.0.0.1:8700` against `tests/e2e/devstack.py`: real PlanningService behind a rosbridge stand-in with a simulated recorder, real pam_trainer with a stub `lerobot-train`, real gateway | 26/26 |
| Optimize tab | `opt_ui_check.py http://127.0.0.1:8700` against `devstack.py --seed` | 9/9 |
| Sign-in | `tests/e2e/auth_e2e.py` (script install and Docker container) | 6/6 and 6/6 |
| Docker | `docker compose up -d --build`, substitute Ubuntu 24.04 + Python 3.12.3 base (Docker Hub unreachable here) | healthy |
| Screenshots | every page, tab and view of 1.2.0 (`documentation/screenshots/`) compared with the robot-PC screenshots of 11 Nov | same pages, tabs and layout; one intended difference (Connected chip beside Robot Type) |
| Back ends unchanged | pam_trainer tests; planning tests | 91 passed, 1 skipped; 45 passed |

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

* **Real ROS / real arm.** Every ROS interaction was exercised against stand-ins. That covers
  the PlanningService code, the rosbridge protocol, topic names from the existing code, and a
  simulated recorder and arm. On the SO-101 itself, check: recording start/stop, camera streams
  via web_video_server, `/task/status` fields, and robot type switching.
* **Real training and model loading.** `lerobot-train` was a stub. The rollout worker could not
  load a model here (no torch/LeRobot), so a real dry run, a real host rollout and on-robot
  inference are unverified through PHYSIOS. The worker and its safety filter are the unchanged
  v4 code.
* **`--with-ros`.** The `docker exec` commands follow the container's documented steps (router
  first, then bringup) but were not run here (no physical_ai_server container in the sandbox). If your bringup launch file has
  another name, start the ROS side manually.
* **Dataset health analysis** runs in a LeRobot environment; the stub could not run it.
* **Hugging Face / GitHub publishing** needs accounts; the UI calls the existing commands.
* **Docker on the robot PC** with the default `python:3.12-slim` base, and next to the real
  physical_ai_server container.

## Known limitations

* No pause/resume for recordings: physical_ai_server has no such command. Stop and Retry
  are offered instead.
* Sign-in is a shared operator token, not per-user accounts. There is no TLS in the gateway: put
  a reverse proxy with HTTPS in front of it on any network you do not trust.
* Custom robots: the generated server config still has to be installed into
  physical_ai_server by hand (unchanged from v4).
* The hardware test is driven by the browser (unchanged from v4). If the tab dies mid-test, the
  last command holds. A wrongly mapped joint is caught in the 0.6 s pre-hold, before the
  intended motion.
* Container inference starts on a single click (the Physical AI Manager's behaviour); the
  typed-confirmation dialog of 1.1.0 is gone with that frontend. Host rollout keeps its two
  confirmations and the worker-side limits.
* With sign-in enabled there is no sign-out button in the interface: call
  `POST /api/v1/auth/logout` or let the session expire.
* The frontend is Create React App (react-scripts 5), as in the Physical AI Manager.
