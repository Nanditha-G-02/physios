# PHYSIOS: verification status (2026-11-11)

## Verified here

| Area | How | Result |
|---|---|---|
| Gateway | `backend/tests/test_gateway.py`: config, path traversal, Range, task-info typing, motion confirmation (428, nothing reaches ROS), activity, unreachable/missing/timeout ROS errors, health, trainer proxy (pass-through errors, Origin, upload, X-Forwarded-Host), camera proxy, dataset files/export, SPA serving, `/ros` WebSocket pipe | 20 passed (incl. sign-in: sessions, Bearer, rate limit, expiry, remote binding needs a token) |
| Hardware-test sequencer (ported) | `frontend/src/lib/hardwareTest.test.ts` against a simulated servo: correct direction and distance, other joints held, inverted joint caught in pre-hold with no motion samples, STOP ends publishing, missing joint refused | 4 passed (+4 helper tests) |
| Type safety / build | `tsc --noEmit` (strict), `vite build` | clean |
| Whole application in a browser | `tests/e2e/physios_e2e.py` against `devstack.py`: real PlanningService behind a rosbridge stand-in with a simulated recorder, real pam_trainer with a stub `lerobot-train`, real gateway; plus a simulated 3-DOF arm behind a second gateway | all 14 steps OK (below) |
| Start/stop | `start_physios.sh` started the trainer and gateway, reported health with hints when ROS/camera were down, printed the URL; `stop_physios.sh` stopped both; non-loopback host refused | OK |
| Existing back ends unchanged | pam_trainer tests 91 passed/1 skipped; planning tests 45 passed; `git diff 169333b` outside `physios/` = `.gitignore` only | OK |

E2E steps:

1. Home: six live service checks OK in the overview.
2. Home: robot selected and confirmed on physical_ai_server; workflow unlocked.
3. Planning: create, generate, validate, apply fixes, approve, activate.
4. Recording: plan-mode take through `/task/command`, review, accept.
5. Datasets: library, video playback through the gateway, reject an episode, gzip export.
6. Training: wizard, exact command, token start, finished.
7. Optimisation: divergence diagnosed, trials planned, session created, control trial launched; a run without an environment is refused.
8. Evaluation: robot trial recorded.
9. Inference: compatibility and envelope from the recorded data, dry-run load. It fails because no torch is installed here, and the UI shows the worker log.
10. Rollout: readiness, compatibility, editable envelope.
11. Robots: zip upload, validation, register, 3D view.
12. Robots: configuration, ROS checks (Stage 2), live joints, authorised one-joint test (Stage 3). 110 commands, none before Start; other joints held.
13. Disconnected states.
14. Settings: effective configuration.

The UI was restyled on 2026-11-11 to the Physical AI Manager design (tokens, rail, Home,
workbench and console layouts, Training and Inference tabs). The e2e above was re-run on the
restyled UI; side-by-side screenshots against the old UI were compared for Home, Record,
Data, Planning, Training and Inference.

| Sign-in in a browser | `tests/e2e/auth_e2e.py` against a gateway with `PHYSIOS_AUTH_TOKEN` | 5/5 (401 without session, login screen, wrong token refused, sign-in loads Home, sign-out) |
| Docker | image built from `docker/Dockerfile` with `docker/docker-compose.yml` (host network, non-root uid 1000, read-only mounts); health check reported *healthy*; all six service checks OK against the devstack; sign-in walk-through 5/5 against the container | OK, but on a substitute base (Ubuntu 24.04 + Python 3.12.3 imported locally) because Docker Hub is not reachable from this sandbox; the default `python:3.12-slim` base was not pulled here |
| v4 back ends unchanged | `physical_ai_trainer` pytest; `physical_ai_server/test/planning` | 91 passed, 1 skipped; 45 passed |
| Old UI (http://localhost) with the compact theme patch | `physical_ai_manager/e2e/run_e2e.py`, CRA build with CI=true | 26/26; compiled |

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

* No pause/resume for recordings: physical_ai_server has no such command. Stop and Re-record
  are offered instead.
* Sign-in is a shared operator token, not per-user accounts. There is no TLS in the gateway: put
  a reverse proxy with HTTPS in front of it on any network you do not trust.
* Custom robots: the generated server config still has to be installed into
  physical_ai_server by hand (unchanged from v4).
* The hardware test is driven by the browser (unchanged from v4). If the tab dies mid-test, the
  last command holds. A wrongly mapped joint is caught in the 0.6 s pre-hold, before the
  intended motion.
* The frontend bundle includes three.js (≈630 kB, loaded only by Robot Management).
