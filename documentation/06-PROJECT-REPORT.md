# PHYSIOS and Physical AI Platform v4: Project Report

Date: 11 November 2026
Repository: `physical_ai_tools` (ROBOTIS, Apache-2.0), branch `physical-ai-manager-v2`
Upstream base: `dcaa3ab` (ROBOTIS v1.0.0 with rmw_zenoh, 30 October 2026)
Current head: `f087aaa`

---

## 1. Summary

The project builds a full imitation-learning workstation around the SO-101 arm. You plan
demonstrations, record them with the leader arm, review the data, train a policy on the robot
PC, test it and run it on the robot under supervision. The reference task is picking up a cube
and placing it in a tray. 39 demonstrations exist (`NandithaaaG/s101_dataset_red_cube`).
SmolVLA, fine-tuned on that data, reproduces the demonstrations offline and reaches the cube
on the real robot.

The software has gone through three stages:

| Stage | Date | What it delivered | Where |
|---|---|---|---|
| Physical AI Manager v2 → v3 | 2–3 Nov | Planning, plan-driven recording, data review, local training, host rollout, evaluation log, dataset health, queue, storage | inside the old UI and `physical_ai_trainer`; consolidated in commit `492cf5b` |
| **Physical AI Platform v4** (five phases) | 5 Nov | Training optimisation and custom robots | `pam_trainer` and the old UI, commits `3232e50` … `169333b` |
| **PHYSIOS** | 6–11 Nov | A standalone application ("The Operating System for Physical Intelligence") with its own server and frontend. It reuses every back end unchanged and matches the Physical AI Manager's look and layout. | `physios/`, commits `ec8fbb2` … `f087aaa` |

Everything is committed locally. The commits are **not pushed**: the sandbox cannot write to
the ROBOTIS repository, so a push needs your own fork. **Nothing has been verified on the real
robot or with a real GPU training yet** (section 9).

---

## 2. Background: the v3 baseline (commit `492cf5b`)

`492cf5b "Restore v3 baseline"` holds all v2, v2.1, v2.2 and v3 work on top of upstream: 97
files, +23,874 / −647 lines.

* **v2 (2 Nov).**
  * Sessions Home → Planning → Record → Data → Training → Inference.
  * The planning engine (`physical_ai_server/planning`) with validation, versioning and plan
    activation.
  * Plan-mode recording.
  * A dataset library with review, deletion and publishing.
* **v2.1.**
  * Home with robot tiles and a workflow strip.
  * Redesigned record control bar.
  * Optional episode review (Approve / Reject / Decide later).
* **v2.2 (3 Nov).**
  * A design language based on your reference video: grey canvas with glows, white rounded
    cards, black capsules, light numerals and fading headlines.
  * A training session with a five-step wizard and a run monitor.
  * The `physical_ai_trainer` (`pam_trainer`) host service on 127.0.0.1:8766: standard-library
    Python, confirm tokens, one run at a time.
* **v3 (3 Nov).**
  * Host rollout of host-trained models, with the worker enforcing the joint envelope, step
    and lead caps, stale-data and heartbeat holds, a duration limit and E-stop.
  * Evaluation log with success rate and 95% confidence interval.
  * Camera match check, dataset health report, targeted re-collection plans, grasp-phase
    markers, run comparison, training queue, disk guard and protected cleanup.

---

## 3. Physical AI Platform v4: the five development phases

Changes since the v3 baseline: 46 files, +10,373 / −12 lines. **`physical_ai_server`, and
with it every SO-101 configuration, has zero changes.**

| Phase | Scope | Commit | Size | Status |
|---|---|---|---|---|
| 1 | Training monitoring, problem detection, capability-aware recommendations, optional validation loss, comparison dashboard | `3232e50` | 14 files, +2,066 | Done, tested |
| 2 | Controlled optimisation sessions (control + trials from a checkpoint), manual/automatic modes with budgets, run monitor, history | `9bed04d` | 14 files, +2,361 | Done, tested |
| 3 | Custom robots: safe upload, safe Xacro, URDF validation, 3D viewer, robot library | `27874ef` | 23 files, +3,561 | Done, tested |
| 4 | Robot configuration, ROS checks, supervised one-joint hardware test, staged readiness | `9502fc3` | 8 files, +2,187 | Done, tested against a simulated arm |
| 5 | Integration and regression: SO-101 workflow, SmolVLA path, earlier phases | `4c2a835`, `169333b` | 7 files, +221 | Done |

