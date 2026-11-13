# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

import json
import os
import sys
import time

import pytest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE)

from physical_ai_server.planning.service import CommandError, PlanningService  # noqa
from physical_ai_server.planning.store import Store  # noqa
import synthetic  # noqa

ROBOT = 's101_dataset'


class Ctx:
    def __init__(self):
        self.robot = ROBOT
        self.recording = False

    def as_dict(self):
        return {'get_robot_type': lambda: self.robot, 'is_recording': lambda: self.recording,
                'robot_params': lambda: {'joint_topic_list': ['follower:/joint_states']}}


@pytest.fixture
def env(tmp_path):
    ctx = Ctx()
    svc = PlanningService(store=Store(tmp_path / 'pam'), dataset_root=tmp_path / 'lerobot',
                          context=ctx.as_dict())
    return svc, ctx, tmp_path


def approved_plan(svc, n=4, stype='dynamic'):
    plan = svc.handle('plan.new', {'user_id': 'tester', 'strategy_type': stype})['plan']
    plan['task'].update(name='red_cube', instruction='Pick up the {object}.', episode_count=n)
    plan['task']['workspace']['verified'] = True
    svc.handle('plan.save', {'plan': plan})
    svc.handle('plan.generate', {'plan_id': plan['id']})
    out = svc.handle('plan.approve', {'plan_id': plan['id']})
    assert out['plan']['status'] == 'approved'
    return out['plan']


