# Copyright 2026 ROBOTIS CO., LTD.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""ROS 2 glue between physical_ai_server and the planning service.

Adds two services with the generic ``PlanningCommand`` type:

* ``/planning/command`` - plans, plan-mode recording, robot profile
* ``/data/command``     - datasets, reviews, publishing

and three hooks the server calls from its recording path.  Every hook is
wrapped so a planning failure can never stop a recording.
"""

from physical_ai_interfaces.srv import PlanningCommand
from physical_ai_server.planning.service import PlanningService


class PlanningRosBridge:

    def __init__(self, node, dataset_root):
        self.node = node
        self._last_episode_count = None
        self.service = PlanningService(
            dataset_root=dataset_root,
            context={
                'get_robot_type': lambda: getattr(node, 'robot_type', None) or '',
                'is_recording': lambda: bool(node.on_recording or node.on_inference),
                'robot_params': self._robot_params,
            },
            logger=lambda msg: node.get_logger().error(msg))
        for name in ('/planning/command', '/data/command'):
            node.create_service(PlanningCommand, name, self._callback)
        node.get_logger().info(
            'Planning services ready (data root: %s)' % self.service.store.root)

    def _robot_params(self):
        params = getattr(self.node, 'params', None) or {}
        joint_order = getattr(self.node, 'joint_order', None) or {}
        return {
            'camera_topic_list': list(params.get('camera_topic_list') or []),
            'joint_topic_list': list(params.get('joint_topic_list') or []),
            'observation_list': list(params.get('observation_list') or []),
            'joint_list': list(params.get('joint_list') or []),
            'joint_order': {k.split('.', 1)[-1]: list(v) for k, v in joint_order.items()},
        }

    def _callback(self, request, response):
        ok, message, result = self.service.handle_json(request.command, request.payload_json)
        response.success = ok
        response.message = message
        response.result_json = result
        return response

    # ---- hooks -------------------------------------------------------------
    @staticmethod
    def _task_info_dict(task_info):
        return {
            'task_name': task_info.task_name,
            'user_id': task_info.user_id,
            'task_instruction': list(task_info.task_instruction),
            'num_episodes': int(task_info.num_episodes),
            'push_to_hub': bool(task_info.push_to_hub),
            'fps': int(task_info.fps),
        }

    def check_start(self, task_info):
        try:
            self._last_episode_count = 0
            return self.service.check_start(self._task_info_dict(task_info))
        except Exception as e:  # noqa: BLE001
            self.node.get_logger().error('planning check_start failed: %s' % e)
            return True, ''

    def after_record_tick(self, data_manager, completed):
        try:
            if data_manager is None:
                return
            count = int(getattr(data_manager, '_record_episode_count', 0))
            if self._last_episode_count is not None and count > self._last_episode_count:
                path = getattr(data_manager, '_save_path', None)
                self.service.on_episode_saved(str(path) if path else None)
            self._last_episode_count = count
            if completed:
                self.recording_finished()
        except Exception as e:  # noqa: BLE001
            self.node.get_logger().error('planning record hook failed: %s' % e)

    def recording_finished(self):
        try:
            self.service.on_recording_finished()
            self._last_episode_count = None
        except Exception as e:  # noqa: BLE001
            self.node.get_logger().error('planning finish hook failed: %s' % e)