### Phase 1: training monitoring and recommendations (`3232e50`)

* **Live metrics:** train loss, held-out validation loss, learning rate, gradient norm, GPU
  memory, step time, epoch duration and a stability score. These are parsed from LeRobot's
  real log format, including `nan`/`inf`.
* **Optional validation loss:** adds `--dataset.eval_split` and `--eval_steps` only when the
  installed LeRobot accepts them, and shows how many episodes are held out.
* **Problem detection,** each with severity, evidence and a suggested action: NaN/inf loss,
  loss explosion (with onset step), gradient explosion, stagnation, overfitting (validation
  rising while training falls), excessive clipping, GPU memory pressure/OOM, slow training,
  and data-loading bottlenecks.
* **Recommendations follow the model's capabilities,** read from `lerobot-train --help` for
  the chosen policy. Levers the model does not support are shown as unavailable. LeRobot has
  no gradient-accumulation flag, so it is reported as unsupported. SmolVLA levers: learning
  rate, weight decay, grad-clip norm, scheduler warm-up/decay, batch size, mixed precision.
* **Comparison dashboard:** training metrics and robot results are kept apart. A
  recommendation is labelled robot-based only when at least 3 robot trials have been
  evaluated.
* **New modules:** `pam_trainer/diagnostics.py` (+312) and `tuning.py` (+259). Changed:
  `runner.py` (NaN/inf parsing), `planner.py` (validation flags), and the Optimize tab in the
  UI.

### Phase 2: controlled trials and sessions (`9bed04d`)

* **Starting point:** each session picks the latest usable checkpoint from before the problem
  began. From it, a **control** run (unchanged settings) and up to 3 **trials** start, each as
  a separate run.
* **Running jobs are never touched.** Trials load weights only
  (`--policy.path=<ckpt>/pretrained_model`), so optimizer states are never mixed, and the
  original run folder is verified byte-for-byte unchanged.
* **Threshold:** a change is recommended only if it beats the control by at least 5%;
  otherwise the advice is "keep original".
* **Manual and automatic modes:**
  * Settings: maximum trials, GPU-time budget, maximum duration per trial, target loss, early
    stopping (patience) and auto-restart permission.
  * Manual mode starts nothing until you launch each trial.
  * Automatic mode needs an acknowledgement after you review the command.
  * Only one training runs at a time.
* **Run monitor ("Watch this run"):** Off / Flag problems / Stop on problem / Stop and try
  fixes. The Stop modes need a permission tick, and a critical problem must persist for two
  checks before anything acts.
* **Next run:** a reviewed command to continue from the winning checkpoint with the winning
  settings.
* **New module:** `optimizer.py` (+833), storing sessions under `<data_dir>/optimization/`.
* **Bugs found and fixed:**
  * JSON turned 1.0 into 1, which changed the command after it had been reviewed.
  * The time budget under-counted trials shorter than 1 s.

### Phase 3: custom robot upload and validation (`27874ef`)

* **Robots page** (Custom Robot Library), plus a "+ Add Custom Robot" tile on Home.
* **Safe uploads:** allow-listed file types (ZIP, .urdf, .xacro, meshes, folders), no path
  escape, symlinks skipped, size/count/compression-ratio limits, and remote mesh URLs never
  fetched.
* **Safe Xacro expander:** it never runs Python and never reads the machine.
  * Supported: properties, args, macros, includes from inside the upload, if/unless,
    `$(find)`, arithmetic.
  * Rejected with a clear message: `$(env)`, `$(eval)`, `__import__`, file access and macro
    bombs.
* **URDF validation:** reported as passed / warnings / errors / notes, each with a suggested
  fix.
  * Structure: XML syntax, unique links and joints, joint types, parent/child links that
    exist, one parent per link, a single base link, loops and disconnected parts.
  * Limits, axes and mimic joints; degrees-vs-radians and millimetre units.
  * Missing meshes; mass and inertia sanity.
* **3D viewer (three.js):** rotate, zoom and pan; joint tree; click a part to see its link
  information; overall size; link frames; joint sliders that move the picture only.
* **New modules:** `robots/archive.py`, `xacro.py`, `urdf.py`, `store.py`. Profiles are stored
  under `<data_dir>/robots/<id>/`.

### Phase 4: configuration and staged readiness (`9502fc3`)

