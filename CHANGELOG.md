# RawBot Studio changelog (formerly PHYSIOS)

## 2.0.0, renamed (2026-11-13)

* **Light and dark mode.** A Light/Dark switch in the sidebar (above Link/Robot) changes the
  whole application. The choice is remembered in this browser and applied before the page
  appears, so a reload in dark mode does not flash light; switching fades smoothly.
  * Light mode is the existing design, unchanged.
  * Dark mode: deep black and charcoal surfaces, white text, subtle blue highlights, on every
    page, dialog, chart and the sign-in screen. Home follows the dark reference design: a black
    canvas with a faint dot texture, white heading, the robot under a soft spotlight, and the
    white robot panel and sidebar kept light.
  * How: the neutral and tint colours in `tailwind.config.js` are CSS variables, defined in
    `frontend/src/theme.css` for both themes; `<html class="dark">` switches them. Strong fills
    with white text (blue buttons, red Stop, status colours) keep their colour in both themes.
    Chart colours are adjusted in CSS, so the chart code is unchanged. `HeroArm.js` is
    unchanged. No behaviour, layout or backend change.
* **Home background texture.** A barely visible light-grey dot grid at the edges of the Home
  canvas, fading out behind the heading, robot and robot panel. Layout, colours, the robot
  and the robot panel are unchanged.
* **Data → Episodes: compact Observation.** The Global and Gripper camera feeds sit side by
  side at a fixed height (150–250 px depending on the window, 16:9 frame, video letterboxed,
  aspect ratio kept), so the playback bar and the joint graphs are visible below them
  without scrolling. The joint graph is drawn at its real width, so labels stay the same
  size on wide screens. Playback, processed view, phases and review are unchanged.
* **Training: Browse dialog fixed.** The folder browser opens centred over the whole page
  (it was offset by the page animation and its header could be cut off) and fits small
  windows. Adding a folder skips sub-folders that cannot be read instead of failing.
* **Home keeps its black-and-white look.** Heading, canvas and the robot panel are back to
  the black-and-white design (grey "Studio", black buttons, neutral glass). Only the
  animated robot is in colour: silver and white links, black base and joints, blue joint
  rings, red cube. `HeroArm.js` is unchanged. The rest of the application stays black,
  white and blue.
* **Training page: compact dataset list, search and browsing.**
  * Dataset cards are compact, in two columns on wide screens: name, LeRobot version, size,
    episodes, accepted/rejected, robot, fps and frames, cameras, task and folder, as before.
    About four times as many datasets fit on screen.
  * A search bar filters as you type, by name, robot, task, camera, version or folder (all
    words must match).
  * *Browse files…* opens a folder browser for this PC. Pick a LeRobot dataset (it contains
    `meta/info.json`) or a folder of `owner/dataset` folders, and it joins the list. Its
    location is remembered in `dataset_roots.json` in the training service's data folder;
    nothing is copied or changed.
  * Training service: two new endpoints, `GET /api/browse?path=` (folder names only,
    read-only) and `POST /api/dataset-roots`. Existing endpoints and data formats are
    unchanged.
  * Dataset selection, the health report, the hand-off from Data and all later steps are
    unchanged.
* **Home robot colours.** The robot keeps the reference look: silver links, black joints
  and base, blue joint rings. `HeroArm.js` is unchanged since `dda80c8`.
* **Black, white and blue theme across the application.** It follows the training
  command panel: navy-black panels, white text, blue accents.
  * Theme: one blue scale (brand blue `#2457E6`). The blue, indigo, violet, purple, cyan
    and teal palettes all use it, so no other accent hue appears.
  * Home: superseded, see "Home keeps its black-and-white look" above.
  * Charts use brand blue, black, light blue and greys; the workspace and Simulation views
    are blue instead of teal; the decorative pink and peach tints are gone.
  * Unchanged:
    * the animated Home robot (`HeroArm.js` is untouched);
    * status colours: red for errors, Stop and emergency stop, green for OK/done, amber for
      warnings;
    * data colours: plan object colours and camera images;
    * layout and functionality.
  * The rule is recorded in `documentation/02-ARCHITECTURE.md`.
* **Robot selection in liquid glass.** The "Select your robot" panel on Home uses a
  liquid-glass style:
  * a translucent blurred panel with a glowing gradient edge and a top reflection, over soft
    blue, violet and cyan light;
  * glass robot cards with a hover lift and light sweep, and a selected state with a tint,
    gradient icon tile, check mark and glowing ring;
  * glossy pill buttons: indigo-violet *Confirm*, mint *confirmed*, blue-violet *Continue*;
  * a glass status strip.

  The styles are scoped `lg-` classes in `index.css`, so no other page changes. Robots,
  selection, confirmation, custom robots, status and navigation are unchanged. The panel
  stops moving for visitors who prefer reduced motion.
* **Home page, refined.**
  * The robot animation is now a 3D scene in three-quarter perspective, drawn as SVG with
    no 3D library (`components/HeroArm.js`):
    * shaded cylinders and boxes through a perspective camera, one light, soft floor
      shadows and a fading floor grid;
    * an industrial-style arm: graphite base, white column, turntable, joint housings with
      blue rings and bolt circles, white links, wrist roll, parallel gripper;
    * motion: base rotation plus two-link inverse kinematics; quintic easing; it lifts
      before swinging and swings before lowering;
    * the joint/phase readout, the camera and all labels around it are gone.
  * The six workflow cards under the hero were removed, together with their data loading.
    The pages are still reached through the sidebar, unchanged.
  * Layout: two columns, the heading ("Studio" in a blue-violet gradient), tagline and arm
    on the left, the robot panel on the right, on a light canvas with soft blue and violet
    ambient light; the photo background was removed.
  * Robot panel: rounded card with soft shadows; robot tiles with a blue selected state and
    check mark; a single status strip with dividers; one column of tiles on phones. The
    selection, confirmation, custom robots and status logic are unchanged.
* **Tab icon and app icons.** `favicon.ico` (16-64 px) and `favicon.svg` (white *raw*
  wordmark on a black rounded tile), `apple-touch-icon.png` and the manifest icons are
  linked with `?v=3`, so browsers drop the cached ROBOTIS "R" icon. The sign-in screen
  shows the logo.
* **Home page redesign.**
  * The "01 · Home · v2.0.0" line and the duplicate status chips above the title are gone;
    the page starts with the larger *RawBot Studio* heading, followed by a refined tagline.
  * New hero animation (`components/HeroArm.js`), replacing the line drawing: a shaded robot
    arm with metal links, motor housings with bolts and status lights, a cable, a turntable
    base and a parallel gripper. It picks up the cube and places it in the tray, using
    two-link inverse kinematics.
  * Also shown: an overhead camera with its field of view, a perspective floor with
    shadows, and a live readout (task phase, joint angles, gripper, TCP height).
  * It is decorative, not robot data, and it stops moving for visitors who prefer reduced
    motion.
* **Logo.** The *raw* wordmark is the logo: at the top of the rail, as the browser-tab icon
  and as the app icons (`favicon.ico`, `logo192.png`, `logo512.png`). It is a vector
  (`frontend/src/assets/raw-logo.svg`, drawn in the interface's ink colour); the source
  files are in `documentation/branding/`.
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
