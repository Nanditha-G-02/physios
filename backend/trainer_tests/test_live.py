# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Live test against a real LeRobot install (skipped unless PAM_TEST_LEROBOT_PREFIX is set).

    PAM_TEST_LEROBOT_PREFIX=/path/to/env python -m pytest tests/test_live.py

Builds a small synthetic v2.1 dataset, then runs the real pipeline through the
service: copy -> LeRobot converter -> lerobot-train (ACT, CPU, a few steps).
"""

import os
from pathlib import Path
import sys
import time

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parents[1] / 'robot' / 'src' / 'physical_ai_server' / 'test' / 'planning'))

PREFIX = os.environ.get('PAM_TEST_LEROBOT_PREFIX')
pytestmark = pytest.mark.skipif(not PREFIX, reason='set PAM_TEST_LEROBOT_PREFIX to run')


def test_real_pipeline(tmp_path):
    import synthetic
    from physios_trainer.service import Service
    root = tmp_path / 'lerobot'
    synthetic.make_dataset(root, 'tester/s101_dataset_live', episodes=3, fps=30, seconds=1.5,
                           cameras=('global', 'gripper'), width=64, height=64)
    repo = tmp_path / 'repo'
    (repo / 'lerobot').mkdir(parents=True)
    (repo / 'lerobot' / 'pyproject.toml').write_text('version = "0.2.0"\n')
    svc = Service(repo, tmp_path / 'data', [root], {'live': PREFIX}, log=lambda m: None)
    cfg = {'env': 'live', 'dataset_path': str(root / 'tester' / 's101_dataset_live'),
           'policy': 'act', 'episodes': 'all', 'job_name': 'live_act',
           'train': {'steps': 8, 'batch_size': 2, 'lr': 1e-5, 'save_freq': 4, 'log_freq': 2,
                     'num_workers': 0, 'seed': 1, 'device': 'cpu'},
           'policy_params': {'chunk_size': 5, 'n_action_steps': 5},
           'advanced': {'policy.pretrained_backbone_weights': 'null'}}
    plan = svc.plan(cfg)
    assert plan['ok'], plan['errors']
    run = svc.start(cfg, plan['token'])
    t0 = time.time()
    while time.time() - t0 < 600:
        r = svc.runs.load(run['id'])
        if r['status'] in ('succeeded', 'failed', 'stopped'):
            break
        time.sleep(2)
    tail = svc.runs.log_tail(run['id'])['text'][-3000:]
    assert r['status'] == 'succeeded', (r.get('error'), tail)
    ck = svc.checkpoints(run['id'])
    assert [c['step'] for c in ck['checkpoints']] == [4, 8]
    assert not ck['compat']['inference_ok']
    m = svc.runs.metrics(run['id'])
    assert m['train'] and all('loss' in x for x in m['train'])
    info = (root / 'tester' / 's101_dataset_live' / 'meta' / 'info.json').read_text()
    assert '"v2.1"' in info  # the recorded dataset was not converted in place
