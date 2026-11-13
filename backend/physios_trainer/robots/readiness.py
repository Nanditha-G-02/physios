# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Custom robot configuration and progressive readiness (Stages 2-4).

Stage 1  URDF registered            (store.register)
Stage 2  ROS verified               evidence collected by the UI over rosbridge, checked here
                                    against the configuration (names, types, rates)
Stage 3  Hardware verified          supervised one-joint test: the operator authorises it
                                    here (checklist + typed name -> one-time token with a
                                    capped test plan); the UI runs it; the result and its
                                    samples are checked here against the plan
Stage 4  Data & training ready      the feature layout derived from the configuration is
                                    compatible with LeRobot recording and with a policy,
                                    and (optionally) with an existing dataset

This service has no ROS connection of its own (it runs on the host, ROS runs in the
container), so Stage 2/3 evidence comes from the operator's browser. The checks here make
sure that evidence is complete and consistent with the configuration; they cannot prove the
browser was honest. Real motion only ever happens after the explicit authorisation step.

Every verification records a fingerprint of the configuration fields it depends on. Saving a
configuration that changes those fields, or replacing the URDF, withdraws that stage and all
later ones.
"""

import hashlib
import json
import math
import re
import secrets
import time

ROS_DISTROS = ('jazzy', 'humble', 'rolling', 'other')
COMMAND_INTERFACES = {
    'joint_trajectory': 'trajectory_msgs/msg/JointTrajectory',
    'float64_array': 'std_msgs/msg/Float64MultiArray',
    'none': None,
}
IMAGE_TYPES = ('sensor_msgs/msg/CompressedImage', 'sensor_msgs/msg/Image')
UNITS = ('rad', 'deg', 'm', 'mm')
TOPIC = re.compile(r'^/?[A-Za-z_][A-Za-z0-9_]*(/[A-Za-z_][A-Za-z0-9_]*)*$')
NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,63}$')
MOVABLE = ('revolute', 'continuous', 'prismatic')

HW_TOKEN_TTL_S = 180
HW_DEFAULT_TEST_VEL = 0.2       # rad/s (m/s / 10 for prismatic)
HW_MAX_AMPLITUDE = 0.10         # rad (0.01 m prismatic)
CHECKLIST = (
    ('area_clear', 'The robot\'s workspace is clear of people and objects.'),
    ('estop_ready', 'A hardware emergency stop (or power switch) is within reach.'),
    ('robot_supported', 'The robot is mounted/supported so a moving joint cannot make it fall.'),
    ('watching', 'I will watch the robot for the whole test and stop it if anything is wrong.'),
)

POLICY_RULES = {
    'smolvla': {'cameras_min': 1, 'max_dim': 32},
    'act': {'cameras_min': 1, 'max_dim': None},
    'diffusion': {'cameras_min': 1, 'max_dim': None},
    'pi0': {'cameras_min': 1, 'max_dim': 32},
}


class ReadinessError(ValueError):
    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.status = status


def _fp(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()[:16]


def movable_joints(profile):
    v = profile.get('validation') or {}
    return [j for j in (v.get('summary') or {}).get('joint_list') or [] if j['type'] in MOVABLE]


def default_config(profile):
    js = movable_joints(profile)
    return {
        'ros_distro': 'jazzy', 'namespace': '',
        'joint_state_topic': '/joint_states',
        'command_interface': 'joint_trajectory',
        'command_topic': '/arm_controller/joint_trajectory',
        'leader_topic': '', 'driver': '', 'control_frequency_hz': 30,
        'joints': [{'urdf_joint': j['name'], 'ros_joint': j['name'], 'motor_id': i + 1,
                    'direction': 1, 'offset': 0.0,
                    'units': 'm' if j['type'] == 'prismatic' else 'rad', 'enabled': True,
                    'soft_lower': j.get('lower'), 'soft_upper': j.get('upper')}
                   for i, j in enumerate(js)],
        'calibration': {'method': 'manual', 'done': False, 'notes': ''},
        'cameras': [],
        'safety': {'max_velocity': 0.5, 'test_velocity': HW_DEFAULT_TEST_VEL,
                   'require_estop': True},
    }


def _num(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def check_config(profile, cfg):
    """Return (clean_config, issues). Issues: {level, field, text}."""
    issues = []

    def err(field, text):
        issues.append({'level': 'error', 'field': field, 'text': text})

    def warn(field, text):
        issues.append({'level': 'warning', 'field': field, 'text': text})

    if not isinstance(cfg, dict):
        raise ReadinessError('Configuration must be an object.')
    c = default_config(profile)
    for k in ('ros_distro', 'namespace', 'joint_state_topic', 'command_interface',
              'command_topic', 'leader_topic', 'driver'):
        if k in cfg:
            c[k] = str(cfg[k] or '').strip()[:200]
    if c['ros_distro'] not in ROS_DISTROS:
        err('ros_distro', 'Choose one of: %s.' % ', '.join(ROS_DISTROS))
    for k, req in (('joint_state_topic', True), ('command_topic', c['command_interface'] != 'none'),
                   ('leader_topic', False)):
        if c[k] and not TOPIC.match(c[k]):
            err(k, '"%s" is not a valid ROS topic name.' % c[k])
        elif req and not c[k]:
            err(k, 'Required.')
    if c['namespace'] and not TOPIC.match(c['namespace']):
        err('namespace', 'Not a valid ROS namespace.')
    if c['command_interface'] not in COMMAND_INTERFACES:
        err('command_interface', 'Choose one of: %s.' % ', '.join(COMMAND_INTERFACES))
    elif c['command_interface'] == 'none':
        warn('command_interface', 'Read-only: hardware verification (Stage 3) needs a command '
             'interface.')
    f = _num(cfg.get('control_frequency_hz', c['control_frequency_hz']))
    if f is None or not 1 <= f <= 1000:
        err('control_frequency_hz', 'Between 1 and 1000 Hz.')
        f = 30
    c['control_frequency_hz'] = f

    js = {j['name']: j for j in movable_joints(profile)}
    rows = cfg.get('joints', c['joints'])
    if not isinstance(rows, list):
        rows = []
    seen_urdf, seen_ros, seen_motor, out = set(), set(), set(), []
    for i, r in enumerate(rows):
        if not isinstance(r, dict):
            continue
        uj = str(r.get('urdf_joint') or '')
        fld = 'joints.%d' % i
        if uj not in js:
            err(fld, 'URDF joint "%s" does not exist or is not movable.' % uj)
            continue
        if uj in seen_urdf:
            err(fld, 'URDF joint "%s" is mapped twice.' % uj)
            continue
        seen_urdf.add(uj)
        j = js[uj]
        row = {'urdf_joint': uj, 'ros_joint': str(r.get('ros_joint') or '').strip(),
               'enabled': bool(r.get('enabled', True)),
               'direction': -1 if _num(r.get('direction')) == -1 else 1,
               'offset': _num(r.get('offset')) or 0.0,
               'units': r.get('units') if r.get('units') in UNITS else
               ('m' if j['type'] == 'prismatic' else 'rad'),
               'motor_id': r.get('motor_id'), 'soft_lower': _num(r.get('soft_lower')),
               'soft_upper': _num(r.get('soft_upper'))}
        if not NAME.match(row['ros_joint']):
            err(fld, '"%s": ROS joint name is missing or invalid.' % uj)
        elif row['ros_joint'] in seen_ros:
            err(fld, 'ROS joint name "%s" is used twice.' % row['ros_joint'])
        seen_ros.add(row['ros_joint'])
        if row['motor_id'] not in (None, ''):
            m = row['motor_id']
            if not (isinstance(m, int) or (isinstance(m, str) and m.isdigit())) or int(m) > 255:
                err(fld, '"%s": motor ID must be an integer 0-255.' % uj)
            else:
                row['motor_id'] = int(m)
                if row['motor_id'] in seen_motor:
                    err(fld, 'Motor ID %d is used twice.' % row['motor_id'])
                seen_motor.add(row['motor_id'])
        prism = j['type'] == 'prismatic'
        if prism != (row['units'] in ('m', 'mm')):
            err(fld, '"%s": units %s do not fit a %s joint.' % (uj, row['units'], j['type']))
        lo, hi = j.get('lower'), j.get('upper')
        if j['type'] == 'continuous':
            lo, hi = -math.pi, math.pi
        sl = row['soft_lower'] if row['soft_lower'] is not None else lo
        su = row['soft_upper'] if row['soft_upper'] is not None else hi
        if sl is None or su is None or sl >= su:
            err(fld, '"%s": soft limits must have lower < upper.' % uj)
        elif lo is not None and hi is not None and (sl < lo - 1e-9 or su > hi + 1e-9):
            err(fld, '"%s": soft limits %.3f..%.3f must stay inside the URDF limits %.3f..%.3f.'
                % (uj, sl, su, lo, hi))
        row['soft_lower'], row['soft_upper'] = sl, su
        out.append(row)
    missing = [n for n in js if n not in seen_urdf]
    if missing:
        err('joints', 'Movable URDF joints without a mapping: %s.' % ', '.join(missing))
    if not out:
        err('joints', 'No joint mapping.')
    c['joints'] = out

    cal = cfg.get('calibration') if isinstance(cfg.get('calibration'), dict) else {}
    c['calibration'] = {'method': str(cal.get('method') or 'manual')[:40],
                        'done': bool(cal.get('done')), 'notes': str(cal.get('notes') or '')[:500]}
    if not c['calibration']['done']:
        warn('calibration', 'Calibration is not marked as done. Joint values (and the hardware '
             'test) are only meaningful after calibration.')

    cams, names = [], set()
    for i, cm in enumerate(cfg.get('cameras') or []):
        if not isinstance(cm, dict):
            continue
        n = str(cm.get('name') or '').strip()
        t = str(cm.get('topic') or '').strip()
        ty = cm.get('msg_type') or IMAGE_TYPES[0]
        if not NAME.match(n) or n in names:
            err('cameras.%d' % i, 'Camera name "%s" is invalid or duplicated.' % n)
        if not TOPIC.match(t):
            err('cameras.%d' % i, 'Camera topic "%s" is invalid.' % t)
        if ty not in IMAGE_TYPES:
            err('cameras.%d' % i, 'Message type must be one of %s.' % ', '.join(IMAGE_TYPES))
        names.add(n)
        cams.append({'name': n, 'topic': t, 'msg_type': ty})
    c['cameras'] = cams
    if not cams:
        warn('cameras', 'No camera: fine for Stages 2-3, but recording for vision policies '
             '(Stage 4) needs at least one.')

    s = cfg.get('safety') if isinstance(cfg.get('safety'), dict) else {}
    mv = _num(s.get('max_velocity', c['safety']['max_velocity']))
    tv = _num(s.get('test_velocity', c['safety']['test_velocity']))
    if mv is None or mv <= 0:
        err('safety.max_velocity', 'A positive velocity limit is required.')
        mv = c['safety']['max_velocity']
    if tv is None or tv <= 0 or tv > mv:
        err('safety.test_velocity', 'Test velocity must be positive and not above the velocity '
            'limit.')
        tv = min(HW_DEFAULT_TEST_VEL, mv)
    c['safety'] = {'max_velocity': mv, 'test_velocity': min(tv, 0.5),
                   'require_estop': True}
    if tv > 0.5:
        warn('safety.test_velocity', 'Test velocity is capped at 0.5 for the hardware test.')
    return c, issues


def fingerprints(cfg):
    joints = [{k: j[k] for k in ('urdf_joint', 'ros_joint')} for j in cfg['joints']]
    ros = {'ns': cfg['namespace'], 'js': cfg['joint_state_topic'],
           'ci': cfg['command_interface'], 'ct': cfg['command_topic'], 'joints': joints,
           'cams': cfg['cameras']}
    hw = dict(ros, joints=cfg['joints'], safety=cfg['safety'], cal=cfg['calibration']['done'])
    data = {'joints': joints, 'cams': [c['name'] for c in cfg['cameras']],
            'leader': cfg['leader_topic']}
    return {'ros': _fp(ros), 'hardware': _fp(hw), 'data': _fp(data)}


def full_topic(cfg, t):
    ns = cfg.get('namespace') or ''
    if not t or t.startswith('/') or not ns:
        return t if t.startswith('/') or not t else '/' + t
    return '/' + ns.strip('/') + '/' + t


# ---- Stage 2 -----------------------------------------------------------------------------------
def check_ros_evidence(cfg, ev):
    """Return a list of checks {level, id, text}. The evidence is what the UI observed."""
    checks = []

    def add(level, cid, text):
        checks.append({'level': level, 'id': cid, 'text': text})

    if not isinstance(ev, dict):
        return [{'level': 'error', 'id': 'evidence', 'text': 'No evidence.'}]
    age = time.time() - (_num(ev.get('collected_at')) or 0)
    if age > 600 or age < -60:
        add('error', 'stale', 'The checks are older than 10 minutes; run them again.')
    if not ev.get('rosbridge'):
        add('error', 'rosbridge', 'rosbridge was not connected.')
    topics = ev.get('topics') if isinstance(ev.get('topics'), dict) else {}
    jst = full_topic(cfg, cfg['joint_state_topic'])
    if topics.get(jst) != 'sensor_msgs/msg/JointState':
        add('error', 'joint_state_topic', '%s is %s.' % (
            jst, 'not advertised' if jst not in topics else 'of type %s, expected '
            'sensor_msgs/msg/JointState' % topics[jst]))
    else:
        add('ok', 'joint_state_topic', '%s is a JointState topic.' % jst)
    js = ev.get('joint_state') if isinstance(ev.get('joint_state'), dict) else {}
    rate = _num(js.get('rate_hz')) or 0
    if not js.get('received'):
        add('error', 'joint_state_rx', 'No JointState message was received.')
    else:
        names = set(js.get('names') or [])
        need = [j['ros_joint'] for j in cfg['joints'] if j['enabled']]
        miss = [n for n in need if n not in names]
        if miss:
            add('error', 'joint_names', 'JointState lacks the mapped joints: %s (it has: %s).'
                % (', '.join(miss), ', '.join(sorted(names))[:300]))
        else:
            add('ok', 'joint_names', 'All %d mapped joints are present.' % len(need))
        if rate < 5:
            add('error', 'joint_rate', 'JointState arrives at %.1f Hz (need >= 5 Hz).' % rate)
        elif rate < 0.5 * cfg['control_frequency_hz']:
            add('warning', 'joint_rate', 'JointState at %.1f Hz is below half the control '
                'frequency (%g Hz).' % (rate, cfg['control_frequency_hz']))
        else:
            add('ok', 'joint_rate', 'JointState at %.1f Hz.' % rate)
        pos = js.get('positions') if isinstance(js.get('positions'), dict) else {}
        out = []
        for j in cfg['joints']:
            v = _num(pos.get(j['ros_joint']))
            if v is None:
                continue
            x = to_urdf(j, v)
            if x < j['soft_lower'] - 0.05 or x > j['soft_upper'] + 0.05:
                out.append('%s=%.3f' % (j['urdf_joint'], x))
        if out:
            add('warning', 'joint_range', 'Positions outside the soft limits after unit '
                'conversion: %s. Check units, direction, offset and calibration.' %
                ', '.join(out))
    ci = cfg['command_interface']
    if COMMAND_INTERFACES.get(ci):
        ct = full_topic(cfg, cfg['command_topic'])
        want = COMMAND_INTERFACES[ci]
        if topics.get(ct) != want:
            add('error', 'command_topic', '%s is %s (expected %s). Start the driver/controller.'
                % (ct, 'not advertised' if ct not in topics else 'of type %s' % topics[ct], want))
        else:
            add('ok', 'command_topic', '%s (%s) exists.' % (ct, want))
    cams = ev.get('cameras') if isinstance(ev.get('cameras'), dict) else {}
    for cm in cfg['cameras']:
        t = full_topic(cfg, cm['topic'])
        r = cams.get(t) or {}
        if topics.get(t) != cm['msg_type']:
            add('error', 'camera', 'Camera %s: %s is %s.' % (
                cm['name'], t, 'not advertised' if t not in topics else
                'of type %s' % topics[t]))
        elif not r.get('received'):
            add('error', 'camera', 'Camera %s: no image received from %s.' % (cm['name'], t))
        else:
            add('ok', 'camera', 'Camera %s streams (%s).' % (cm['name'], t))
    return checks


def to_urdf(j, raw):
    """ROS value -> URDF value (rad or m)."""
    v = raw
    if j['units'] == 'deg':
        v = math.radians(v)
    elif j['units'] == 'mm':
        v = v / 1000.0
    return j['direction'] * v + j['offset']


# ---- Stage 3 -----------------------------------------------------------------------------------
def hardware_plan(cfg, profile, urdf_joint):
    row = next((j for j in cfg['joints'] if j['urdf_joint'] == urdf_joint and j['enabled']), None)
    if not row:
        raise ReadinessError('Choose an enabled, mapped joint.')
    uj = next(j for j in movable_joints(profile) if j['name'] == urdf_joint)
    prism = uj['type'] == 'prismatic'
    span = row['soft_upper'] - row['soft_lower']
    amp = min(HW_MAX_AMPLITUDE / (10 if prism else 1), 0.1 * span)
    vel = cfg['safety']['test_velocity'] / (10 if prism else 1)
    if uj.get('velocity'):
        vel = min(vel, 0.25 * uj['velocity'])
    vel = max(vel, 1e-3)
    move_s = amp / vel
    return {'joint': urdf_joint, 'ros_joint': row['ros_joint'], 'type': uj['type'],
            'amplitude': round(amp, 5), 'velocity': round(vel, 5),
            'direction_rule': 'toward the middle of the soft range',
            'soft_lower': row['soft_lower'], 'soft_upper': row['soft_upper'],
            'hold_s': 1.0, 'timeout_s': round(2 * move_s + 8, 1),
            'tolerance': round(max(0.02 / (10 if prism else 1), 0.3 * amp), 5),
            'others_tolerance': 0.05, 'stale_ms': 400,
            'command_interface': cfg['command_interface'],
            'command_topic': full_topic(cfg, cfg['command_topic']),
            'joint_state_topic': full_topic(cfg, cfg['joint_state_topic']),
            'rate_hz': min(cfg['control_frequency_hz'], 50)}


def new_token():
    return secrets.token_urlsafe(18)


def check_hardware_result(plan, res):
    """Check the samples of a completed test against its plan. Returns (ok, reasons)."""
    reasons = []
    if res.get('outcome') != 'success':
        return False, ['The test did not complete: %s' % (res.get('reason') or res.get('outcome'))]
    s = res.get('samples')
    if not isinstance(s, list) or len(s) < 5:
        return False, ['Too few joint samples were recorded.']
    pos = [_num(x.get('pos')) for x in s if isinstance(x, dict)]
    oth = [_num(x.get('others_dev')) or 0 for x in s if isinstance(x, dict)]
    if any(p is None for p in pos):
        return False, ['Samples contain invalid positions.']
    start, end = pos[0], pos[-1]
    peak = max(pos, key=lambda p: abs(p - start))
    moved = abs(peak - start)
    tol = plan['tolerance']
    if moved < plan['amplitude'] - tol:
        reasons.append('The joint moved %.4f, less than the commanded %.4f. Check the command '
                       'topic, direction and units.' % (moved, plan['amplitude']))
    if moved > plan['amplitude'] + tol:
        reasons.append('The joint moved %.4f, more than the commanded %.4f (+%.4f tolerance). '
                       'Check units and direction.' % (moved, plan['amplitude'], tol))
    if abs(end - start) > tol:
        reasons.append('The joint did not return to its start position (off by %.4f).' %
                       abs(end - start))
    if peak < plan['soft_lower'] - 1e-6 or peak > plan['soft_upper'] + 1e-6:
        reasons.append('The joint left its soft limits.')
    if max(oth) > plan['others_tolerance']:
        reasons.append('Other joints moved by up to %.3f during the test. Check the joint '
                       'mapping.' % max(oth))
    return not reasons, reasons


# ---- Stage 4 -----------------------------------------------------------------------------------
def features(cfg):
    names = [j['urdf_joint'] for j in cfg['joints'] if j['enabled']]
    f = {'observation.state': {'dtype': 'float32', 'shape': [len(names)], 'names': names},
         'action': {'dtype': 'float32', 'shape': [len(names)], 'names': names}}
    for c in cfg['cameras']:
        f['observation.images.%s' % c['name']] = {'dtype': 'video', 'names':
                                                  ['height', 'width', 'channels']}
    return f


def check_data(cfg, policy=None, dataset_info=None):
    checks = []

    def add(level, cid, text):
        checks.append({'level': level, 'id': cid, 'text': text})

    feats = features(cfg)
    dim = feats['observation.state']['shape'][0]
    ncam = len(cfg['cameras'])
    if not dim:
        add('error', 'state', 'No enabled joints: nothing to record.')
    else:
        add('ok', 'state', 'State and action: %d values (%s).' % (
            dim, ', '.join(feats['observation.state']['names'])))
    if not cfg.get('leader_topic'):
        add('warning', 'leader', 'No leader/teleoperation topic: demonstrations need an action '
            'source (e.g. a leader arm publishing JointTrajectory).')
    compat = {}
    for p, rule in POLICY_RULES.items():
        why = []
        if ncam < rule['cameras_min']:
            why.append('needs at least %d camera' % rule['cameras_min'])
        if rule['max_dim'] and dim > rule['max_dim']:
            why.append('state/action dimension %d > %d' % (dim, rule['max_dim']))
        compat[p] = {'ok': not why and dim > 0, 'why': why}
    good = [p for p, v in compat.items() if v['ok']]
    if policy:
        if policy not in compat:
            add('error', 'policy', 'Unknown policy %s.' % policy)
        elif not compat[policy]['ok']:
            add('error', 'policy', '%s: %s.' % (policy, '; '.join(compat[policy]['why'])))
        else:
            add('ok', 'policy', '%s can be trained on this layout.' % policy)
    elif good:
        add('ok', 'policy', 'Compatible policies: %s.' % ', '.join(good))
    else:
        add('error', 'policy', 'No supported policy fits: %s.' % '; '.join(
            '%s %s' % (p, ', '.join(v['why'])) for p, v in compat.items()))
    if dataset_info is not None:
        df = dataset_info.get('features') or {}
        for key in ('observation.state', 'action'):
            have = df.get(key) or {}
            hs = (have.get('shape') or [None])[0]
            if hs != dim:
                add('error', 'dataset_' + key, 'Dataset %s has %s values, the robot has %d.' % (
                    key, hs, dim))
            else:
                hn = have.get('names')
                if isinstance(hn, dict):
                    hn = next(iter(hn.values()), None)
                if isinstance(hn, list) and hn != feats[key]['names']:
                    add('warning', 'dataset_names', 'Dataset %s names %s differ from the joint '
                        'mapping order %s.' % (key, hn, feats[key]['names']))
                else:
                    add('ok', 'dataset_' + key, 'Dataset %s matches (%d).' % (key, dim))
        dcams = sorted(k.split('.')[-1] for k in df if k.startswith('observation.images.'))
        if dcams != sorted(c['name'] for c in cfg['cameras']):
            add('error', 'dataset_cameras', 'Dataset cameras %s differ from the configured '
                'cameras %s.' % (dcams, sorted(c['name'] for c in cfg['cameras'])))
        else:
            add('ok', 'dataset_cameras', 'Dataset cameras match.')
    return checks, compat, feats


def server_config_yaml(profile, cfg):
    """A physical_ai_server robot config (same layout as config/<robot>_config.yaml)."""
    key = re.sub(r'[^a-z0-9_]', '_', profile['id'].lower())
    lines = ['# Generated by PHYSIOS for the custom robot "%s".' % profile['name'],
             '# Save as <PHYSIOS>/data/robot-config/%s_config.yaml, restart the' % key,
             '# robot runtime, then select "%s" on Home. Review topics before use.' % key,
             'physical_ai_server:', '  ros__parameters:', '    %s:' % key,
             '      observation_list:']
    lines += ['        - %s' % c['name'] for c in cfg['cameras']] + ['        - state', '']
    lines += ['      camera_topic_list:']
    lines += ['        - %s:%s' % (c['name'], full_topic(cfg, c['topic'])) for c in cfg['cameras']]
    lines += ['', '      joint_topic_list:',
              '        - follower:%s' % full_topic(cfg, cfg['joint_state_topic'])]
    if cfg.get('leader_topic'):
        lines.append('        - leader:%s' % full_topic(cfg, cfg['leader_topic']))
    lines += ['', '      joint_list:', '        - leader', '', '      joint_order:',
              '        leader:']
    lines += ['          - %s' % j['ros_joint'] for j in cfg['joints'] if j['enabled']]
    return key, '\n'.join(lines) + '\n'


# ---- readiness summary -------------------------------------------------------------------------
UNLOCKS = {
    1: 'View the model and edit the robot configuration.',
    2: 'Connect the robot in the UI (live joint view) and run the hardware test.',
    3: 'Export the server configuration and record demonstrations.',
    4: 'Train policies on recorded data.',
}


def summarize(profile):
    cfg = profile.get('config')
    ver = profile.get('verifications') or {}
    fps = fingerprints(cfg) if cfg else {}
    cfg_err = [i for i in (profile.get('config_issues') or []) if i['level'] == 'error']
    reg = profile.get('state') == 'registered'
    stage = int(profile.get('stage') or 0)
    stages = []

    def st(n, name, done, blockers, at=None, detail=None):
        status = 'done' if done else ('locked' if stage < n - 1 else 'ready' if not blockers
                                      else 'blocked')
        stages.append({'n': n, 'name': name, 'status': status, 'blockers': blockers,
                       'verified_at': at, 'detail': detail, 'unlocks': UNLOCKS[n]})

    st(1, 'URDF registered', reg and stage >= 1,
       [] if reg else ['Validate the URDF without errors and register it.'])
    b2 = []
    if not cfg:
        b2.append('Save a robot configuration.')
    elif cfg_err:
        b2.append('Fix %d configuration error(s).' % len(cfg_err))
    r = ver.get('ros') or {}
    st(2, 'ROS verified', stage >= 2, b2, r.get('at'),
       r.get('checks'))
    b3 = []
    if cfg and cfg['command_interface'] == 'none':
        b3.append('Set a command interface.')
    if cfg and not cfg['calibration']['done']:
        b3.append('Mark calibration as done.')
    if not profile.get('connected'):
        b3.append('Connect the robot.')
    h = ver.get('hardware') or {}
    st(3, 'Hardware verified', stage >= 3, b3, h.get('at'),
       h.get('result'))
    d = ver.get('data') or {}
    st(4, 'Data & training ready', stage >= 4, [], d.get('at'), d.get('checks'))
    allowed = {'configure': stage >= 1, 'connect': stage >= 2, 'hardware_test': stage >= 2,
               'record': stage >= 3, 'export_server_config': stage >= 3, 'train': stage >= 4}
    summary = '%d/4' % stage
    return {'stage': stage, 'stages': stages, 'allowed': allowed, 'fingerprints': fps,
            'stages_summary': summary}
