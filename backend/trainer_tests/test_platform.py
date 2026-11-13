# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Storage guard, queue, evaluations and the dataset health probe."""

import json
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from physios_trainer import storage  # noqa: E402
from physios_trainer.evaluations import Evaluations, wilson  # noqa: E402
from physios_trainer.jobqueue import JobQueue, Notifier  # noqa: E402


class FakeRuns:
    def __init__(self, runs=None):
        self._runs = runs or []
        self.created = []

    def list(self):
        return self._runs

    def active(self):
        return next((r for r in self._runs if r['status'] == 'training'), None)


def make_run(tmp_path, rid, steps=(10, 20, 30), status='succeeded', policy='act', keep=()):
    out = tmp_path / 'out' / rid
    ck = out / 'checkpoints'
    for s in steps:
        d = ck / ('%06d' % s) / 'pretrained_model'
        d.mkdir(parents=True)
        (d / 'model.safetensors').write_bytes(b'x' * 1000)
    (ck / 'last').symlink_to(ck / ('%06d' % steps[-1]))
    return {'id': rid, 'job_name': rid, 'status': status, 'output_dir': str(out),
            'plan': {'policy': policy,
                     'dataset_root': str(tmp_path / 'data' / 'datasets' / 'o' / 'copy1')},
            'keep_steps': list(keep)}


def test_estimate_blocks_when_disk_too_small(tmp_path, monkeypatch):
    plan = {'policy': 'act', 'output_dir': str(tmp_path / 'o'), 'resources': {
        'snapshot_bytes': 5 * 1024 ** 3}, 'snapshot': str(tmp_path / 's')}
    monkeypatch.setattr(storage, 'free_bytes', lambda p: 3 * 1024 ** 3)
    est = storage.estimate(plan, {'steps': 100, 'save_freq': 10}, [])
    assert est['checkpoint_count'] == 10
    assert est['errors'] and 'Not enough disk space' in est['errors'][0]
    monkeypatch.setattr(storage, 'free_bytes', lambda p: 10 ** 15)
    assert not storage.estimate(plan, {'steps': 100, 'save_freq': 10}, [])['errors']


def test_estimate_uses_measured_checkpoint_size(tmp_path):
    r = make_run(tmp_path, 'r1')
    assert storage.measured_ckpt_bytes([r], 'act') >= 1000
    est = storage.estimate({'policy': 'act', 'output_dir': str(tmp_path / 'x'),
                            'resources': {}}, {'steps': 30, 'save_freq': 10}, [r])
    assert 'measured' in est['items'][0]['detail']


def test_cleanup_protects_last_evaluated_keep_and_in_use(tmp_path):
    data = tmp_path / 'data'
    copy1 = data / 'datasets' / 'o' / 'copy1'
    copy2 = data / 'datasets' / 'o' / 'copy2'
    for c in (copy1, copy2):
        (c / 'meta').mkdir(parents=True)
    original = tmp_path / 'recorded' / 'o' / 'ds'
    original.mkdir(parents=True)
    r = make_run(tmp_path, 'r1', steps=(10, 20, 30, 40), keep=(20,))
    queued = {str(copy1)}
    ev = Evaluations(data)
    ev.add({'run_id': 'r1', 'step': 30, 'outcome': 'success'},
           lambda rid, s: {'path': 'p', 'policy_type': 'act'})
    st = storage.Storage(data, FakeRuns([r]), ev, queued_roots=lambda: queued)
    inv = st.inventory()
    by = {Path(x['path']).name: x for x in inv['checkpoints']}
    assert not by['000010']['protected']
    assert by['000020']['reason'] == 'marked keep'
    assert by['000030']['reason'] == 'has evaluation results'
    assert by['000040']['reason'] == 'last checkpoint of the run'
    copies = {Path(x['path']).name: x for x in inv['copies']}
    assert copies['copy1']['protected'] and not copies['copy2']['protected']
    with pytest.raises(ValueError):
        st.cleanup([by['000010']['path']], 'yes')
    res = st.cleanup([by['000010']['path'], by['000040']['path'], str(copy1), str(copy2),
                      str(original)], 'DELETE')
    assert {Path(d['path']).name for d in res['deleted']} == {'000010', 'copy2'}
    assert len(res['refused']) == 3
    assert original.exists() and copy1.exists() and not copy2.exists()
    assert 'deleted' in (data / 'cleanup.log').read_text()


