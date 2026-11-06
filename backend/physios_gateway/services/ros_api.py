"""Typed operations on physical_ai_server, exposed by the gateway as REST.

Nothing here re-implements server logic: planning/data commands are forwarded verbatim to
``/planning/command`` and ``/data/command`` (PlanningService), robot selection, camera list
and task commands to the existing services.
"""

import json
import re

from physios_gateway.errors import ApiError, bad_request

PLANNING_SRV = 'physical_ai_interfaces/srv/PlanningCommand'
COMMAND_RE = re.compile(r'^[a-z_]+(\.[a-z_]+)*$')

# SendCommand constants (physical_ai_interfaces/srv/SendCommand.srv)
TASK_COMMANDS = {'idle': 0, 'start_record': 1, 'start_inference': 2, 'stop': 3,
                 'move_to_next': 4, 'rerecord': 5, 'finish': 6, 'skip_task': 7}
# commands after which the robot moves under policy control without a human leader
MOTION_COMMANDS = {'start_inference'}

TASK_INFO_FIELDS = {
    'task_name': str, 'task_type': str, 'user_id': str, 'task_instruction': list,
    'policy_path': str, 'fps': int, 'tags': list, 'warmup_time_s': int, 'episode_time_s': int,
    'reset_time_s': int, 'num_episodes': int, 'push_to_hub': bool, 'private_mode': bool,
    'use_optimized_save_mode': bool, 'record_inference_mode': bool, 'record_rosbag2': bool,
}


def normalise_task_info(ti):
    """Full TaskInfo with every field present and typed (rosbridge rejects partial types)."""
    ti = dict(ti or {})
    out = {}
    for k, t in TASK_INFO_FIELDS.items():
        v = ti.get(k)
        if t is list:
            v = [str(x) for x in (v if isinstance(v, list) else ([v] if v else []))]
        elif t is bool:
            v = bool(v)
        elif t is int:
            try:
                v = int(v or 0)
            except (TypeError, ValueError):
                raise bad_request('task_info.%s must be a number' % k)
            if v < 0 or v > 65535:
                raise bad_request('task_info.%s out of range' % k)
        else:
            v = '' if v is None else str(v)
        out[k] = v
    if out['fps'] > 255:
        raise bad_request('task_info.fps must be <= 255')
    return out


class RosApi:

    def __init__(self, bridge, activity):
        self.ros = bridge
        self.activity = activity

    def _json_command(self, service, command, payload):
        if not isinstance(command, str) or not COMMAND_RE.match(command):
            raise bad_request('Invalid command name: %r' % command)
        if payload is not None and not isinstance(payload, dict):
            raise bad_request('Payload must be a JSON object.')
        res = self.ros.call(service, PLANNING_SRV, {
            'command': command, 'payload_json': json.dumps(payload or {})})
        if not res.get('success'):
            raise ApiError(422, 'command_rejected', res.get('message') or 'Command failed.',
                           details={'command': command})
        try:
            return json.loads(res.get('result_json') or '{}')
        except ValueError:
            raise ApiError(502, 'bad_response', 'physical_ai_server returned invalid JSON '
                           'for %s.' % command)

    def planning(self, command, payload):
        return self._json_command('/planning/command', command, payload)

    def data(self, command, payload):
        return self._json_command('/data/command', command, payload)

    def robot_types(self, timeout=None):
        r = self.ros.call('/get_robot_types', 'physical_ai_interfaces/srv/GetRobotTypeList',
                          timeout=timeout)
        return {'robot_types': r.get('robot_types') or [], 'message': r.get('message', '')}

    def set_robot_type(self, robot_type):
        if not isinstance(robot_type, str) or not robot_type.strip():
            raise bad_request('robot_type is required')
        r = self.ros.call('/set_robot_type', 'physical_ai_interfaces/srv/SetRobotType',
                          {'robot_type': robot_type})
        if not r.get('success'):
            raise ApiError(422, 'command_rejected', r.get('message') or 'Robot type rejected.')
        self.activity.add('ros', 'info', 'Robot type set to %s' % robot_type)
        return {'robot_type': robot_type, 'message': r.get('message', '')}

    def cameras(self):
        r = self.ros.call('/image/get_available_list',
                          'physical_ai_interfaces/srv/GetImageTopicList')
        return {'topics': r.get('image_topic_list') or [], 'message': r.get('message', '')}

    def saved_policies(self):
        r = self.ros.call('/get_saved_policies', 'physical_ai_interfaces/srv/GetSavedPolicyList')
        paths = r.get('saved_policy_path') or []
        types = r.get('saved_policy_type') or []
        return {'policies': [{'path': p, 'type': types[i] if i < len(types) else ''}
                             for i, p in enumerate(paths)]}

    def task(self, body):
        name = str(body.get('command') or '').lower()
        if name not in TASK_COMMANDS:
            raise bad_request('Unknown task command %r' % name,
                              'One of: %s' % ', '.join(TASK_COMMANDS))
        if name in MOTION_COMMANDS and body.get('confirm') is not True:
            raise ApiError(428, 'confirmation_required',
                           'Starting on-robot inference moves the robot under policy control. '
                           'Send "confirm": true after the operator has checked the workspace.')
        ti = normalise_task_info(body.get('task_info'))
        if name == 'start_inference' and not ti['policy_path']:
            raise bad_request('task_info.policy_path is required for inference')
        r = self.ros.call('/task/command', 'physical_ai_interfaces/srv/SendCommand',
                          {'command': TASK_COMMANDS[name], 'task_info': ti})
        level = 'warn' if name in MOTION_COMMANDS else 'info'
        self.activity.add('ros', level, 'Task command %s: %s' % (
            name, 'accepted' if r.get('success') else 'rejected (%s)' % r.get('message')))
        return {'success': bool(r.get('success')), 'message': r.get('message', ''),
                'command': name}

    def hf_control(self, body):
        mode = body.get('mode')
        if mode not in ('upload', 'download', 'cancel'):
            raise bad_request('mode must be upload, download or cancel')
        args = {k: str(body.get(k) or '') for k in ('mode', 'repo_id', 'local_dir', 'repo_type',
                                                    'author')}
        r = self.ros.call('/huggingface/control', 'physical_ai_interfaces/srv/ControlHfServer',
                          args)
        self.activity.add('ros', 'info', 'Hugging Face %s %s: %s' % (
            mode, args['repo_id'], r.get('message', '')))
        return {'success': bool(r.get('success')), 'message': r.get('message', '')}
