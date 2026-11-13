"""PHYSIOS gateway: the application server of PHYSIOS.

Serves the PHYSIOS frontend and exposes one documented HTTP API (``/api/v1``) in front of
the PHYSIOS services: the robot runtime (the ROS 2 physical_ai_server node in the
physios-robot container, through rosbridge), the training service (physios_trainer, on the
host), web_video_server and the LeRobot dataset folders. All of them live in this repository.
Standard library only. See documentation/03-API.md.
"""

__version__ = '2.0.0'
