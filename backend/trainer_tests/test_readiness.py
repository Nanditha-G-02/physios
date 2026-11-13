# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0
"""Custom robot configuration and Stages 2-4 (Phase 4)."""
import copy
import math
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

from physios_trainer.robots import readiness as rd  # noqa: E402
from physios_trainer.robots.store import RobotError, RobotStore  # noqa: E402
import robot_fixtures as rf  # noqa: E402


@pytest.fixture()
def reg(tmp_path):
    st = RobotStore(tmp_path)
    rid = st.create({'name': 'Arm'})['id']
    st.add_zip(rid, rf.arm_zip())
    st.validate(rid)
    st.register(rid)
    return st, rid


def good_cfg(st, rid, **over):
    c = copy.deepcopy(st.default_config(rid))
    c['calibration']['done'] = True
    c['cameras'] = [{'name': 'cam1', 'topic': '/cam1/image_raw/compressed',
                     'msg_type': 'sensor_msgs/msg/CompressedImage'}]
    c['leader_topic'] = '/leader/joint_trajectory'
    c.update(over)
    return c


def evidence(cfg, **over):
    names = [j['ros_joint'] for j in cfg['joints']]
    ev = {'collected_at': time.time(), 'rosbridge': True,
          'topics': {'/joint_states': 'sensor_msgs/msg/JointState',
                     '/arm_controller/joint_trajectory': 'trajectory_msgs/msg/JointTrajectory',
                     '/cam1/image_raw/compressed': 'sensor_msgs/msg/CompressedImage'},
          'joint_state': {'received': True, 'rate_hz': 50, 'names': names,
                          'positions': {n: 0.0 for n in names}},
          'cameras': {'/cam1/image_raw/compressed': {'received': True}}}
    ev.update(over)
    return ev


def samples(amp, start=0.1, others=0.0, back=True):
    s = [{'t': i * 0.05, 'pos': start + amp * min(i, 10) / 10, 'others_dev': others}
         for i in range(15)]
    s += [{'t': 1 + i * 0.05, 'pos': start + amp * (10 - i) / 10 if back else start + amp,
           'others_dev': others} for i in range(11)]
    return s


def test_default_and_validation(reg):
    st, rid = reg
    d = st.default_config(rid)
    assert [j['urdf_joint'] for j in d['joints']] == ['j1', 'j2', 'j3']
    p = st.get(rid)
    bad = good_cfg(st, rid, joint_state_topic='bad topic!', control_frequency_hz=5000)
    bad['joints'][0]['soft_upper'] = 3.0  # outside URDF +-1.57
    bad['joints'][1]['ros_joint'] = bad['joints'][2]['ros_joint']
    bad['joints'][2]['units'] = 'mm'  # revolute in mm
    c, issues = rd.check_config(p, bad)
    fields = {i['field'] for i in issues if i['level'] == 'error'}
    assert {'joint_state_topic', 'control_frequency_hz', 'joints.0', 'joints.2'} <= fields
    texts = ' '.join(i['text'] for i in issues)
    assert 'used twice' in texts and 'do not fit' in texts and 'inside the URDF limits' in texts
    c, issues = rd.check_config(p, good_cfg(st, rid))
    assert not [i for i in issues if i['level'] == 'error'], issues
    # unmapped joint
    g = good_cfg(st, rid)
    g['joints'] = g['joints'][:2]
    _, issues = rd.check_config(p, g)
    assert any('without a mapping' in i['text'] for i in issues)


