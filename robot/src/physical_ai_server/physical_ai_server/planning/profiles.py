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

"""Robot workspace profiles used by the planning engine.

All coordinates are top-down, in millimetres, in a table frame whose origin is
the centre of the robot base: +x points away from the robot (forward), +y
points to the robot's left.  The numbers below are conservative starting
values, not measurements of the operator's cell: the Planning page shows them
as "default - verify on your table" until the operator edits or confirms them.
"""

import copy
import re

ROBOT_PROFILES = {
    'so101': {
        'label': 'SO-101 arm',
        'kinematics': 'so101',
        'reach_min_mm': 90,
        'reach_max_mm': 300,
        'workspace': {'x_min_mm': 60, 'x_max_mm': 320, 'y_min_mm': -220, 'y_max_mm': 220},
        'base_keepout_mm': 70,
        'default_fps': 30,
        'notes': 'Single 5-DoF arm + gripper. Reach values are conservative defaults.',
    },
    'omx': {
        'label': 'OpenMANIPULATOR-X',
        'kinematics': 'generic',
        'reach_min_mm': 90,
        'reach_max_mm': 330,
        'workspace': {'x_min_mm': 60, 'x_max_mm': 340, 'y_min_mm': -240, 'y_max_mm': 240},
        'base_keepout_mm': 70,
        'default_fps': 15,
        'notes': 'Defaults - verify against your table.',
    },
    'omy': {
        'label': 'OpenMANIPULATOR-Y',
        'kinematics': 'generic',
        'reach_min_mm': 150,
        'reach_max_mm': 600,
        'workspace': {'x_min_mm': 120, 'x_max_mm': 620, 'y_min_mm': -450, 'y_max_mm': 450},
        'base_keepout_mm': 120,
        'default_fps': 15,
        'notes': 'Defaults - verify against your table.',
    },
    'ffw': {
        'label': 'AI Worker (bimanual)',
        'kinematics': 'generic',
        'reach_min_mm': 200,
        'reach_max_mm': 650,
        'workspace': {'x_min_mm': 200, 'x_max_mm': 700, 'y_min_mm': -450, 'y_max_mm': 450},
        'base_keepout_mm': 180,
        'default_fps': 15,
        'notes': 'Bimanual platform. Defaults - verify against your table.',
    },
    'generic': {
        'label': 'Generic arm',
        'kinematics': 'generic',
        'reach_min_mm': 100,
        'reach_max_mm': 400,
        'workspace': {'x_min_mm': 80, 'x_max_mm': 420, 'y_min_mm': -300, 'y_max_mm': 300},
        'base_keepout_mm': 80,
        'default_fps': 30,
        'notes': 'No profile for this robot type - enter your own workspace.',
    },
}

_PATTERNS = [
    (re.compile(r'(so[-_]?10[01]|s10[01])', re.I), 'so101'),
    (re.compile(r'omx', re.I), 'omx'),
    (re.compile(r'omy', re.I), 'omy'),
    (re.compile(r'ffw|ai[_-]?worker', re.I), 'ffw'),
]


def profile_key_for_robot(robot_type: str) -> str:
    for pattern, key in _PATTERNS:
        if robot_type and pattern.search(robot_type):
            return key
    return 'generic'


def profile_for_robot(robot_type: str) -> dict:
    key = profile_key_for_robot(robot_type or '')
    profile = copy.deepcopy(ROBOT_PROFILES[key])
    profile['key'] = key
    profile['robot_type'] = robot_type or ''
    return profile


def default_workspace(robot_type: str) -> dict:
    """Workspace block stored inside a plan (operator-editable copy)."""
    profile = profile_for_robot(robot_type)
    ws = dict(profile['workspace'])
    ws.update({
        'reach_min_mm': profile['reach_min_mm'],
        'reach_max_mm': profile['reach_max_mm'],
        'base_keepout_mm': profile['base_keepout_mm'],
        'margin_mm': 10,
        'keepouts': [],
        'verified': False,
        'profile_key': profile['key'],
    })
    return ws


def default_regions(workspace: dict) -> list:
    """Left / Centre / Right bands across the reachable part of the table."""
    x0 = max(workspace['x_min_mm'], workspace['reach_min_mm'])
    x1 = min(workspace['x_max_mm'], workspace['reach_max_mm'])
    y_min, y_max = workspace['y_min_mm'], workspace['y_max_mm']
    third = (y_max - y_min) / 3.0
    names = [('L', 'Left', y_max - third, y_max),
             ('C', 'Centre', y_min + third, y_max - third),
             ('R', 'Right', y_min, y_min + third)]
    return [
        {'id': rid, 'name': name, 'x_min_mm': round(x0), 'x_max_mm': round(x1),
         'y_min_mm': round(lo), 'y_max_mm': round(hi)}
        for rid, name, lo, hi in names
    ]
