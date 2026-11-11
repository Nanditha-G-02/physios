"""PHYSIOS gateway: the application server of PHYSIOS.

Serves the PHYSIOS frontend and exposes one documented HTTP API (``/api/v1``) in front of
the existing Physical AI services: physical_ai_server (ROS 2, through rosbridge), the host
training service (pam_trainer), web_video_server and the LeRobot dataset folders.
Standard library only. See documentation/03-API.md.
"""

__version__ = '1.1.0'