def test_stage_flow_and_gates(reg):
    st, rid = reg
    with pytest.raises(RobotError, match='Stage 2'):
        st.set_connected(rid, True)
    with pytest.raises(RobotError, match='configuration'):
        st.verify_ros(rid, {})
    p = st.save_config(rid, good_cfg(st, rid))
    assert p['readiness']['stages'][1]['status'] == 'ready'
    cfg = p['config']
    # failing evidence: missing joint name & command topic
    ev = evidence(cfg)
    ev['joint_state']['names'] = ['j1']
    del ev['topics']['/arm_controller/joint_trajectory']
    r = st.verify_ros(rid, ev)
    assert not r['ok'] and r['robot']['stage'] == 1
    assert {'joint_names', 'command_topic'} <= {c['id'] for c in r['checks'] if c['level'] == 'error'}
    # stale evidence
    r = st.verify_ros(rid, evidence(cfg, collected_at=time.time() - 3600))
    assert not r['ok']
    r = st.verify_ros(rid, evidence(cfg))
    assert r['ok'] and r['robot']['stage'] == 2
    # hardware gates
    with pytest.raises(RobotError, match='Connect'):
        st.hardware_authorize(rid, 'j1', {}, 'Arm')
    st.set_connected(rid, True)
    with pytest.raises(RobotError, match='safety'):
        st.hardware_authorize(rid, 'j1', {'area_clear': True}, 'Arm')
    allc = {k: True for k, _ in rd.CHECKLIST}
    with pytest.raises(RobotError, match='name'):
        st.hardware_authorize(rid, 'j1', allc, 'arm')
    with pytest.raises(RobotError, match='Stage 3'):
        st.server_config(rid)
    with pytest.raises(RobotError, match='Stage 3'):
        st.verify_data(rid)
    a = st.hardware_authorize(rid, 'j1', allc, 'Arm')
    plan = a['plan']
    assert plan['amplitude'] <= 0.1 and plan['velocity'] <= 0.2
    assert plan['soft_lower'] == -1.57 and plan['ros_joint'] == 'j1'
    # bad result: joint did not move
    r = st.hardware_result(rid, a['token'], {'outcome': 'success', 'samples': samples(0.0)})
    assert not r['ok'] and 'less than' in r['reasons'][0]
    # token is single use
    with pytest.raises(RobotError, match='already used'):
        st.hardware_result(rid, a['token'], {'outcome': 'success', 'samples': samples(0.1)})
    a = st.hardware_result  # noqa
    a = st.hardware_authorize(rid, 'j1', allc, 'Arm')
    r = st.hardware_result(rid, a['token'], {'outcome': 'success',
                                             'samples': samples(plan['amplitude'], others=0.2)})
    assert not r['ok'] and 'Other joints' in r['reasons'][0]
    a = st.hardware_authorize(rid, 'j1', allc, 'Arm')
    r = st.hardware_result(rid, a['token'], {'outcome': 'aborted', 'reason': 'operator stop'})
    assert not r['ok']
    a = st.hardware_authorize(rid, 'j1', allc, 'Arm')
    r = st.hardware_result(rid, a['token'], {'outcome': 'success',
                                             'samples': samples(plan['amplitude'])})
    assert r['ok'] and r['robot']['stage'] == 3, r
    assert r['robot']['readiness']['allowed']['record']
    assert not r['robot']['readiness']['allowed']['train']
    y = st.server_config(rid)
    assert 'follower:/joint_states' in y['yaml'] and 'leader:/leader/joint_trajectory' in y['yaml']
    assert 'cam1:/cam1/image_raw/compressed' in y['yaml'] and y['filename'].endswith('_config.yaml')
    # data: incompatible dataset, then OK
    info = {'features': {'observation.state': {'shape': [6]}, 'action': {'shape': [6]},
                         'observation.images.front': {}}}
    r = st.verify_data(rid, 'smolvla', info, 'o/ds')
    assert not r['ok'] and r['robot']['stage'] == 3
    r = st.verify_data(rid, 'smolvla')
    assert r['ok'] and r['robot']['stage'] == 4
    assert r['features']['observation.state']['names'] == ['j1', 'j2', 'j3']
    # persisted
    assert RobotStore(st.root.parent).get(rid)['stage'] == 4
    # changing safety drops Stage 3 (and 4) but keeps Stage 2
    c2 = st.get(rid)['config']
    c2['safety']['test_velocity'] = 0.1
    p = st.save_config(rid, c2)
    assert p['stage'] == 2 and 'hardware' not in p['verifications']
    # changing topics drops to Stage 1 and disconnects
    c2['joint_state_topic'] = '/other/joint_states'
    p = st.save_config(rid, c2)
    assert p['stage'] == 1 and not p['connected']


def test_disconnect_revokes_token(reg):
    st, rid = reg
    cfg = st.save_config(rid, good_cfg(st, rid))['config']
    st.verify_ros(rid, evidence(cfg))
    st.set_connected(rid, True)
    a = st.hardware_authorize(rid, 'j2', {k: True for k, _ in rd.CHECKLIST}, 'Arm')
    st.set_connected(rid, False)
    with pytest.raises(RobotError):
        st.hardware_result(rid, a['token'], {'outcome': 'success', 'samples': samples(0.1)})


def test_hardware_needs_calibration_and_command(reg):
    st, rid = reg
    cfg = good_cfg(st, rid)
    cfg['calibration']['done'] = False
    cfg = st.save_config(rid, cfg)['config']
    st.verify_ros(rid, evidence(cfg))
    st.set_connected(rid, True)
    with pytest.raises(RobotError, match='calibration'):
        st.hardware_authorize(rid, 'j1', {k: True for k, _ in rd.CHECKLIST}, 'Arm')


def test_result_checks():
    plan = {'amplitude': 0.1, 'tolerance': 0.03, 'soft_lower': -1, 'soft_upper': 1,
            'others_tolerance': 0.05}
    assert rd.check_hardware_result(plan, {'outcome': 'success', 'samples': samples(0.1)})[0]
    ok, why = rd.check_hardware_result(plan, {'outcome': 'success', 'samples': samples(0.3)})
    assert not ok and 'more than' in why[0]
    ok, why = rd.check_hardware_result(plan, {'outcome': 'success',
                                              'samples': samples(0.1, back=False)})
    assert not ok and 'return' in why[0]
    ok, why = rd.check_hardware_result(plan, {'outcome': 'success',
                                              'samples': samples(0.1, start=0.95)})
    assert not ok and any('soft limits' in w for w in why)
    assert not rd.check_hardware_result(plan, {'outcome': 'success', 'samples': []})[0]


def test_units_conversion():
    j = {'units': 'deg', 'direction': -1, 'offset': 0.5}
    assert math.isclose(rd.to_urdf(j, 90), -math.pi / 2 + 0.5)
    assert math.isclose(rd.to_urdf({'units': 'mm', 'direction': 1, 'offset': 0}, 20), 0.02)


def test_replace_resets_all_stages(reg):
    st, rid = reg
    cfg = st.save_config(rid, good_cfg(st, rid))['config']
    st.verify_ros(rid, evidence(cfg))
    st.replace_urdf(rid)
    p = st.get(rid)
    assert p['stage'] == 0 and p['verifications'] == {} and p['config']
    st.add_zip(rid, rf.arm_zip())
    st.validate(rid)
    p = st.register(rid)
    assert p['stage'] == 1 and p['config']['joints']