def test_cleanup_shared_output_dir_uses_union_of_protection(tmp_path):
    data = tmp_path / 'data'
    a = make_run(tmp_path, 'r1', steps=(10, 20, 30))
    b = dict(a, id='r2', created_at='z', keep_steps=[])   # resumed run, same folder
    a['created_at'] = 'a'
    ev = Evaluations(data)
    ev.add({'run_id': 'r2', 'step': 10, 'outcome': 'success'},
           lambda rid, s: {'path': 'p', 'policy_type': 'act'})
    st = storage.Storage(data, FakeRuns([a, b]), ev)
    rows = st.inventory()['checkpoints']
    assert len(rows) == 3                     # listed once, not once per run
    by = {r['step']: r for r in rows}
    assert by[10]['protected'] and by[10]['reason'] == 'has evaluation results'
    assert not by[20]['protected'] and by[30]['protected']


def test_queue_runs_in_order_and_holds_changed_commands(tmp_path):
    runs = FakeRuns()
    tokens = {'a': 't1', 'b': 't2'}
    started = []

    def plan_fn(cfg):
        return {'ok': True, 'errors': [], 'token': tokens[cfg['job']], 'job_name': cfg['job'],
                'policy': 'act', 'output_dir': '/o/' + cfg['job'], 'stages': [{'kind': 'train'}],
                'dataset_root': '/d', 'env': {}}

    def start_fn(plan, cfg):
        r = {'id': 'run-' + cfg['job'], 'status': 'training'}
        runs._runs.append(r)
        started.append(cfg['job'])
        return r

    n = Notifier(tmp_path)
    q = JobQueue(tmp_path, plan_fn, start_fn, runs, lambda: [], n, interval=3600)
    q.add({'job': 'a'}, 't1', plan_fn({'job': 'a'}))
    q.add({'job': 'b'}, 't2', plan_fn({'job': 'b'}))
    with pytest.raises(ValueError):
        q.add({'job': 'b'}, 't2', plan_fn({'job': 'b'}))
    q.tick()
    assert started == ['a']
    q.tick()   # 'a' still training -> nothing new
    assert started == ['a']
    runs._runs[0]['status'] = 'succeeded'
    tokens['b'] = 'changed'
    q.tick()
    items = {i['job_name']: i for i in q.list()}
    assert started == ['a'] and items['b']['status'] == 'needs_review'
    with pytest.raises(ValueError):
        q.confirm(items['b']['id'], 't2')
    q.confirm(items['b']['id'], 'changed')
    q.tick()
    assert started == ['a', 'b']
    ev = n.since(0)['events']
    assert any('needs review' in e['title'] for e in ev)
    assert any(e['title'] == 'Training started' for e in ev)


def test_evaluations_summary_and_validation(tmp_path):
    ev = Evaluations(tmp_path)

    def look(rid, s):
        return {'path': '/ck/%s' % s, 'policy_type': 'act'} if s in (10, 20) else None
    for o in ('success', 'success', 'failed_grasp', 'success'):
        ev.add({'run_id': 'r', 'step': 10, 'outcome': o, 'object': {'x_mm': 120, 'y_mm': -30}},
               look)
    ev.add({'run_id': 'r', 'step': 20, 'outcome': 'collision'}, look)
    with pytest.raises(ValueError):
        ev.add({'run_id': 'r', 'step': 99, 'outcome': 'success'}, look)
    with pytest.raises(ValueError):
        ev.add({'run_id': 'r', 'step': 10, 'outcome': 'great'}, look)
    with pytest.raises(ValueError):
        ev.add({'run_id': 'r', 'step': 10, 'outcome': 'success', 'object': {'x_mm': 'abc'}},
               look)
    s = {g['step']: g for g in ev.summary()}
    assert s[10]['n'] == 4 and s[10]['success'] == 3 and s[10]['rate'] == 0.75
    lo, hi = s[10]['ci']
    assert 0.2 < lo < 0.75 < hi <= 1
    assert s[20]['outcomes']['collision'] == 1
    tid = ev.list(step=20)[0]['id']
    ev.delete(tid)
    assert (tmp_path / 'evaluations' / 'deleted' / ('%s.json' % tid)).exists()
    assert 20 not in {g['step'] for g in ev.summary()}
    assert wilson(0, 0) == (None, None)


LEROBOT_PY = None
for cand in ('/tmp/claude-0/lrenv/bin/python', shutil.which('python3')):
    if cand:
        try:
            subprocess.run([cand, '-c', 'import numpy, pyarrow'], check=True,
                           capture_output=True)
            LEROBOT_PY = cand
            break
        except (subprocess.CalledProcessError, OSError):
            pass