* **Robot configuration** (all validated): ROS distro and namespace, joint-state topic,
  command interface (JointTrajectory or Float64MultiArray), leader topic, driver, control
  frequency, joint-to-motor mapping (motor ID, direction, offset, units, soft limits),
  calibration, cameras and safety velocities.
* **Progressive unlocking:**
  1. **URDF registered:** possible only with no validation errors.
  2. **ROS verified:** read-only checks over rosbridge (topics and types, a JointState rate of
     at least 5 Hz with every mapped joint, camera frames). The server checks this evidence.
  3. **Hardware verified:**
     * You press Connect, tick the four-item checklist and type the robot name.
     * The server then issues a single-use, 180-second plan: at most 0.1 rad, at no more than
       0.2 rad/s, toward mid-range.
     * You press Start. A pre-hold catches a wrong direction or offset before any motion is
       intended, and a STOP button is always available.
     * The server judges the recorded samples.
  4. **Data and training ready:** the state/action layout and cameras are checked against the
     SmolVLA, ACT, Diffusion and pi0 rules.
* **Stages are withdrawn when their inputs change.** Changing topics withdraws Stage 2 onward;
  changing the mapping, limits or calibration withdraws Stage 3 onward; replacing the URDF
  resets the robot to Draft.
* **Export:** from Stage 3, a physical_ai_server config file can be exported. A custom robot
  type can be confirmed on Home only at Stage 3 or higher.
* **New module:** `robots/readiness.py` (+569).

### Phase 5: integration and regression (`4c2a835`, `169333b`)

* The original SO-101 workflow, Home → Planning → Record → Data → Training → Inference, was
  re-run in a browser: 26/26 steps.
* The SmolVLA path and every earlier phase were re-checked.
* A browser check of the validation toggle and of the run monitor stopping a diverging run
  (step 280 of 400) only after permission.

---

## 4. PHYSIOS: renaming, then a standalone application

### 4.1 Renaming changes

1. **The first request** (6 Nov) was to rename "Physical AI Manager" to "PHYSIOS: The
   Operating System for Physical Intelligence". `physios_rename.patch` (3 files, on top of
   v4) changed only the old UI:
   * `physical_ai_manager/public/index.html`: title `PHYSIOS`, new meta description.
   * `public/manifest.json`: `name` and `short_name` set to `PHYSIOS`.
   * `src/pages/HomePage.js`: heading "PHYSIOS", tagline "The Operating System for Physical
     Intelligence."
2. **The PHYSIOS brief** then asked for a full, independent operating system, and explicitly
   ruled out a simple rename of the old frontend. The rename patch was therefore
   **superseded and dropped**:
   * The old application keeps its name "Physical AI Manager" and stays available as a
     fallback on port 80.
   * If the rename patch was applied on the robot PC, undo it with
     `git apply -R physios_rename.patch`.
3. **PHYSIOS carries the name itself:**
   * Browser tab title "PHYSIOS", favicon and manifest.
   * Home headline "PHYSIOS" with "The Operating System for Physical Intelligence".
   * Its own start/stop scripts (`start_physios.sh`, `stop_physios.sh`), gateway
     (`physios_gateway`), configuration (`PHYSIOS_*` variables) and documentation.

### 4.2 Architecture

```
Browser ── PHYSIOS frontend (physios/frontend, served by the gateway)
              │ /api/v1 (REST)      │ /ros (WebSocket)
              ▼                     ▼
         PHYSIOS gateway (physios/backend, 127.0.0.1:8700)
           ├─ rosbridge adapter ──► physical_ai_server (ROS 2 Jazzy, rmw_zenoh)
           ├─ trainer proxy ──────► pam_trainer (127.0.0.1:8766)
           ├─ camera proxy ───────► web_video_server (:8080)
           └─ dataset files ──────► LeRobot folders (read-only)
```

* **Gateway** (`physios/backend/physios_gateway`). Python standard library only; no packages,
  no virtualenv.
  * `adapters/ws.py`: RFC 6455 WebSocket client.
  * `adapters/rosbridge.py`: persistent rosbridge client with reconnection.
  * `adapters/datasets.py`: dataset files with HTTP Range support, plus streamed `.tar.gz`
    export (read-only).
  * `services/ros_api.py`: typed physical_ai_server operations. Inference must carry
    `confirm: true`, otherwise the gateway answers HTTP 428 and nothing reaches ROS.
  * `services/health.py`: real checks of every dependency.
  * `services/system.py`: host metrics, reusing `pam_trainer.environment` and adding CPU %.
  * `services/activity.py`: persistent activity feed.
  * Binds to loopback only, unless you set `PHYSIOS_ALLOW_REMOTE=1`.
