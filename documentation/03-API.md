# PHYSIOS gateway API (v1)

Base URL: `http://127.0.0.1:8700` (`PHYSIOS_HOST`, `PHYSIOS_PORT`). JSON in, JSON out.

**Errors** from the gateway itself:

```json
{"error": {"code": "ros_service_missing", "message": "ROS service /get_robot_types is not available: …", "hint": "…Zenoh router…"}}
```

| HTTP | code | meaning |
|---|---|---|
| 400 | `bad_request`, `bad_dataset_id`, `bad_path` | invalid input |
| 401 | `auth_required`, `bad_token` | sign-in required / wrong access token (only when `PHYSIOS_AUTH_TOKEN` is set) |
| 403 | `cross_origin` | POST or WebSocket from another origin |
| 404 | `not_found` | unknown route or resource |
| 413 | `too_large` | body over 2 MB (JSON) or `PHYSIOS_MAX_UPLOAD_MB` (trainer uploads) |
| 416 | `range_not_satisfiable` | bad Range |
| 429 | `too_many_attempts` | five failed sign-ins from one address within a minute |
| 422 | `command_rejected` | physical_ai_server refused the command (message from the server) |
| 428 | `confirmation_required` | motion command sent without `"confirm": true` |
| 502 | `ros_call_failed`, `bad_response` | ROS service failed |
| 503 | `ros_unavailable`, `ros_service_missing`, `trainer_unavailable`, `camera_unavailable` | dependency down (with hint) |
| 504 | `ros_timeout` | ROS service did not answer within `PHYSIOS_ROS_TIMEOUT_S` |

Routes under `/api/v1/trainer/` are forwarded unchanged. Their errors keep the training
service's shape, `{"error": "text"}`, and the frontend accepts both shapes.

**Security**: the gateway binds to loopback unless `PHYSIOS_ALLOW_REMOTE=1` and an access
token (`PHYSIOS_AUTH_TOKEN`, 12+ characters) are both set. POST requests
and the `/ros` upgrade are refused when `Origin` differs from `Host`. Trainer-forwarded
requests carry `X-Forwarded-Host`, so the trainer's own same-origin check still applies.

## Authentication (optional)