def wait_for(fn, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(0.05)
    raise AssertionError('timeout')


def record_one(svc, tmp_path, plan, episode_id, retake=False, frames=60):
    begin = svc.handle('record.begin', {'plan_id': plan['id'], 'episode_id': episode_id,
                                        'retake': retake})
    ti = begin['task_info']
    ok, msg = svc.check_start(ti)
    assert ok, msg
    root = tmp_path / 'lerobot'
    ds_path = root / begin['dataset_id']
    if not ds_path.exists():
        synthetic.make_dataset(root, begin['dataset_id'], episodes=0, videos=False)
    synthetic.append_episode(ds_path, n_frames=frames, task=ti['task_instruction'][0],
                             videos=False)
    idx = svc.on_episode_saved(str(ds_path))
    svc.on_recording_finished()
    wait_for(lambda: svc.handle('record.state', {'plan_id': plan['id']})['progress']
             ['active'] is None)
    return idx


def test_plan_lifecycle_and_versions(env):
    svc, _, _ = env
    plan = approved_plan(svc)
    assert svc.handle('plan.list', {})['active_plan_id'] == plan['id']
    # editing an approved plan creates draft v2; the approved v1 stays usable
    edited = svc.handle('plan.update_episode', {
        'plan_id': plan['id'], 'episode_id': 'E001', 'patch': {'instruction': 'x'}})['plan']
    assert edited['status'] == 'draft' and edited['version'] == 2
    state = svc.handle('record.state', {'plan_id': plan['id']})
    assert state['plan']['version'] == 1 and state['working_version'] == 2
    with pytest.raises(CommandError):
        svc.handle('plan.update_episode', {'plan_id': plan['id'], 'episode_id': 'E001',
                                           'patch': {'id': 'hack'}})


def test_approve_blocked_by_errors(env):
    svc, _, _ = env
    plan = svc.handle('plan.new', {'user_id': ''})['plan']
    svc.handle('plan.generate', {'plan_id': plan['id']})
    with pytest.raises(CommandError, match='validation error'):
        svc.handle('plan.approve', {'plan_id': plan['id']})


def test_recording_binds_and_validates(env):
    svc, _, tmp = env
    plan = approved_plan(svc, n=3)
    idx = record_one(svc, tmp, plan, 'E001')
    assert idx == 0
    st = svc.handle('record.state', {'plan_id': plan['id']})
    e = st['progress']['episodes']['E001']
    assert e['status'] == 'validated' and e['dataset_episode_index'] == 0
    assert st['counts']['done'] == 1 and st['counts']['remaining'] == 2
    assert st['next_episode_id'] == 'E002'
    # already recorded -> needs explicit retake
    with pytest.raises(CommandError, match='Retake'):
        svc.handle('record.begin', {'plan_id': plan['id'], 'episode_id': 'E001'})
    record_one(svc, tmp, plan, 'E001', retake=True)
    e = svc.handle('record.state', {'plan_id': plan['id']})['progress']['episodes']['E001']
    assert e['dataset_episode_index'] == 1 and len(e['attempts']) == 2
    eps = svc.handle('data.episodes', {'dataset_id': 'tester/s101_dataset_red_cube'})
    assert eps['episodes'][0]['plan']['superseded'] is True
    assert eps['episodes'][1]['plan']['episode_id'] == 'E001'


def test_short_take_fails_validation(env):
    svc, _, tmp = env
    plan = approved_plan(svc, n=2)
    record_one(svc, tmp, plan, 'E001', frames=3)
    e = svc.handle('record.state', {'plan_id': plan['id']})['progress']['episodes']['E001']
    assert e['status'] == 'validated'  # warning only (3 frames < 1 s)
    assert e['validation']['warnings']


def test_mismatched_start_is_rejected(env):
    svc, _, _ = env
    plan = approved_plan(svc, n=2)
    ti = svc.handle('record.begin', {'plan_id': plan['id'], 'episode_id': 'E002'})['task_info']
    bad = dict(ti, task_instruction=['something else'])
    ok, msg = svc.check_start(bad)
    assert not ok and 'task_instruction' in msg
    ok, _ = svc.check_start(ti)
    assert ok


def test_stopped_without_save_returns_to_pending(env):
    svc, _, _ = env
    plan = approved_plan(svc, n=2)
    ti = svc.handle('record.begin', {'plan_id': plan['id'], 'episode_id': 'E001'})['task_info']
    svc.check_start(ti)
    svc.on_recording_finished()
    e = svc.handle('record.state', {'plan_id': plan['id']})['progress']['episodes']['E001']
    assert e['status'] == 'pending' and e['attempts'][-1]['result'] == 'not_saved'


def test_wrong_robot_and_busy_are_refused(env):
    svc, ctx, _ = env
    plan = approved_plan(svc, n=2)
    ctx.robot = 'omx_f'
    with pytest.raises(CommandError, match='robot type'):
        svc.handle('record.begin', {'plan_id': plan['id'], 'episode_id': 'E001'})
    ctx.robot = ROBOT
    ctx.recording = True
    with pytest.raises(CommandError, match='already recording'):
        svc.handle('record.begin', {'plan_id': plan['id'], 'episode_id': 'E001'})


def test_incomplete_dataset_folder_is_protected(env):
    svc, _, tmp = env
    plan = approved_plan(svc, n=2)
    (tmp / 'lerobot' / 'tester' / 's101_dataset_red_cube' / 'meta').mkdir(parents=True)
    with pytest.raises(CommandError, match='incomplete'):
        svc.handle('record.begin', {'plan_id': plan['id'], 'episode_id': 'E001'})


def test_skip_requires_reason_and_restore(env):
    svc, _, _ = env
    plan = approved_plan(svc, n=2)
    with pytest.raises(CommandError, match='reason'):
        svc.handle('record.skip', {'plan_id': plan['id'], 'episode_id': 'E002'})
    st = svc.handle('record.skip', {'plan_id': plan['id'], 'episode_id': 'E002',
                                    'reason': 'tray broken'})
    assert st['progress']['episodes']['E002']['status'] == 'skipped'
    st = svc.handle('record.restore', {'plan_id': plan['id'], 'episode_id': 'E002'})
    assert st['progress']['episodes']['E002']['status'] == 'pending'


def test_restart_closes_interrupted_take(env):
    svc, ctx, tmp = env
    plan = approved_plan(svc, n=2)
    ti = svc.handle('record.begin', {'plan_id': plan['id'], 'episode_id': 'E001'})['task_info']
    svc.check_start(ti)
    svc2 = PlanningService(store=Store(tmp / 'pam'), dataset_root=tmp / 'lerobot',
                           context=ctx.as_dict())
    e = svc2.handle('record.state', {'plan_id': plan['id']})['progress']['episodes']['E001']
    assert e['attempts'][-1]['result'] == 'interrupted' and e['status'] == 'pending'


def test_data_views_review_and_delete(env):
    svc, _, tmp = env
    plan = approved_plan(svc, n=3)
    for eid in ('E001', 'E002', 'E003'):
        record_one(svc, tmp, plan, eid)
    ds_id = 'tester/s101_dataset_red_cube'
    lst = svc.handle('data.list_datasets', {})['datasets']
    assert lst[0]['id'] == ds_id and lst[0]['plans']
    ov = svc.handle('data.overview', {'dataset_id': ds_id})
    assert ov['total_episodes'] == 3 and ov['planning_type'] == 'dynamic'
    ep = svc.handle('data.episode', {'dataset_id': ds_id, 'episode_index': 1})
    assert len(ep['state']) == 60 and len(ep['state_names']) == 6
    assert ep['plan']['episode_id'] == 'E002'
    svc.handle('data.review', {'dataset_id': ds_id, 'episode_index': 0, 'status': 'rejected',
                               'comment': 'dropped', 'failure_categories': ['dropped_object']})
    svc.handle('data.review', {'dataset_id': ds_id, 'episode_index': 2,
                               'status': 'accepted'})
    with pytest.raises(CommandError):
        svc.handle('data.review', {'dataset_id': ds_id, 'episode_index': 1,
                                   'failure_categories': ['nope']})
    with pytest.raises(CommandError, match='confirm'):
        svc.handle('data.delete_episodes', {'dataset_id': ds_id, 'episode_indices': [0]})
    job = svc.handle('data.delete_episodes', {'dataset_id': ds_id, 'episode_indices': [0],
                                              'confirm': ds_id})
    done = wait_for(lambda: (lambda j: j if j['status'] != 'running' else None)(
        svc.handle('job.status', {'job_id': job['id']})))
    assert done['status'] == 'done', done['message']
    eps = svc.handle('data.episodes', {'dataset_id': ds_id})['episodes']
    assert len(eps) == 2
    assert eps[0]['plan']['episode_id'] == 'E002' and eps[1]['review']['status'] == 'accepted'
    st = svc.handle('record.state', {'plan_id': plan['id']})
    assert st['progress']['episodes']['E001']['status'] == 'pending'
    assert st['progress']['episodes']['E003']['dataset_episode_index'] == 1


def test_handle_json_reports_errors(env):
    svc, _, _ = env
    ok, msg, res = svc.handle_json('plan.get', json.dumps({'plan_id': 'nope'}))
    assert not ok and 'not found' in msg
    ok, msg, _ = svc.handle_json('does.not_exist', '{}')
    assert not ok and 'Unknown command' in msg
    ok, _, res = svc.handle_json('meta', '{}')
    assert ok and 'static' in json.loads(res)['strategy_types']


def test_github_preview_has_no_large_files(env):
    svc, _, tmp = env
    plan = approved_plan(svc, n=1)
    record_one(svc, tmp, plan, 'E001')
    prev = svc.handle('github.preview', {'dataset_id': 'tester/s101_dataset_red_cube',
                                         'hf_repo': 'tester/red'})
    paths = [f['path'] for f in prev['files']]
    assert any(p.endswith('README.md') for p in paths)
    assert any('collection_plan_' in p for p in paths)
    assert not any(p.endswith(('.mp4', '.parquet')) and 'tasks' not in p for p in paths)


def test_github_requires_token(env):
    svc, _, _ = env
    assert svc.handle('github.status', {}) == {'signed_in': False}
    with pytest.raises(Exception, match='Not signed in'):
        svc.handle('github.repos', {})


def test_review_setting_persists_and_queue_follows_it(env):
    svc, ctx, tmp = env
    assert svc.handle('settings.get', {})['record_review_enabled'] is False
    plan = approved_plan(svc, n=3)
    record_one(svc, tmp, plan, 'E001')  # saved while review OFF
    assert svc.handle('record.recent', {})['awaiting_review'] == []
    time.sleep(1.1)  # settings timestamps have 1 s resolution
    svc.handle('settings.set', {'record_review_enabled': True})
    record_one(svc, tmp, plan, 'E002')
    rec = svc.handle('record.recent', {})
    assert [r['episode_index'] for r in rec['awaiting_review']] == [1]
    assert rec['awaiting_review'][0]['episode_id'] == 'E002'
    assert rec['recent'][0]['episode_index'] == 1 and rec['recent'][1]['episode_index'] == 0
    # survives a restart of the service
    svc2 = PlanningService(store=Store(tmp / 'pam'), dataset_root=tmp / 'lerobot',
                           context=ctx.as_dict())
    assert svc2.handle('settings.get', {})['record_review_enabled'] is True
    assert len(svc2.handle('record.recent', {})['awaiting_review']) == 1


def test_reject_in_review_sends_plan_episode_back_and_keeps_take(env):
    svc, _, tmp = env
    plan = approved_plan(svc, n=2)
    record_one(svc, tmp, plan, 'E001')
    ds_id = 'tester/s101_dataset_red_cube'
    rec = svc.handle('data.review', {'dataset_id': ds_id, 'episode_index': 0,
                                     'status': 'rejected', 'comment': 'slipped',
                                     'failure_categories': ['missed_grasp'],
                                     'source': 'record'})
    assert rec['plan_sync'] == {'plan_id': plan['id'], 'episode_id': 'E001',
                                'status': 'pending'}
    st = svc.handle('record.state', {'plan_id': plan['id']})
    assert st['progress']['episodes']['E001']['status'] == 'pending'
    assert st['next_episode_id'] == 'E001'
    # the rejected take is preserved in the dataset and marked in metadata
    eps = svc.handle('data.episodes', {'dataset_id': ds_id})['episodes']
    assert len(eps) == 1 and eps[0]['review']['status'] == 'rejected'
    meta = json.loads((tmp / 'lerobot' / ds_id / 'meta' / 'episode_reviews.json').read_text())
    assert meta['episodes']['0']['status'] == 'rejected'
    assert meta['episodes']['0']['comment'] == 'slipped'
    ov = svc.handle('data.overview', {'dataset_id': ds_id})
    assert ov['review_counts']['rejected'] == 1 and ov['review_counts']['pending'] == 0
    # changing the decision back to accepted restores the plan episode
    svc.handle('data.review', {'dataset_id': ds_id, 'episode_index': 0, 'status': 'accepted'})
    st = svc.handle('record.state', {'plan_id': plan['id']})
    assert st['progress']['episodes']['E001']['status'] == 'validated'


def test_free_recording_saves_are_listed_for_review(env):
    svc, _, tmp = env
    svc.handle('settings.set', {'record_review_enabled': True})
    time.sleep(1.1)
    ds_path = synthetic.make_dataset(tmp / 'lerobot', 'tester/s101_dataset_free', episodes=0,
                                     videos=False)
    synthetic.append_episode(ds_path, n_frames=30, videos=False)
    svc.on_episode_saved(str(ds_path))  # no plan bound: free recording
    rec = svc.handle('record.recent', {})
    assert rec['awaiting_review'][0]['dataset_id'] == 'tester/s101_dataset_free'
    assert rec['awaiting_review'][0]['plan_id'] is None
    svc.handle('data.review', {'dataset_id': 'tester/s101_dataset_free', 'episode_index': 0,
                               'status': 'needs_review', 'source': 'record'})
    assert svc.handle('record.recent', {})['awaiting_review'] == []
    counts = svc.handle('data.overview', {'dataset_id': 'tester/s101_dataset_free'})[
        'review_counts']
    assert counts['pending'] == 1 and counts['total'] == 1