* **Frontend** (`physios/frontend`). Vite + React 18 + TypeScript (strict). The only
  dependencies are react, react-dom, three and the Geist fonts. There is no router, state,
  chart or UI library.
* **Reused unchanged:** physical_ai_server (planning engine, recorder, inference),
  physical_ai_interfaces, pam_trainer, web_video_server, LeRobot, the dataset format and every
  storage location.
* **Ported as logic, not UI:** the URDF → three.js loader and the safety-critical one-joint
  hardware-test sequencer (same algorithm and thresholds).
* **Added because no back end had it:** CPU %, dataset export and live-topic WebSocket
  piping.

### 4.3 Design: matching the Physical AI Manager (11 Nov, `f087aaa`)

PHYSIOS was restyled to look and feel exactly like the existing Physical AI Manager:

* **Tokens:**
  * Paper greys `#F3F4F6`, `#ECEEF1`, `#E1E4E8`.
  * Ink `#0B0C0E`, `#3A3E45`, `#7E848D`, `#B4B9C1`.
  * Sky accents `#D6E3FF` and `#2457E6`.
  * Signal colours: green `#1F8A55`, orange `#C2410C`, red `#C42B2B`.
  * 22 px card radius, pill buttons and chips, Geist Sans and Geist Mono.
  * Light theme only, as in the old UI.
* **Components:** white sheets with soft shadows; black primary and sky-blue secondary
  buttons; segmented tabs with a black active pill; black toggles; tinted callouts; black
  pill toasts at the top centre.
* **Sidebar:**
  * A 96 px rail with numbered steps: 01 Home, 02 Planning, 03 Record, 04 Data, 05 Training,
    06 Inference, R Robots.
  * A black capsule marks the current page, and green ticks mark earlier steps.
  * The guard toast "Select and confirm a robot on Home first." blocks pages that need a
    robot.
  * The rail foot holds the Link/Robot status, services, notifications and settings.
