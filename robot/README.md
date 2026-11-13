# RawBot Studio robot runtime

The ROS 2 side of RawBot Studio. It runs in the `physios-robot` container
(`docker/robot/Dockerfile`), started by `./start_physios.sh --with-robot` or
`./docker/physios-docker.sh up --with-robot`.

| Package | What it does |
|---|---|
| `src/physical_ai_server` | robot server node: robot types, recording to LeRobot datasets, on-robot inference, in-container training, the RawBot Studio planning engine (`planning/`) and its JSON services, launch files and built-in robot configs (`config/`) |
| `src/physical_ai_interfaces` | messages and services used by the interface (`/task/command`, `/planning/command`, ...) |
| `src/rosbag_recorder` | bag recording service used during recording |

The bringup (`physical_ai_server_bringup.launch.py`) starts the robot server, rosbridge
(`:9090`), the bag recorder and web_video_server (`:8080`). It only serves services and
topics; it never moves the robot.

**Robot configurations.** Built-in configs are in `src/physical_ai_server/config/`. Put your
own `<robot>_config.yaml` files (for example one exported from the Robots page) in
`data/robot-config/` of RawBot Studio. The container installs them at every start, so they
survive image rebuilds. Restart the runtime after adding one.

**LeRobot.** `lerobot.lock` records the LeRobot commit installed in the image, and the
training service uses it to warn when a model was trained with a different LeRobot version.

**Building and checking the packages without Docker** (a ROS 2 Jazzy machine):

```bash
mkdir -p ~/physios_ws/src && ln -s ~/physios/robot/src ~/physios_ws/src/physios
cd ~/physios_ws && rosdep install -i --from-path src -y && colcon build
python3 -m pytest -q ~/physios/robot/src/physical_ai_server/test/planning   # planning engine
```

These packages derive from ROBOTIS physical_ai_tools (Apache-2.0); see `NOTICE`.