Off unless `PHYSIOS_AUTH_TOKEN` is set. When on, every `/api/v1` route except `/auth/*`, and the
`/ros` WebSocket, need a session cookie or `Authorization: Bearer <token>`. The static
frontend stays public so the sign-in screen can load.

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/auth/session` | | `{enabled, authenticated}` |
| POST | `/auth/login` | `{token}` | `{enabled: true, authenticated: true}` and `Set-Cookie: physios_session=…; HttpOnly; SameSite=Strict` |
| POST | `/auth/logout` | | clears the session cookie |

Sessions are random 256-bit ids kept in memory and expire after `PHYSIOS_AUTH_SESSION_H`
hours (default 12). A gateway restart signs everyone out. Tokens are compared in constant
time and never appear in `/config`.

## System

| Method | Path | Returns |
|---|---|---|
| GET | `/api/v1/health[?force=1]` | `{status: ok/degraded, services: {gateway, trainer, rosbridge, ros_node, camera, datasets}: {status, detail, hint?, latency_ms?, …}, checked_at}`. Each check is real: trainer `/api/health`, rosbridge connection, a `/get_robot_types` call, web_video_server HTTP, dataset folder scan. Cached 3 s. |
| GET | `/api/v1/system` | OS, kernel, RAM, disks, GPUs (nvidia-smi: name, memory, utilisation), `cpu_percent`, `load_avg`, `uptime_s` |
| GET | `/api/v1/config` | effective configuration (no secrets), version, uptime |
| GET | `/api/v1/activity?after=<seq>&limit=` | `{events: [{seq, t, source, level, text}], seq}`: service up/down, robot type changes, task commands, exports |

## ROS 2 (physical_ai_server through rosbridge)

| Method | Path | Body | Calls |
|---|---|---|---|
| GET | `/api/v1/ros/status` | | rosbridge connection `{connected, url, error, since}` |
| GET | `/api/v1/ros/robot-types` | | `/get_robot_types` → `{robot_types}` |
| POST | `/api/v1/ros/robot-type` | `{robot_type}` | `/set_robot_type` |
| GET | `/api/v1/ros/cameras` | | `/image/get_available_list` → `{topics}` |
| GET | `/api/v1/ros/policies` | | `/get_saved_policies` → `{policies: [{path, type}]}` |
| POST | `/api/v1/ros/task` | `{command, task_info, confirm?}` | `/task/command` (`SendCommand`). `command` ∈ idle, start_record, start_inference, stop, move_to_next, rerecord, finish, skip_task. `task_info` is completed to a full `TaskInfo` with typed fields. `start_inference` needs `"confirm": true` (else 428) and a `policy_path`. |
| POST | `/api/v1/ros/hf` | `{mode: upload/download/cancel, repo_id, local_dir, repo_type, author}` | `/huggingface/control` |

## Planning engine, plan-mode recording, datasets

| Method | Path | Body |
|---|---|---|
| POST | `/api/v1/planning/<command>` | command payload (JSON object) → `/planning/command` |
| POST | `/api/v1/data/<command>` | command payload → `/data/command` |

`<command>` is a PlanningService command (`[a-z_]+(\.[a-z_]+)*`). The result is the command's
JSON result; a rejected command is HTTP 422 with the server's message. Main commands:

* `meta`, `robot.profile`, `settings.get`, `settings.set`, `job.status {job_id}`
* `plan.list {include_archived}`, `plan.new {robot_type, user_id, name, strategy_type}`,
  `plan.get {plan_id, version?}`, `plan.save {plan, regenerate}`,
  `plan.defaults {strategy_type, task}`, `plan.generate {plan_id, keep_edited}`,
  `plan.validate`, `plan.apply_fix {plan_id, fix}`,
  `plan.update_episode {plan_id, episode_id, patch}`, `plan.add_episode`,
  `plan.remove_episode`, `plan.reorder {plan_id, order}`, `plan.approve`, `plan.duplicate`,
  `plan.archive`, `plan.delete`, `plan.set_active`
* `record.state`, `record.begin {plan_id, episode_id, retake}` (returns the `task_info` for
  `ros/task start_record`), `record.cancel`, `record.skip`, `record.restore`, `record.recent`
* `data.list_datasets`, `data.overview {dataset_id}`, `data.episodes`,
  `data.episode {dataset_id, episode_index, max_points}`,
  `data.review {dataset_id, episode_index, status, failure_categories, comment}`,
  `data.delete_episodes {dataset_id, episode_indices, confirm: <dataset_id>}` (job),
  `data.hf_account`, `data.hf_prepare`, `data.uploads`, `github.status`, `github.publish`

## Datasets (read-only files)

| Method | Path | |
|---|---|---|
| GET | `/api/v1/datasets/roots` | configured folders and dataset counts |
| GET/HEAD | `/api/v1/datasets/<owner>/<name>/files/<path>` | a file inside the dataset, with `Range` (206) |
| GET | `/api/v1/datasets/<owner>/<name>/export` | streamed `.tar.gz` of the dataset folder |

Paths are resolved inside the configured roots only (`..`, absolute paths and symlinks are
refused or skipped).

## Cameras

| Method | Path | |
|---|---|---|
| GET | `/api/v1/camera/stream?topic=&quality=&width=&height=` | MJPEG from web_video_server (`type=ros_compressed`) |
| GET | `/api/v1/camera/snapshot?topic=` | single JPEG |

## Training service

`ANY /api/v1/trainer/<path>` → `pam_trainer /api/<path>`. Body and query are passed through,
and uploads are allowed up to `PHYSIOS_MAX_UPLOAD_MB`. Full list of routes: health, system,
envs, datasets, models, policy-flags, plan, runs (log, metrics, diagnostics, resources,
checkpoints, watch, stop, pause, resume, retry, metadata, export, keep), queue, storage,
events, compare, evaluations, health-report, rollouts (prepare, command, heartbeat, log,
limits), optimization (sessions, propose, trials/launch, stop, conclude, next-plan), robots
(create, upload, asset, validate, register, config, server-config, verify/ros,
verify/hardware/authorize|result, verify/data, connect, update, replace, delete).
Commands that run something need the `token` returned by the preview call (`plan`,
`rollouts/prepare`, `optimization/propose`, `verify/hardware/authorize`).

## WebSocket `/ros`

After the upgrade, the connection is a transparent pipe to rosbridge (`PHYSIOS_ROSBRIDGE_URL`)
speaking the rosbridge v2 protocol. PHYSIOS uses it for subscriptions (`/task/status`,
`/heartbeat`, joint states, `/huggingface/status`), `/rosapi/topics`, and the supervised
hardware test's trajectory commands.

## Examples

```bash
curl -s localhost:8700/api/v1/health | jq .status
curl -s -X POST localhost:8700/api/v1/planning/plan.list -d '{}' | jq '.plans[].name'
curl -s -X POST localhost:8700/api/v1/ros/task -d '{"command":"stop","task_info":{}}'
curl -s localhost:8700/api/v1/trainer/runs | jq '.runs[0].status'
curl -s -o ds.tar.gz localhost:8700/api/v1/datasets/NandithaaaG/s101_dataset_pick/export
```
