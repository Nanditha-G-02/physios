# physical_ai_trainer — local training service

The **Training** session of Physical AI Manager trains policies on this PC with the
LeRobot already installed in one of your conda environments. The browser cannot start
processes on the host, so this small service does it for the UI. It is plain Python
(3.9+, standard library only) and runs **outside Docker**, next to your conda.

```
browser ── /train-api/ ──> nginx (physical_ai_manager container, host network)
                              └─> 127.0.0.1:8766  physios_trainer  ──> lerobot-train (your conda env)
```

## Start it

```bash
cd ~/lerobot/physical_ai_tools/physical_ai_trainer
python3 -m physios_trainer
```

Keep the terminal open (or use the systemd unit below). Then open the Training session in the
web UI. Options:

| Option | Default |
|---|---|
| `--port` | `8766` (nginx proxies `/train-api/` to it) |
| `--repo-root` | the `physical_ai_tools` checkout this folder is in |
| `--data-dir` | `<repo>/docker/workspace/physical_ai_manager/training` — runs, logs, metrics, converted dataset copies |
| `--dataset-root` (repeatable) | `<repo>/docker/huggingface/lerobot` and `~/.cache/huggingface/lerobot` |
| `--env NAME=PREFIX` (repeatable) | extra Python environments that `conda env list` does not show (e.g. a venv) |

It only listens on 127.0.0.1 and refuses other hosts; POST requests from another origin are refused.

## What it does — and does not do

* **Discovers** conda environments (`conda env list`) and probes each one read-only: Python,
  LeRobot, PyTorch, CUDA, GPU, video decoders, the dataset format its LeRobot reads. It never
  installs, upgrades or removes anything; when something is missing the UI shows the command
  for you to run yourself.
* **Reads the installed `lerobot-train --help`** (and `--policy.type=X --help`) so every flag in a
  generated command exists in *your* LeRobot. Unknown or unsupported options are reported as
  errors instead of being sent.
* **Checks model ↔ dataset ↔ hardware compatibility** (cameras, resolution, task text, missing
  packages, GPU memory) before a model can be chosen. Models it cannot verify are not offered.
* **Never modifies a recorded dataset.** When the dataset is LeRobot v2.1 (what the recorder
  writes) and the environment's LeRobot needs v3.0, the plan copies the dataset into the data
  dir and runs LeRobot's own converter on the copy. The copy is reused next time.
* **Runs nothing without confirmation.** `POST /plan` returns the exact argv of every stage and a
  token (hash of those argv); `POST /runs` only starts if the token matches what the operator
  reviewed. No shell is involved — argv lists are executed directly.
* **One training at a time**, and none while a `lerobot-train` started elsewhere is running
  (it is detected and left alone).
* **Survives restarts.** Training runs in its own process group with output going to
  `runs/<id>/run.log`; if this service (or the browser) restarts, it re-attaches by PID.
  Logs, parsed metrics (`metrics.jsonl`), resource samples and checkpoints stay on disk.
* Stop = SIGINT, then SIGTERM, then SIGKILL; pause/resume = SIGSTOP/SIGCONT (GPU memory stays
  allocated while paused). Resume-from-checkpoint uses LeRobot's own `--resume=true`.
* Metrics shown in the UI come only from the training log (loss, grad norm, lr, step time,
  `eval_loss` if LeRobot prints it) and from `nvidia-smi` / `/proc` samples every 3 s.

### Running a trained model on the robot (host rollout)

Inference → *Host rollout* (or “Run on robot” on a checkpoint). The service starts `rollout_worker.py` in the
conda environment of the run; it uses that LeRobot's own `predict_action` with the checkpoint's processors and
the training `rename_map`, reads the cameras and follower joints through rosbridge and publishes on the leader
topic — the same path as the Inference session. Safety limits are enforced in the worker (see
`PLANNING_AND_DATA.md`). Rollout records: `<data>/rollouts/<id>/` (config, status, control, log). Default
limits per dataset: `<data>/safety/`.

Needs `rosapi` next to rosbridge (it is part of rosbridge_suite) to verify that nothing else commands the arm;
without it the operator must confirm that check by hand.

### Using a trained model in the container Inference

The Inference session runs inside the `physical_ai_server` container, whose LeRobot is pinned
(0.2.x). A model trained with a different LeRobot minor version (e.g. 0.6.x, which stores its
normalisation in separate processor files) cannot be loaded there, so the UI disables
"Use in Inference" and says why; run such a checkpoint on the host with the same LeRobot instead.
When versions match and the checkpoint is inside a folder shared with the container, the button
fills in the container path.

## Run as a user service (optional)

```ini
# ~/.config/systemd/user/physios-trainer.service
[Unit]
Description=Physical AI Manager training service

[Service]
WorkingDirectory=%h/lerobot/physical_ai_tools/physical_ai_trainer
ExecStart=/usr/bin/python3 -m physios_trainer
Restart=on-failure
# conda must be findable: add its bin folder if it is not on the default PATH
Environment=PATH=%h/miniconda3/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now physios-trainer
journalctl --user -u physios-trainer -f
```

Stopping the service does not stop a running training.

## Tests

```bash
python3 -m pytest tests/test_trainer.py          # no LeRobot needed
PAM_TEST_LEROBOT_PREFIX=~/miniconda3/envs/lerobot python3 -m pytest tests/test_live.py
```

The live test builds a tiny v2.1 dataset, converts a copy, and trains ACT for a few steps on
the CPU with the real `lerobot-train`.

## HTTP API (under `/api`)

`GET health, system, envs, envs/<name>, datasets, models?env&dataset, policy-flags?env&policy,
storage, queue, events?after, compare?ids, evaluations?run, health-report?path&video, rollouts, rollouts/<id>, rollouts/<id>/log`
· `POST storage/cleanup, queue, queue/<id>/cancel|confirm|move, queue/clear, evaluations, evaluations/<id>,
evaluations/<id>/delete, health-report, rollouts/prepare, rollouts {request, confirm_token}, rollouts/limits,
rollouts/<id>/command {run|pause|stop|estop}, rollouts/<id>/heartbeat, runs/<id>/keep`
· `GET health, system, envs, envs/<name>, datasets, models?env&dataset, policy-flags?env&policy`
· `POST plan {config}` · `GET runs` · `POST runs {config, confirm_token}`
· `GET runs/<id>, runs/<id>/log?offset, /metrics, /resources, /checkpoints`
· `POST runs/<id>/stop | pause | resume | retry {mode, confirm_token?, extra_steps?} | metadata | export {step}`
