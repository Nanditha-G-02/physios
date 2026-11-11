# PHYSIOS changelog

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
