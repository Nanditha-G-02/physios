<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="documentation/media/raw-logo-white.svg">
  <img src="documentation/media/raw-logo-black.svg" alt="RawBot Studio" height="56">
</picture>

# RawBot Studio

**The Operating System for Physical Intelligence**

Teach a robot arm by demonstration, curate the data, train vision-language-action policies on
your own PC, and run them on the robot under supervision, all from one application.

[![Version](https://img.shields.io/badge/version-2.0.0-2457E6?style=flat-square)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-Apache--2.0-0B0C0E?style=flat-square)](LICENSE)
![React](https://img.shields.io/badge/React-19-0B0C0E?style=flat-square&logo=react&logoColor=61DAFB)
![ROS 2](https://img.shields.io/badge/ROS%202-Jazzy-0B0C0E?style=flat-square&logo=ros&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.9%2B-0B0C0E?style=flat-square&logo=python&logoColor=FFD43B)
![LeRobot](https://img.shields.io/badge/LeRobot-0.2-0B0C0E?style=flat-square)
![Docker](https://img.shields.io/badge/Docker-ready-0B0C0E?style=flat-square&logo=docker&logoColor=2496ED)

[Demo](#demo) · [Features](#key-features) · [Screenshots](#screenshots) · [Install](#installation) · [Try it without a robot](#try-it-without-a-robot) · [Architecture](#architecture) · [Docs](#documentation)

<img src="documentation/media/hero-light-dark.png" alt="RawBot Studio Home in light mode (left) and dark mode (right): the animated robot arm and the robot selection panel" width="100%">

</div>

RawBot Studio was called **PHYSIOS** until 13 November 2026. Commands, folders, Docker
containers and settings keep the `physios` names (`./start_physios.sh`, `PHYSIOS_*`), so
existing installations keep working unchanged.

---

## Demo

<div align="center">

<a href="documentation/media/rawbot-studio-demo.mp4">
  <img src="documentation/media/rawbot-studio-demo.gif" alt="Screen recording: select a robot, open a collection plan, record, review an episode, check a training run, prepare a host rollout, then switch to dark mode" width="88%">
</a>

<sub>Select the robot → plan → record → review episodes → monitor and optimise training → host rollout → dark mode.
<a href="documentation/media/rawbot-studio-demo.mp4">Full recording (MP4, 80 s)</a></sub>

</div>

**Live demo.** RawBot Studio drives a real robot arm and trains on your own GPU, so there is no
public hosted instance. You can run the complete interface on any PC without a robot, GPU or
ROS: see [Try it without a robot](#try-it-without-a-robot). The recording above was made that
way.

---

## Key features

| Feature | What it does |
|---|---|
| **🤖 Robot selection** | Pick a built-in arm (SO-101, OpenMANIPULATOR-X/Y) or a custom robot, with live server link, robot heartbeat and an animated 3D arm. |
| **🗺️ Collection planning** | Define the task, choose a planning type (static, semi-dynamic, dynamic, randomized, sequential, scenario-based), edit every episode on a workspace map, validate and approve a frozen plan. |
| **🎥 Recording** | Plan mode records the approved plan episode by episode; free recording for ad-hoc demos. Original, processed, 3D simulation and multi-panel camera views, plus a camera check against the training data. |
| **🗂️ Dataset curation** | Overview and health of each LeRobot dataset, episode playback with joint timelines and automatic grasp phases, accept/reject reviews, publishing to Hugging Face and GitHub. |
| **🧠 Training on this PC** | Train ACT, SmolVLA, Diffusion, π0 and other LeRobot policies in your own environment: every command is shown before it runs, with a queue, live metrics, logs and checkpoints. |
| **📈 Optimise, evaluate, compare** | Detects training problems (NaN, divergence, stagnation, clipping), logs robot trials on a success map, compares runs side by side and recommends the next step. |
| **🦾 Inference** | Container inference, or a host rollout of a checkpoint trained on this PC with an enforced joint envelope, step limits, heartbeat and stale-data holds, and an emergency stop. |
| **🛠️ Custom robots** | Add a robot from its URDF/Xacro, inspect it in 3D and verify it step by step before recording or training unlocks. |
| **🌗 Light and dark mode** | A sidebar switch changes the whole application; the choice is remembered. |
| **🔒 Safe by design** | The robot moves only after an explicit operator action; start-up never moves it. Optional operator sign-in. |

---

## Screenshots

Images follow your GitHub theme (light or dark). Every page in both themes is in
[`documentation/screenshots/`](documentation/screenshots) and
[`documentation/screenshots/dark/`](documentation/screenshots/dark).

<table>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="documentation/screenshots/dark/02-planning.png"><img src="documentation/screenshots/02-planning.png" alt="Planning: episode editor with workspace map and action sequence"></picture>
<p align="center"><b>Planning</b>: edit every episode on the workspace map</p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="documentation/screenshots/dark/03-record-plan.png"><img src="documentation/screenshots/03-record-plan.png" alt="Record in plan mode: camera views, plan progress and controls"></picture>
<p align="center"><b>Record</b>: plan mode with live cameras and progress</p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="documentation/screenshots/dark/03-record-simulation.png"><img src="documentation/screenshots/03-record-simulation.png" alt="Record: 3D simulation of the live joint states"></picture>
<p align="center"><b>Simulation view</b>: live joints in 3D</p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="documentation/screenshots/dark/04-data-episodes.png"><img src="documentation/screenshots/04-data-episodes.png" alt="Data: episode playback with camera feeds, joint timeline and grasp phases"></picture>
<p align="center"><b>Episodes</b>: playback, joint timeline, grasp phases, review</p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="documentation/screenshots/dark/04-data-overview.png"><img src="documentation/screenshots/04-data-overview.png" alt="Data: dataset overview with review progress"></picture>
<p align="center"><b>Dataset overview</b>: health, reviews, publish history</p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="documentation/screenshots/dark/05-training-runs.png"><img src="documentation/screenshots/05-training-runs.png" alt="Training: run monitor with progress, loss and learning-rate charts"></picture>
<p align="center"><b>Training runs</b>: live metrics, logs and checkpoints</p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="documentation/screenshots/dark/05-training-optimize.png"><img src="documentation/screenshots/05-training-optimize.png" alt="Training: Optimize tab with detected problems and live metrics"></picture>
<p align="center"><b>Optimize</b>: problem detection and recommendations</p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="documentation/screenshots/dark/06-inference-host-rollout.png"><img src="documentation/screenshots/06-inference-host-rollout.png" alt="Inference: host rollout with motion limits and review"></picture>
<p align="center"><b>Host rollout</b>: run a checkpoint with enforced limits</p>
</td>
</tr>
</table>

<details>
<summary><b>More screens: light and dark side by side</b></summary>
<br>

| Light | Dark |
|---|---|
| <img src="documentation/screenshots/01-home.png" alt="Home, light"> | <img src="documentation/screenshots/dark/01-home.png" alt="Home, dark"> |
| <img src="documentation/screenshots/03-record-multipanel.png" alt="Record, multi-panel, light"> | <img src="documentation/screenshots/dark/03-record-multipanel.png" alt="Record, multi-panel, dark"> |
| <img src="documentation/screenshots/05-training-new.png" alt="New training, light"> | <img src="documentation/screenshots/dark/05-training-new.png" alt="New training, dark"> |
| <img src="documentation/screenshots/05-training-compare.png" alt="Compare runs, light"> | <img src="documentation/screenshots/dark/05-training-compare.png" alt="Compare runs, dark"> |
| <img src="documentation/screenshots/05-training-evaluate.png" alt="Evaluate, light"> | <img src="documentation/screenshots/dark/05-training-evaluate.png" alt="Evaluate, dark"> |
| <img src="documentation/screenshots/07-robots.png" alt="Robots, light"> | <img src="documentation/screenshots/dark/07-robots.png" alt="Robots, dark"> |
| <img src="documentation/screenshots/08-sign-in.png" alt="Sign-in, light"> | <img src="documentation/screenshots/dark/08-sign-in.png" alt="Sign-in, dark"> |

</details>

---

## Workflow

```mermaid
flowchart LR
    A["🤖 Select robot"] --> B["🗺️ Plan<br/>task · episodes · approve"]
    B --> C["🎥 Record<br/>leader → follower, 2 cameras"]
    C --> D["🗂️ Curate<br/>review · accept · publish"]
    D --> E["🧠 Train<br/>ACT · SmolVLA · …"]
    E --> F["📈 Optimise & evaluate<br/>metrics · robot trials"]
    F -->|"needs more data"| B
    F --> G["🦾 Run on the robot<br/>supervised inference"]
    G -->|"failures become new episodes"| B
```

One loop, one application: every step hands its result to the next (an approved plan drives
recording, a curated dataset feeds training, evaluation results point back to the plan).

---

## Architecture

```mermaid
flowchart TB
    subgraph browser["Browser"]
        UI["RawBot Studio frontend<br/>React 19 · Redux · Tailwind · Three.js"]
    end
    subgraph host["Robot PC"]
        GW["Gateway · :8700<br/>backend/physios_gateway<br/>API, sign-in, health, serves the UI"]
        TR["Training service · :8766<br/>backend/physios_trainer<br/>training, queue, optimise, evaluate, host rollout"]
        ENV[("Your LeRobot<br/>Python env + GPU")]
        DATA[("data/<br/>datasets · plans · runs · checkpoints")]
        subgraph robotc["physios-robot container · ROS 2 Jazzy"]
            RS["Robot server<br/>planning engine · recording · inference"]
            RB["rosbridge · :9090"]
            WV["web_video_server · :8080"]
        end
    end
    ARM["Robot arm<br/>its own ROS 2 driver"]

    UI -- "/api/v1 · /train-api · /camera-stream · /lerobot-data" --> GW
    UI -- "/ros (WebSocket)" --> GW
    GW --> TR
    GW --> RB
    GW --> WV
    GW --> DATA
    TR --> ENV
    TR --> DATA
    RB --> RS
    RS --> DATA
    RS <-- "ROS 2 (rmw_zenoh)" --> ARM
```

**RawBot Studio is one self-contained repository.** It has its own frontend, gateway, training
service, robot runtime, configuration, data folder, Docker images and scripts. It does **not**
need a ROBOTIS `physical_ai_tools` checkout or the `physical_ai_manager` container. The arm's own
ROS 2 driver (joint states, camera topics, commands) is not part of RawBot Studio.

| Part | Folder | Runs as |
|---|---|---|
| Frontend (React 19, Redux, Tailwind) | `frontend/` | built to `frontend/dist`, served by the gateway |
| Gateway: API, same-origin paths, sign-in, health | `backend/physios_gateway/` | host process or `physios-gateway` container, `:8700` |
| Training service: training, optimisation, evaluation, host rollout, custom robots | `backend/physios_trainer/` | host process, `127.0.0.1:8766` (uses your LeRobot Python environment and GPU) |
| Robot runtime (ROS 2 Jazzy): robot server with planning engine, recording, inference; rosbridge; camera streams | `robot/src/` | `physios-robot` container (`docker/robot/Dockerfile`) |
| Configuration | `configuration/physios.env` | read by every part |
| Data: datasets, plans, reviews, runs, checkpoints, extra robot configs | `data/` (or `PHYSIOS_DATA_DIR`) | shared by every part |
| Deployment | `scripts/`, `start_physios.sh`, `stop_physios.sh`, `docker/` | |

Details: [`documentation/02-ARCHITECTURE.md`](documentation/02-ARCHITECTURE.md).

---

## Technology stack

| Layer | Technologies |
|---|---|
| **Frontend** | React 19, Redux Toolkit, Tailwind CSS 3 (light/dark theme tokens), Three.js (3D arm, simulation, URDF viewer), roslib, Geist fonts |
| **Gateway** | Python 3.9+ standard library: REST API, WebSocket proxy, sign-in, static hosting |
| **Training service** | Python 3.9+ standard library; runs `lerobot-train` in your own environment (conda/venv) on your GPU |
| **Robot runtime** | ROS 2 Jazzy, rmw_zenoh, rosbridge, web_video_server, LeRobot 0.2.0 (pinned in `robot/lerobot.lock`) |
| **Policies** | ACT, SmolVLA, Diffusion Policy, π0, VQ-BeT, TD-MPC (via LeRobot) |
| **Data** | LeRobot dataset format v2.1, Hugging Face Hub publishing, GitHub metadata commits |
| **Deployment** | Docker + compose (GPU override with the NVIDIA container toolkit), shell scripts |
| **Testing** | pytest (gateway, training service, planning engine), Playwright end-to-end walk-throughs |

---

## Installation

Requirements:
* Ubuntu 22.04/24.04;
* Python 3.9+, standard library only;
* Node.js 18+, to build the frontend;
* Docker with the compose plugin, for the robot runtime and the Docker deployment;
* the NVIDIA container toolkit, for on-robot inference on the GPU;
* for training, a Python environment with LeRobot (for example your conda env), which the
  training service discovers by itself.

```bash
git clone https://github.com/Nanditha-G-02/physios.git ~/physios
cd ~/physios
./scripts/install.sh            # checks requirements, creates configuration/physios.env and data/,
                                # builds the frontend
./scripts/install.sh --robot    # once: build the robot runtime image (ROS 2 + LeRobot, ~20-40 min)
```

**Moving from PHYSIOS 1.x** (inside `~/lerobot/physical_ai_tools`)? Copy your datasets, plans,
runs, checkpoints and robot configs into the new data folder. The old checkout is not changed:

```bash
./scripts/install.sh --import-from ~/lerobot/physical_ai_tools
```

### Run

```bash
./start_physios.sh --with-robot   # robot runtime container + training service + gateway
# open http://127.0.0.1:8700
./stop_physios.sh --robot         # stop everything RawBot Studio started
```

* `./start_physios.sh` starts the training service and the gateway only. Use it for planning
  data, training and evaluation without the robot.
* `--with-robot` starts the `physios-robot` container: Zenoh router, robot server, rosbridge,
  bag recorder and web_video_server. It never moves the robot.

Or everything in Docker (the training service stays a host process because it needs your
LeRobot environment and GPU):

```bash
./docker/physios-docker.sh up --with-robot     # gateway + robot runtime containers
./start_physios.sh --no-gateway                # training service on the host
```

### Update

```bash
cd ~/physios && git pull
./scripts/install.sh                         # rebuilds the frontend
./docker/physios-docker.sh build all         # if docker/ or robot/ changed
./stop_physios.sh --robot && ./start_physios.sh --with-robot
```

Your data folder and `configuration/physios.env` are not tracked by git and are kept. See
[`documentation/04-OPERATIONS.md`](documentation/04-OPERATIONS.md) for configuration,
troubleshooting and tests.

---

## Try it without a robot

The development stack runs the **real** gateway, the **real** training service (with a stub
`lerobot-train` that produces loss curves and checkpoints) and the **real** planning engine
behind a stand-in for the robot side (simulated recorder with test videos, synthetic joint
states). No robot, GPU or ROS is needed.

```bash
pip install websockets           # for the robot stand-in; ffmpeg must be installed too
./scripts/install.sh             # builds the frontend
python3 tests/e2e/devstack.py ~/rawbot-demo --seed
# open http://127.0.0.1:8700 · Ctrl+C stops everything
```

`--seed` records three demonstration episodes through the API, so every page has data.

---

## Pages

| | Page | What it does |
|---|---|---|
| 01 | **Home** | Robot selection with live status |
| 02 | **Planning** | Define task, Planning type, Configure, Plan & edit, Validate & approve |
| 03 | **Record** | Plan mode or Free recording; Original, Processed, Simulation, Multi-panel views; Review episodes, Camera check |
| 04 | **Data** | Overview, Episodes, Publish, Tools |
| 05 | **Training** | New training, Runs, Queue, Optimize, Evaluate, Compare, Storage, In container |
| 06 | **Inference** | Container inference, Host rollout |
| R | **Robots** | Custom robot library |

---

## Access

On a loopback-only gateway (the default) no sign-in is needed. Set `PHYSIOS_AUTH_TOKEN` in
`configuration/physios.env` to require an operator token. It is mandatory before RawBot Studio may
listen on the network (`PHYSIOS_HOST`, `PHYSIOS_ALLOW_REMOTE=1`).

## Safety

The robot moves only after an explicit operator action:

* **Start** in Record: the follower mirrors the leader arm.
* **Load model**, then **Start moving** in Host rollout: two confirmations, and the worker
  enforces the joint envelope, step limits, heartbeat and stale-data holds, and the emergency
  stop.
* **Start** in Container inference.
* **Start motion** in the one-joint hardware test: a server-authorised plan.

Start-up (scripts, containers) never moves the robot. A software stop holds position. It is
not a hardware emergency stop, so keep the power switch or e-stop within reach.

---

## Documentation

| File | Contents |
|---|---|
| [`documentation/02-ARCHITECTURE.md`](documentation/02-ARCHITECTURE.md) | architecture, directory structure, data folder, modules, theme, safety model |
| [`documentation/03-API.md`](documentation/03-API.md) | gateway API contract (`/api/v1`, `/ros`) |
| [`documentation/04-OPERATIONS.md`](documentation/04-OPERATIONS.md) | install, configure, run, Docker, update, migrate from 1.x, troubleshoot, test |
| [`documentation/05-STATUS.md`](documentation/05-STATUS.md) | what was verified, how, and what was not |
| [`documentation/07-VALIDATION.md`](documentation/07-VALIDATION.md) | requirements traceability, test results, deployment validation |
| [`documentation/01-ANALYSIS.md`](documentation/01-ANALYSIS.md), [`06-PROJECT-REPORT.md`](documentation/06-PROJECT-REPORT.md), [`paper/`](documentation/paper) | history: analysis, v4 phases and 1.x report, IEEE paper |
| [`robot/README.md`](robot/README.md) | the robot runtime packages and robot configs |
| [`CHANGELOG.md`](CHANGELOG.md) | release notes |
| [`NOTICE`](NOTICE) | third-party code included in RawBot Studio (ROBOTIS physical_ai_tools, Apache-2.0) |

## Licence

Apache License 2.0 ([`LICENSE`](LICENSE)). RawBot Studio includes code derived from ROBOTIS
physical_ai_tools (Apache-2.0); see [`NOTICE`](NOTICE).