* **Page layouts:**
  * *Home:* robot drawing, robot selection card with Confirm, three status boxes, "Continue
    to Planning", six workflow tiles, and the service overview below.
  * *Planning and Data:* workbench layout, with a white list sheet ("Sheet 02 / Collection
    plans", "Sheet 04 / Datasets") on the left and details on the right. A dataset opens on
    an Overview tab with "Train with this dataset".
  * *Record and Inference:* console layout.
    * Robot Type card and Connected chip at the top left.
    * Cameras in the middle.
    * A white side sheet on the right with the plan, the episode squares and the
      instruction.
    * A bottom control bar with big square buttons, status, a progress ring and CPU/RAM/DISK.
  * *Training, Robots, Settings:* hero header ("05 · Training", light fading title, grey
    intro, chips and tabs on the right).
* **Navigation:**
  * Training holds tabs for New training, Runs, Queue, Optimize, Evaluate, Compare and
    Storage.
  * Inference holds tabs for Model check (dry run), Host rollout and Container inference.
  * The old addresses `/optimization`, `/evaluation` and `/rollout` were replaced by
    `/training/optimize`, `/training/evaluate` and `/inference/rollout`.

---

## 5. Implemented features (PHYSIOS, current)

| Module | What you can do | Back end |
|---|---|---|
| 01 Home | select and confirm the robot type (built-in and custom), see link/robot status, follow the six workflow steps, see the service overview (six live checks, hardware, recent activity) | physical_ai_server `/set_robot_type`, gateway health |
| 02 Planning | create, generate, validate and fix, approve, version and activate collection plans; workspace view of item placements | planning `plan.*` |
| 03 Record | plan-mode takes (Start/Retake, Stop, Retry, Next, Finish), skip/restore episodes, live cameras, follower joints, topic liveness, optional episode review after each take, free recording with your own task settings | `/task/command`, `/task/status`, planning `record.*`, `data.review` |
| 04 Data | dataset library, overview with review progress, episode table, episode viewer with video, accept/reject, validation, Hugging Face / GitHub publishing, `.tar.gz` export | planning `data.*`, gateway dataset files |
| 05 Training | five-step wizard with the exact command shown and token-confirmed start, run monitor and logs, checkpoints, queue, storage, comparison | pam_trainer |
| 05 · Optimize | diagnose a run, plan trials from a pre-problem checkpoint, manual/automatic sessions, history | pam_trainer optimizer |
| 05 · Evaluate | record robot trials per checkpoint; success rate with confidence interval | pam_trainer evaluations |
| 06 · Model check | compatibility check and dry-run load: the model reads live cameras and joints, its output goes through the safety filter, nothing is sent to the robot | pam_trainer rollouts |
| 06 · Host rollout | readiness checklist, editable joint envelope (only tighter than the training data), Load (no motion) → Run (checklist + typed `run`), Pause, Stop, E-STOP, outcome logging | pam_trainer rollout worker |
| 06 · Container inference | run a policy saved on the robot side (ROBOTIS inference) after a checklist and typed `run` | `/task/command` START_INFERENCE with `confirm` |
| R Robots | custom robot library, upload wizard, validation report, 3D viewer, configuration, ROS checks, supervised one-joint hardware test, readiness stages | pam_trainer robots |
| Settings | effective configuration, review setting, service details | gateway config |

### Safety rules (unchanged by the restyle)

The robot moves **only** after an explicit operator action:

* Start take: recording, with you driving the follower through the leader arm.
* Run: host rollout, after the readiness checks, a checklist and typed `run`.
* Start: container inference, after a checklist and typed `run`; the gateway also enforces
  `confirm: true`.
* Start motion: the one-joint hardware test, using a server-issued single-use plan.

Starting PHYSIOS never moves the robot or starts a rollout. A software stop holds position; it
is not a hardware emergency stop, so keep the power switch or a hardware e-stop within reach.

---

## 6. Testing results

### 6.1 Current (11 November 2026, restyled PHYSIOS, commit `f087aaa`)

| Suite | Covers | Result |
|---|---|---|
| Gateway pytest (`physios/backend/tests`) | config, path traversal, Range, task-info typing, motion confirmation (HTTP 428, nothing reaches ROS), activity, ROS errors (unreachable/missing/timeout), health, trainer proxy, camera proxy, dataset files and export, SPA serving, `/ros` pipe | **17 passed** |
| Frontend vitest | hardware-test sequencer against a simulated servo (direction and distance, other joints held, inverted joint caught in the pre-hold, STOP, missing joint refused), plus helper tests | **8 passed** |
| `tsc --noEmit` (strict) + `vite build` | type safety and production build | **clean** |
| Browser walk-through (`tests/e2e/physios_e2e.py` against `devstack.py`) | real PlanningService behind a rosbridge stand-in with a simulated recorder; real pam_trainer with a stub `lerobot-train`; real gateway; simulated 3-DOF arm | **14/14 steps OK** |
| Visual comparison | screenshots of Home, Record, Data, Planning, Training and Inference compared side by side with the old Physical AI Manager | matches |

The 14 walk-through steps:

1. Home: six live service checks OK.
2. Home: robot selected and confirmed on physical_ai_server; workflow unlocked.
3. Planning: plan created, generated (4 episodes), validated, fixes applied, approved,
   activated.
4. Record: plan-mode take through `/task/command`, reviewed and accepted.
5. Data: the new dataset is listed, video plays through the gateway, the review is saved, and
   the export is a gzip.
6. Training: wizard → exact command reviewed → started with the preview token → finished.
7. Optimise: divergence diagnosed, trials planned from a checkpoint, session created, control
   trial launched; a run without an environment is refused.
8. Evaluate: robot trial recorded; success rate with a confidence interval.
9. Inference: compatibility and safety envelope from the recorded data, dry-run load. The
   load fails honestly because there is no torch in the sandbox, and the worker log is shown.
10. Host rollout: readiness, compatibility, editable envelope; nothing moves before Run.
11. Robots: ZIP upload → validation → registered → 3D model.
12. Robots: configuration → ROS checks (Stage 2) → live joints → authorised one-joint test
    (Stage 3). 110 commands, none before Start; other joints held.
13. Disconnected states: each module shows the back end's own hint, never empty or fake data.
14. Settings: effective configuration from the gateway.

### 6.2 v4 (5 November 2026)

| Suite | Result |
|---|---|
| physical_ai_trainer pytest (trainer, optimisation, sessions, robots, readiness, HTTP) | 91 passed, 1 skipped |
| physical_ai_server planning tests | 45 passed |
| Old-UI SO-101 workflow (`e2e/run_e2e.py`) | 26/26 |
| Optimize tab (`opt_ui_check.py`) | 9/9 |
| Optimisation sessions (`opt_sessions_check.py`) | 10/10 |
| Validation toggle + run monitor (`opt_watch_validation_check.py`) | 6/6 |
| Robots (`robots_check.py`): upload, validation, viewer, malicious Xacro refused, persistence | 12/12 |
| Readiness (`robots_readiness_check.py`): zero commands before Start, STOP, stage withdrawal, inverted joint caught | 11/11 |
| CRA build with CI=true | compiled |
| jest | imageStats passes; the stock `App.test.js` fails as it already did at v3 |

The v4 back ends are unchanged by PHYSIOS: `git diff 169333b` outside `physios/` touches only
`.gitignore`.

---

## 7. Git commits

Branch `physical-ai-manager-v2`: 11 commits on top of upstream `main`, none pushed.

| Commit | Date | Message | Size |
|---|---|---|---|
| `492cf5b` | 2026-11-05 | Restore v3 baseline | 97 files, +23,874 / −647 |
| `3232e50` | 2026-11-05 | Phase 1: training diagnostics, capability-aware recommendations, validation option, comparison dashboard | 14 files, +2,066 / −5 |
| `9bed04d` | 2026-11-05 | Phase 2: optimisation sessions (control + trials from a checkpoint), manual/automatic modes with budgets, run monitor, history | 14 files, +2,361 / −9 |
| `27874ef` | 2026-11-05 | Custom robots (Phase 3): safe upload, URDF validation, 3D viewer, library | 23 files, +3,561 / −8 |
| `9502fc3` | 2026-11-05 | Custom robots (Phase 4): configuration, ROS checks, supervised hardware test, staged readiness | 8 files, +2,187 / −8 |
| `4c2a835` | 2026-11-05 | Phase 5: integration and regression checks | 6 files, +76 / −5 |
| `169333b` | 2026-11-05 | e2e: browser check of the validation toggle and the run monitor (Stop on problem) | 1 file, +145 |
| `ec8fbb2` | 2026-11-06 | PHYSIOS gateway: independent application server and /api/v1 over the existing services | 17 files, +1,709 |
| `a0a2275` | 2026-11-06 | PHYSIOS frontend: new application shell, design system and all ten modules | 37 files, +8,377 / −3 |
| `afb4d61` | 2026-11-06 | PHYSIOS: tests, start/stop scripts, configuration and documentation | 18 files, +1,476 / −12 |
| `f087aaa` | 2026-11-11 | PHYSIOS: adopt the Physical AI Manager design language and layouts | 30 files, +1,716 / −1,110 |

The report commit that adds this file follows `f087aaa`.

### Deliverables

| File | Contents | Apply on |
|---|---|---|
| `physical_ai_tools_v4_full.patch` | upstream → v4 (`dcaa3ab..169333b`), 133 files | a clean upstream checkout |
| `physical_ai_tools_v4_incremental_from_v3.patch` | v3 → v4 (`492cf5b..169333b`), 46 files | a v3 checkout |
| `physios.patch` | v4 → PHYSIOS (binary-safe), only `physios/` and `.gitignore` | v4 (`169333b`); the robot PC is already there |
| `physios.zip` | the `physios/` folder including the built frontend (no Node.js needed) | unzip into `physical_ai_tools/` |
| `physios_rename.patch` | superseded; do not apply (undo with `git apply -R`) | — |

Apply exactly one of the two v4 patches. Applying both fails with "already exists in working
directory". On 5 Nov the robot PC confirmed v4 is fully applied.

---

## 8. Installing the latest version on the robot PC

```bash
cd /home/ihub/lerobot/physical_ai_tools
unzip -o ~/Nanditha/AI/physicalai/physios.zip      # or: git apply physios.patch
cd physios
./stop_physios.sh
./start_physios.sh --with-ros                      # open http://127.0.0.1:8700
```

* `--with-ros` starts the Zenoh router and then the physical_ai_server bringup inside the
  container, if they are not already running. It does not move the robot.
* If pam_trainer is already running on 8766, PHYSIOS uses it ("Address already in use" only
  means a second copy was started).
* The old Physical AI Manager container on port 80 is independent; keep it as a fallback.

Common fixes seen on the robot PC:

| Symptom | Cause | Fix |
|---|---|---|
| "Cannot reach physical_ai_server (rosbridge on port 9090)" | bringup not running | `./start_physios.sh --with-ros`, or in the container: `ros2 run rmw_zenoh_cpp rmw_zenohd`, then `ros2 launch physical_ai_server physical_ai_server_bringup.launch.py` |
| "Service /get_robot_types does not exist" | Zenoh router missing, so nodes cannot see each other | start the router **first**, then restart the bringup |
| Training/Inference "service offline" | pam_trainer not running | `./start_physios.sh` starts it; check with `curl 127.0.0.1:8766/api/health` |

---

## 9. Pending tasks

### On the real robot (highest value)

- [ ] Install the latest `physios.zip` on the robot PC and confirm Home, Record, Data,
      Training and Inference against the real services.
- [ ] Bring up the ROS side with the Zenoh router first, so that rosbridge (9090) and
      `/get_robot_types` answer.
- [ ] Verify through PHYSIOS on the SO-101:
  - [ ] recording start/stop
  - [ ] camera streams via web_video_server
  - [ ] `/task/status` fields (phase, timers, CPU/RAM/disk)
  - [ ] robot type switching
- [ ] Run one real SmolVLA training with validation on, and one optimisation session from a
      real checkpoint. Compare step time and memory with the dashboard.
- [ ] Do a real dry-run model load and a supervised host rollout at low speed, with the
      hardware e-stop in reach.
- [ ] Run the supervised one-joint hardware test on the real arm (the SO-101 follower as a
      custom profile) with low controller velocity limits.
- [ ] Check that the leader-arm controller board (reported dead on 2 Nov, 5B14111828) has been
      replaced before recording.

### For the task itself (cube pick-and-place)

- [ ] Match the camera conditions to training: position, resolution, brightness, colour (the
      camera match check helps here).
- [ ] Record more demonstrations, using targeted re-collection plans built from failed trials.
- [ ] Log robot trials in Evaluate to get a real success rate per checkpoint.

### Not yet exercised

- [ ] `start_physios.sh --with-ros` docker exec steps (no Docker in the sandbox).
- [ ] Dataset health probe in a real LeRobot environment.
- [ ] Hugging Face and GitHub publishing with real accounts.

### Repository

- [ ] Push branch `physical-ai-manager-v2` to your fork (for example
      `<your-user>/physical_ai_tools`), then open a pull request. The sandbox has no write
      access to `ROBOTIS-GIT/physical_ai_tools`.

### Optional improvements

- [ ] Install the exported custom-robot server config automatically (today it is copied into
      `physical_ai_server/config/` by hand).
- [ ] Block Training on Stage 4 for custom robots (today it is advisory).
- [ ] A watchdog so a hardware test interrupted by a closed tab sends a final hold.
- [ ] Authentication, if PHYSIOS should ever be reachable beyond localhost.
- [ ] Load three.js (≈630 kB) more lazily; today it loads only on the Robots page.

### Known limitations

* No pause/resume for recordings, because physical_ai_server has no such command. Stop and
  Retry are offered instead.
* Models trained on the host (LeRobot 0.6.2) cannot be loaded by container inference (LeRobot
  0.2.0). Run them with Host rollout.
* Xacro support is a safe subset. Expand complex files with `xacro` once and upload the URDF.
* The 3D viewer renders STL, DAE and OBJ; GLB/GLTF meshes appear as markers.

---

## 10. Documentation index

| File | Contents |
|---|---|
| `physios/README.md` | overview, quick start, modules, safety |
| `physios/documentation/01-ANALYSIS.md` | repository and patch analysis, dependency map |
| `physios/documentation/02-ARCHITECTURE.md` | architecture, design system and navigation, module map, safety model |
| `physios/documentation/03-API.md` | gateway API (`/api/v1`, `/ros`) |
| `physios/documentation/04-OPERATIONS.md` | install, configure, run, troubleshoot, test |
| `physios/documentation/05-STATUS.md` | what was verified, how, and what was not |
| `physios/documentation/06-PROJECT-REPORT.md` | this report |
| `physical_ai_trainer/README.md` | trainer service, optimisation, robots |
| `physical_ai_manager/PLANNING_AND_DATA.md` | planning, recording and data (old UI) |
