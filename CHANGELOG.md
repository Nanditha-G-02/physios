# RawBot Studio changelog (formerly PHYSIOS)

## 2.0.0, renamed (2026-11-13)

* **New name: RawBot Studio.** The interface (browser tab, Home title, sign-in screen,
  messages), the gateway and training-service messages, the start/stop/install scripts' output,
  the README, the documentation and the IEEE paper now say RawBot Studio. Commands, folders,
  Python packages, Docker images and containers, and `PHYSIOS_*` settings keep their names,
  so nothing changes for an existing installation. The gateway's HTTP `Server` header is
  now `RawBotStudio/2.0.0`. The Home title is slightly smaller on phone-width screens so
  the longer name fits. Screenshots `01-home.png` and `08-sign-in.png` show the new name.

## 2.0.0, fix (2026-11-13, same day)

* **Data import with root-owned files.** The 1.x robot container wrote some files, such as
  `state.json` and the plans, as root with mode 0600. `import-legacy-data.py` stopped on the
  first one. It now:
  * skips and lists files it cannot read, and exits with code 3;
  * prints the command that imports the rest:
    `sudo python3 scripts/import-legacy-data.py OLD --owner $(id -u):$(id -g)`.

  With `--owner`, files are copied, not hard-linked, and given to your user. The old
  installation's files are not changed. `install.sh --import-from` now continues after a
  partial import.
* **Symbolic links are imported.** The Hugging Face model cache (`huggingface/hub`) links
  snapshots to blobs; these links were skipped. They are now recreated, and absolute links
  into the old installation are pointed at the new data folder.
* **Readable planning files.** The planning store writes files with mode 0644 (secrets stay
  0600), so plans and reviews that the robot runtime writes as root can be read by the host
  user and the gateway.
* **Robot runtime crash fixed.** The first 2.0.0 image picked up pandas 3, which needs
  NumPy 2, while ROS 2 Jazzy needs NumPy 1.x. `physical_ai_server` then failed at import, and
  `/get_robot_types` "does not exist". `robot/constraints.txt` now keeps `numpy<2`,
  `pandas<3` and `opencv-python-headless<5`, and applies them to
  every pip install. The build now imports the robot server, so a broken image fails while
  building instead of at start-up.
* **Robot server packages.** Three folders of the robot server had no `__init__.py`
  (`training/trainers/lerobot`, `gr00tn1`, `openvla`), so a normal build left them out
  ("No module named physical_ai_server.training.trainers.lerobot"). They are now packages,
  and the image builds with `--symlink-install`, as the 1.x container did.
* **pyarrow limited too.** pyarrow 26+ needs NumPy 2 as well; `robot/constraints.txt` now
  also keeps `pyarrow<26`. The package list of the old `robotis/physical-ai-server:1.0.0`
  image (`robot/pins-from-1x.txt`) was removed again: that image has since been updated
  and itself contains pandas 3, which needs NumPy 2.
* Tests: 6 more standalone tests (unreadable files, `--owner`, file modes, symlinks, robot image pins, package folders).

## 2.0.0 (2026-11-13)

**PHYSIOS is a standalone project.** It installs, runs, updates and deploys from its own
repository (github.com/Nanditha-G-02/physios) and no longer needs a ROBOTIS
`physical_ai_tools` checkout, its `physical_ai_server` / `physical_ai_trainer` folders, or the
`physical_ai_manager` container.

* **Training service in PHYSIOS:** `backend/physios_trainer`. This is the v4 training
  service, formerly `pam_trainer` in `physical_ai_trainer/`, with the same API on
  `127.0.0.1:8766`. `start_physios.sh` starts it from `backend/`. Tests are in
  `backend/trainer_tests`.
* **Robot runtime in PHYSIOS:** `robot/src`, built into the `physios-robot` image by
  `docker/robot/Dockerfile`. It contains:
  * the robot server with the planning engine;
  * the interfaces and the bag recorder;
  * rosbridge and web_video_server;
  * LeRobot at the commit in `robot/lerobot.lock`.

  `start_physios.sh --with-robot` (or `physios-docker.sh up --with-robot`) starts it. Like
  before, it never moves the robot. The code derives from ROBOTIS physical_ai_tools
  (Apache-2.0); see `NOTICE`.
* **One data folder:** `PHYSIOS_DATA_DIR`, default `data/`. It holds datasets, plans,
  reviews, runs, checkpoints and extra robot configs, and every part mounts it at a fixed
  path. Robot configs in `data/robot-config/` are installed at every robot-runtime start.
* **Installation:** `scripts/install.sh`, with options `--robot`, `--docker` and
  `--import-from`.
