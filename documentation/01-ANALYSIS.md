# PHYSIOS: Phase 1 repository and patch analysis

> **Name.** The project was renamed **RawBot Studio** on 13 Nov 2026; this historical document
> keeps the name PHYSIOS that it had at the time.

> **History (PHYSIOS 1.x).** This analysis describes PHYSIOS when it lived inside a
> `physical_ai_tools` checkout. Since 2.0.0 PHYSIOS is standalone: `pam_trainer` is
> `backend/physios_trainer`, the robot server is the PHYSIOS robot runtime in `robot/`, and
> data lives in `PHYSIOS_DATA_DIR`. See `02-ARCHITECTURE.md`.

Analysed tree: `physical_ai_tools`, branch `physical-ai-manager-v2`, upstream base `dcaa3ab`
(ROBOTIS "ci: publish Docker images…", v1.0.0 with rmw_zenoh).

## 1. The three patch files

| File | Exact content (verified with `git diff` byte comparison, ignoring `index` lines) | Files |
|---|---|---|
| `physical_ai_tools_v4_full.patch` | `dcaa3ab..169333b`: upstream ROBOTIS to v4 (v3 platform + v4 features) | 133 |
| `physical_ai_tools_v4_incremental_from_v3.patch` | `492cf5b..169333b`: v3 to v4 only | 46 |
| `physios_rename.patch` | `169333b..dee3a50`: heading, tab title and manifest of the **old** UI say PHYSIOS | 3 |

Relationships:

* **Full and incremental are alternative routes to the same tree.** `full = (dcaa3ab..492cf5b) + incremental`.
  Apply exactly one: full on an untouched upstream checkout, incremental on a v3 checkout.
  Applying both fails (this is what produced "already exists in working directory" on the
  robot PC).
* On the robot PC (`/home/ihub/lerobot/physical_ai_tools`), `git apply --reverse --check`
  of the incremental patch succeeded on 2026-11-05, so that tree is at v4 (`169333b`).
* `physios_rename.patch` depends on v4 and only renames the old UI. **PHYSIOS supersedes it**:
  a renamed old UI is exactly what the PHYSIOS brief rules out. On the branch it is reverted,
  so the old application is again called "Physical AI Manager" and stays available as a
  fallback. If it was applied on the robot PC: `git apply -R physios_rename.patch`. It touches
  nothing else.

## 2. Existing architecture (v4)

```
Browser (old UI, React 19 CRA, nginx container :80, network_mode host)
  ├─ ws://<host>:9090  rosbridge  ──►  physical_ai_server (ROS 2 Jazzy node, container, rmw_zenoh)
  │                                     ├─ planning/ (PlanningService, plain Python, behind /planning/command, /data/command)
  │                                     ├─ communication/ (camera + joint subscribers, task status)
  │                                     ├─ data_processing/ (LeRobot recorder, video encoder)
  │                                     ├─ inference/ (policy inference on the robot)
  │                                     └─ training/ (container training via /training/*)
  ├─ http://<host>:8080 web_video_server (MJPEG of compressed image topics)
  ├─ /lerobot-data/  nginx static, read-only mount of docker/huggingface/lerobot
  └─ /train-api/     nginx proxy ──► pam_trainer (host, stdlib Python, 127.0.0.1:8766)
                                     ├─ runs, queue, storage, diagnostics, optimisation sessions
                                     ├─ evaluations log, dataset health probe
                                     ├─ host rollouts (rollout_worker.py talks rosbridge)
                                     └─ robots/ (custom robot library, URDF/Xacro, readiness)
open_manipulator container: the SO-101 hardware drivers (leader/follower).
```

Sizes: old UI 30.8k lines JS; `pam_trainer` 8.3k lines Python; `physical_ai_server` 12.5k.

### ROS 2 interface of physical_ai_server (unchanged by v4 except the planning service)