@pytest.mark.skipif(not LEROBOT_PY, reason='needs numpy + pyarrow')
def test_health_probe_flags_bad_episodes(tmp_path):
    import numpy as np
    import pyarrow as pa
    import pyarrow.parquet as pq
    root = tmp_path / 'ds'
    (root / 'meta').mkdir(parents=True)
    (root / 'data' / 'chunk-000').mkdir(parents=True)
    names = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll',
             'gripper']
    (root / 'meta' / 'info.json').write_text(json.dumps({
        'codebase_version': 'v2.1', 'fps': 30, 'total_episodes': 3,
        'features': {'action': {'dtype': 'float32', 'shape': [6], 'names': names},
                     'observation.state': {'dtype': 'float32', 'shape': [6],
                                           'names': names}}}))
    t = np.linspace(0, 1, 300)
    good = np.stack([np.sin(t * 6) * 40, np.cos(t * 5) * 30, t * 50, t * 20, t * 0,
                     np.where((t > .3) & (t < .7), 5.0, 90.0)], 1)
    no_grasp = good.copy()
    no_grasp[:, 5] = 90.0
    idle = np.tile(good[:1], (300, 1))
    idle[150:160, 0] += np.linspace(0, 30, 10)
    for ep, arr in enumerate((good, no_grasp, idle)):
        rows = {'action': arr.tolist(), 'observation.state': arr.tolist(),
                'episode_index': [ep] * len(arr), 'frame_index': list(range(len(arr))),
                'timestamp': (np.arange(len(arr)) / 30.0).tolist()}
        if ep == 2:
            rows['action'][5][1] = None
        pq.write_table(pa.table(rows), root / 'data' / 'chunk-000' /
                       ('episode_%06d.parquet' % ep))
    out = tmp_path / 'h.json'
    probe = HERE.parent / 'physios_trainer' / 'health_probe.py'
    p = subprocess.run([LEROBOT_PY, '-I', str(probe), str(root), str(out)],
                       capture_output=True, text=True)
    assert p.returncode == 0, p.stdout + p.stderr
    r = json.loads(out.read_text())
    codes = {e['episode']: {i['code'] for i in e['issues']} for e in r['episodes']}
    assert r['gripper_joint'] == 'gripper'
    assert r['episodes'][0]['gripper_changes'] == 2 and not codes[0] - {'idle_edges'}
    assert 'no_grasp' in codes[1]
    assert {'idle', 'nan'} <= codes[2]
    assert r['summary']['error'] == 1
    assert any('reject' in x for x in r['recommendations'])


def test_rollout_safety_filter_and_limit_validation():
    from physios_trainer.rollout import token_for, validate_limits
    from physios_trainer.rollout_worker import Safety
    prop = {'joints': [{'name': 'a', 'min': -10, 'max': 10, 'max_step': 1.0, 'max_lead': 4.0},
                       {'name': 'gripper', 'min': 0, 'max': 50, 'max_step': 5.0,
                        'max_lead': 20.0}]}
    s = Safety(prop, speed_factor=0.5, fps=30)
    out, notes = s.filter([9.0, 10.0], None, [0.0, 10.0])
    assert out[0] == 0.5 and out[1] == 10.0 and 'speed:a' in notes   # 1.0 * 0.5 per step
    out, notes = s.filter([11.0, 10.0], [9.8, 10.0], [9.8, 10.0])
    assert out[0] == 10.0 and 'range:a' in notes                         # clamped to envelope
    with pytest.raises(StopIteration):
        s.filter([30.0, 10.0], None, [0.0, 10.0])                          # far outside -> stop
    with pytest.raises(StopIteration):
        s.filter([float('nan'), 10.0], None, [0.0, 10.0])
    assert s.check_state([13.5, 10]) == ['a'] and s.check_state([12.0, 10]) == []
    ok = {'joints': [dict(j) for j in prop['joints']]}
    assert validate_limits(ok, prop) == []
    wide = {'joints': [dict(prop['joints'][0], max=13), prop['joints'][1]]}
    assert 'beyond' in validate_limits(wide, prop)[0]
    fast = {'joints': [dict(prop['joints'][0], max_step=2.0), prop['joints'][1]]}
    assert 'per step' in validate_limits(fast, prop)[0]
    assert validate_limits({'joints': prop['joints'][:1]}, prop)
    cfg = {'checkpoint': '/c', 'limits': ok, 'speed_factor': 0.3}
    assert token_for(cfg) != token_for(dict(cfg, speed_factor=0.31))
