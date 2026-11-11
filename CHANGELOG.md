# PHYSIOS changelog

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