| Kind | Name | Type | Used for |
|---|---|---|---|
| srv | `/task/command` | `SendCommand` (IDLE, START_RECORD, START_INFERENCE, STOP, MOVE_TO_NEXT, RERECORD, FINISH, SKIP_TASK + `TaskInfo`) | recording and on-robot inference |
| srv | `/get_robot_types`, `/set_robot_type` | `GetRobotTypeList`, `SetRobotType` | robot selection; loads topic params |
| srv | `/planning/command`, `/data/command` | `PlanningCommand` (command + JSON payload → JSON result) | planning engine, plan-mode recording, dataset library, review, HF/GitHub publishing |
| srv | `/image/get_available_list` | `GetImageTopicList` | camera list |
| srv | `/get_policy_list`, `/get_saved_policies`, `/training/*`, `/huggingface/control`, `/register_hf_user`, `/get_registered_hf_user`, `/dataset/edit`, `/dataset/get_info`, `/browse_file` | various | container training, HF account, dataset edit |
| topic | `/task/status` | `TaskStatus` (phase 0–6, episode, timers, cpu/ram/storage, error) | recording/inference progress |
| topic | `/heartbeat` | `std_msgs/Empty` | server liveness |
| topic | `/training/status`, `/huggingface/status` | | container training, upload progress |
| topics | per robot type: `camera_topic_list`, `joint_topic_list` params (e.g. `/joint_states`, leader topics, compressed images) | | live view, recording |

`PlanningService` is ROS-independent (`handle(command, payload)`); the ROS glue is 105 lines.
Command families: `meta`, `robot.profile`, `plan.*` (list/new/get/save/defaults/generate/
validate/apply_fix/update_episode/add_episode/remove_episode/reorder/approve/duplicate/
targeted/archive/delete/set_active), `record.*` (state/begin/cancel/skip/restore/recent),
`data.*` (list_datasets/overview/episodes/episode/set_markers/review/delete_episodes/hf_*/
uploads), `github.*`, `settings.*`, `job.status`.

### pam_trainer HTTP API (127.0.0.1:8766, `/api/...`)

`health`, `system`, `envs[/<name>]`, `datasets`, `models`, `policy-flags`, `plan`,
`runs` (+ `/<id>`, `log`, `metrics`, `diagnostics`, `resources`, `checkpoints`, `watch`,
`stop`, `pause`, `resume`, `retry`, `metadata`, `export`, `keep`), `queue` (+ preview/cancel/
confirm/move/clear), `storage` (+ cleanup), `events`, `compare`, `evaluations` (+ update/
delete), `health-report`, `rollouts` (+ prepare, limits, `<id>`, log, command, heartbeat),
`optimization/*` (sessions, propose, trials launch, stop, conclude, next-plan),
`robots/*` (create, upload, asset, validate, register, config, server-config, verify ros/
hardware authorize+result/data, connect, update, replace, delete).
Every command-executing POST needs a server-issued `confirm_token` from a preview call; POSTs
with a foreign `Origin` are refused; it refuses to listen on anything but loopback.

### Storage (all file-based, no database)

| Data | Location | Owner |
|---|---|---|
| LeRobot datasets (v2.1/v3.0) | `docker/huggingface/lerobot/<user>/<repo>` (= `/root/.cache/huggingface/lerobot` in the container), also `~/.cache/huggingface/lerobot` | recorder (container) |
| Plans, progress, reviews, settings | `docker/workspace/physical_ai_manager/{planning,reviews}` | PlanningService |
| Training runs, queue, sessions, evaluations, rollouts, robots | `docker/workspace/physical_ai_manager/training/` | pam_trainer |
| Checkpoints | run `output_dir` (under `…/training/outputs`) | lerobot-train |

### Authentication

None. Security is locality: `pam_trainer` binds 127.0.0.1 and refuses cross-origin POSTs;
rosbridge and web_video_server listen on all interfaces (upstream default). HF and GitHub
tokens are stored by the server node, never by the UI.

## 3. Functionality map

"Independent of the old UI?" asks whether the capability lives in a backend that works with
no old UI running. Every capability does; only the presentation is in the old UI.