* **Data import:** `scripts/import-legacy-data.py` copies the data of a 1.x installation.
  It hard-links files on the same disk, updates paths in records, and does not change the
  old installation.
* **Docker:**
  * `docker/gateway/Dockerfile` (it was `docker/Dockerfile`) and `docker/robot/Dockerfile`;
  * the compose services `physios-gateway` and `physios-robot` (profile `robot`);
  * an automatic GPU override;
  * `physios-docker.sh build|up|robot-up|robot-down|logs|shell|status|down`.
* **Scripts:**
  * `start_physios.sh --with-robot` replaces `--with-ros` (still accepted);
  * new: `--no-gateway`;
  * `stop_physios.sh --robot` replaces `--ros`.
* **Configuration:**
  * `PHYSIOS_REPO_ROOT` is gone;
  * new: `PHYSIOS_DATA_DIR`, `PHYSIOS_ROS_DOMAIN_ID`, `PHYSIOS_ROBOT_START_ZENOH`,
    `PHYSIOS_ROBOT_GPU`, `PHYSIOS_ROBOT_BASE_IMAGE`.
* **Frontend:**
  * the interface is unchanged;
  * the instruction texts that named the old folders were updated;
  * container paths for checkpoints are now `/physios/data/outputs/train/`.
* **Tests:** the dev stack and the browser checks are now in `tests/e2e`. New
  `test_standalone.py` (5 tests) checks the self-contained layout and the data import.
* **Documentation:** README, architecture, operations (install, Docker, update, moving from
  1.x), status and validation rewritten for the standalone layout.

## 1.2.0 (2026-11-11)

* **The interface operators use, served by PHYSIOS.** The frontend is now PHYSIOS's own copy of
  the Physical AI Manager interface: v4, with the PHYSIOS name and the compact theme, exactly
  as on the robot PC's screenshots of 11 Nov. That covers every page, tab and view:
  * Planning steps; Record views and camera check;
  * Data Overview, Episodes, Publish and Tools;
  * Training incl. In container; Inference Container and Host rollout; Robots.
  1.1.0's separately written TypeScript frontend was replaced. It remains in git as tag
  `physios-1.1.0`.
* **Gateway** serves the interface's same-origin paths, so neither nginx nor the
  physical_ai_manager container is needed:
  * `/train-api/*` → training service;
  * `/camera-stream/*` → web_video_server;
  * `/lerobot-data/*` → dataset files with Range;
  * rosbridge through `/ros` instead of `:9090`.
  All of them are covered by sign-in when it is enabled.
* **One visual fix:** on Record and Inference, Robot Type and the Connected chip sit side by
  side. The chip no longer covers the "PROCESSED · display only" label.
* Optional sign-in screen (only when `PHYSIOS_AUTH_TOKEN` is set).
* Tests: gateway 20 → 22; the Physical AI Manager walk-through (26 steps) and the Optimize
  check (9 steps) now run against PHYSIOS on :8700; `auth_e2e.py` updated. The TypeScript-only
  `physios_e2e.py` and vitest suite were removed together with that frontend.

## 1.1.0 (2026-11-11)

* **Compact professional UI.** Same layout, navigation and components as the Physical AI
  Manager, with less whitespace and higher information density:
  * 14 px card radius with hairline borders and a faint dot-grid canvas;
  * 78 px rail, 30 px page titles, compact buttons, inputs, tabs, tables and control bar;
  * work areas up to 1760 px wide;
  * services on the overview carry a status accent.
* **Responsive.** The console stacks below 1100 px; below 640 px the rail becomes a bottom
  navigation bar and the control bar stays reachable.
* **Optional operator sign-in** (`PHYSIOS_AUTH_TOKEN`):
  * session cookie (HttpOnly, SameSite=Strict), or Bearer token for scripts;
  * rate-limited failed sign-ins;
  * Settings → Access with Sign out;
  * required whenever the gateway listens beyond loopback.
* **Docker deployment:** `docker/Dockerfile`, `docker/docker-compose.yml` (host network,
  non-root, read-only mounts, health check) and `docker/physios-docker.sh`.
* Documentation: validation report (`07-VALIDATION.md`), IEEE-format technical paper
  (`documentation/paper/`), screenshots, updated architecture, API, operations and project
  report.
* Tests: gateway 17 → 20 (sign-in); new `tests/e2e/auth_e2e.py`.

## 1.0.0 (2026-11-06, restyled 2026-11-11)

* First independent release:
  * gateway (`/api/v1`, `/ros`) over physical_ai_server, pam_trainer, web_video_server and
    the LeRobot dataset folders;
  * new frontend with all v4 modules;
  * start/stop scripts and documentation.
* 2026-11-11: adopted the Physical AI Manager design language and layouts.