| Capability | Implemented in | Backend / interface | Old UI dependants | Independent of old UI? | Needed for PHYSIOS |
|---|---|---|---|---|---|
| Dynamic planning | `physical_ai_server/planning/{engine,validation,service}.py` | `/planning/command` (ROS srv) | PlanningPage, planning/* editors | Yes | REST adapter in the gateway (rosbridge client); new Planning Studio |
| Plan-mode recording | `planning/service.py` record.* + recorder | `/planning/command` + `/task/command` + `/task/status` | RecordPage, usePlanRecording | Yes | gateway REST for commands; live status over the `/ros` WebSocket |
| Free recording | `physical_ai_server.py`, `data_processing/` | `/task/command`, `/task/status` | ControlPanel, RecordPage | Yes | same |
| Camera monitoring | web_video_server (:8080) + `/image/get_available_list` | HTTP MJPEG, ROS srv | ImageGridCell, ProcessedCameraView | Yes | gateway stream proxy (same origin) |
| Live joints | robot topics (`joint_topic_list` param) | ROS topics | SimulationView, RobotSetup | Yes | `/ros` WebSocket proxy |
| Dataset library, review, deletion | `planning/datasets.py`, service data.* | `/data/command` | DataPage, EpisodeViewer, TimelineChart | Yes | gateway REST; dataset files served by the gateway (Range) |
| Dataset publishing (HF, GitHub) | service data.hf_*, github.*; `/huggingface/control` | ROS srv | PublishPanel | Yes | gateway REST |
| Dataset health check | `pam_trainer/health_probe.py` | `/api/health-report` | DataPage | Yes | trainer proxy |
| Local training | `pam_trainer/{runner,planner,service}.py` | `/api/plan`, `/api/runs` | LocalTrainingPage, TrainingPanels, RunMonitor | Yes | trainer proxy; new Training Studio |
| Optimisation | `pam_trainer/{diagnostics,tuning,optimizer}.py` | `/api/runs/<id>/diagnostics`, `/api/optimization/*` | features/optimization/* | Yes | trainer proxy; new Optimization Studio |
| Robot library / URDF / readiness | `pam_trainer/robots/*` | `/api/robots/*` | RobotsPage, features/robots/* | Yes (Stage 2/3 evidence is gathered in the browser over rosbridge) | trainer proxy + `/ros`; port of URDF loader and hardware-test sequencer |
| Evaluation | `pam_trainer/evaluations.py`, `compare`, run metrics (validation loss) | `/api/evaluations`, `/api/compare`, `/api/runs/<id>/metrics` | EvaluationPanel | Yes | trainer proxy |
| On-robot inference (ROBOTIS) | `physical_ai_server/inference/` | `/task/command` START_INFERENCE | InferencePage | Yes | gateway REST with explicit confirmation |
| Host rollout (dry run, run, e-stop) | `pam_trainer/{rollout,rollout_worker}.py` | `/api/rollouts/*` | HostRollout | Yes | trainer proxy |
| System info | `pam_trainer/environment.py` (`system_info`, `nvidia_smi`) | `/api/system` | LocalTrainingPage | Yes | gateway reuses the module and adds CPU % |

## 4. What PHYSIOS reuses and what it replaces

Reused unchanged: `physical_ai_server` (ROS node, planning engine, recorder, inference),
`physical_ai_interfaces`, `pam_trainer` (all HTTP routes), web_video_server, LeRobot, the
dataset format and every storage location.

Replaced: the browser application. PHYSIOS gets its own shell, navigation, design system and
pages, plus its own application server (gateway) that serves the PHYSIOS frontend and fronts
the existing services. No backend logic is copied. The gateway imports
`pam_trainer.environment` for host information instead of re-implementing it.

Ported from the old UI as **logic, not UI**:
* URDF→three.js loader (parsing, mesh loading, joint transforms) from `UrdfViewer.js`;
* the supervised one-joint hardware-test sequencer (safety-critical; same algorithm and
  thresholds) from `RobotSetup.js`.

## 5. Gaps found during the analysis (honest list)

* Pause/resume of a recording does not exist in `physical_ai_server` (no command for it).
  PHYSIOS does not pretend otherwise.
* "Dataset export" did not exist as a backend operation; the gateway adds a read-only
  streamed `.tar.gz` download of one dataset folder.
* No backend computes CPU utilisation %; the gateway adds it (`/proc/stat` deltas).
* The planning service, recorder and on-robot inference need ROS (rosbridge + zenoh router).
  Without them PHYSIOS shows those modules as disconnected; training, optimisation,
  evaluation logs, robot library and host rollouts keep working through the trainer.
