# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Unit tests that need no LeRobot install (the live run is in test_live.py)."""

import json
import os
from pathlib import Path
import sys

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parents[1] / 'robot' / 'src' / 'physical_ai_server' / 'test' / 'planning'))

from physios_trainer import catalog, datasets, planner  # noqa: E402
from physios_trainer.introspect import parse_help  # noqa: E402
from physios_trainer.runner import LogParser, start_step_of  # noqa: E402

HELP = """usage: lerobot-train [-h] [--config_path str] [--dataset.repo_id str]
  [--dataset.root [str]] [--dataset.episodes [list[int]]] [--dataset.exclude_episodes [list[int]]]
  [--policy.type {act,diffusion,smolvla,tdmpc}] [--policy.device str] [--policy.push_to_hub bool]
  [--policy.optimizer_lr float] [--policy.chunk_size int] [--output_dir str] [--job_name str]
  [--resume bool] [--seed int] [--num_workers int] [--batch_size int] [--steps int]
  [--log_freq int] [--save_freq int] [--wandb.enable bool] [--rename_map dict]
  [--policy.path str] [--policy.empty_cameras int]
"""

PROBE = {'name': 'lerobot', 'prefix': '/opt/conda/envs/lerobot', 'ok': True,
         'packages': {'lerobot': '0.6.2', 'torch': '2.11.0', 'transformers': '4.5',
                      'num2words': '0.5', 'accelerate': '1.0', 'av': '15'},
         'cuda_available': True, 'gpu': {'name': 'RTX 3050', 'total_mb': 6144},
         'codebase_version': 'v3.0', 'has_converter': True, 'python': '3.12'}


def ds(tmp_path, version='v2.1', episodes=5, shapes=((720, 1280, 3), (480, 640, 3))):
    path = tmp_path / 'lerobot' / 'NandithaaaG' / 's101_dataset_pick'
    (path / 'meta').mkdir(parents=True)
    (path / 'data').mkdir()
    (path / 'videos').mkdir()
    feats = {'observation.state': {'dtype': 'float32', 'shape': [6]},
             'action': {'dtype': 'float32', 'shape': [6]},
             'observation.images.global': {'dtype': 'video', 'shape': list(shapes[0])},
             'observation.images.gripper': {'dtype': 'video', 'shape': list(shapes[1])}}
    (path / 'meta' / 'info.json').write_text(json.dumps({
        'codebase_version': version, 'robot_type': 's101_dataset', 'fps': 30,
        'total_episodes': episodes, 'total_frames': episodes * 600, 'features': feats}))
    (path / 'meta' / 'tasks.jsonl').write_text(json.dumps(
        {'task_index': 0, 'task': 'pick up the object'}) + '\n')
    (path / 'meta' / 'episode_reviews.json').write_text(json.dumps(
        {'episodes': {'1': {'status': 'rejected'}, '0': {'status': 'accepted'},
                      '2': {'status': 'accepted'}}}))
    return datasets.describe(tmp_path / 'lerobot', 'NandithaaaG', 's101_dataset_pick')


def flags():
    return set(parse_help(HELP)['flags'])


def cfg(**kw):
    c = {'policy': 'act', 'env': 'lerobot',
         'train': {'steps': 1000, 'batch_size': 8, 'lr': 1e-5, 'save_freq': 500, 'log_freq': 100,
                   'num_workers': 2, 'seed': 1, 'device': 'cuda'},
         'policy_params': {'chunk_size': 100}, 'episodes': 'exclude_rejected'}
    c.update(kw)
    return c


def test_parse_help():
    h = parse_help(HELP)
    assert h['policy_types'] == ['act', 'diffusion', 'smolvla', 'tdmpc']
    assert 'dataset.exclude_episodes' in h['flags'] and 'wandb.enable' in h['flags']


def test_dataset_description(tmp_path):
    d = ds(tmp_path)
    assert d['review_counts'] == {'accepted': 2, 'rejected': 1, 'needs_review': 0,
                                  'unreviewed': 2}
    assert d['rejected_indices'] == [1] and d['accepted_indices'] == [0, 2]
    assert d['complete']


def test_plan_converts_a_copy_and_excludes_rejected(tmp_path):
    d = ds(tmp_path)
    plan = planner.build(cfg(), dataset=d, probe=PROBE, flags=flags(), data_dir=tmp_path / 'tr',
                         default_output_root=tmp_path / 'out')
    assert plan['ok'], plan['errors']
    kinds = [s['kind'] for s in plan['stages']]
    assert kinds == ['copy', 'convert', 'train']
    copy = plan['stages'][0]['argv']
    assert copy[1] == d['path'] and copy[2] != d['path']  # never in place
    train = plan['stages'][-1]['argv']
    assert '--dataset.exclude_episodes=[1]' in train
    assert '--wandb.enable=false' in train and '--policy.push_to_hub=false' in train
    assert any(a.startswith('--dataset.root=%s' % (tmp_path / 'tr')) for a in train)
    assert '--policy.optimizer_lr=1e-05' in train
    assert all('@' not in a for a in train)


def test_plan_validation_errors(tmp_path):
    d = ds(tmp_path)
    (tmp_path / 'out' / 'job').mkdir(parents=True)
    bad = {'steps': 0, 'batch_size': 'x', 'lr': 2, 'save_freq': 1, 'log_freq': 1,
           'num_workers': 0, 'seed': 0, 'device': 'cuda'}
    plan = planner.build(cfg(job_name='job', train=bad,
                             advanced={'policy.nope': '1', 'steps': '5'}),
                         dataset=d, probe=PROBE, flags=flags(), data_dir=tmp_path / 'tr',
                         default_output_root=tmp_path / 'out')
    text = ' '.join(plan['errors'])
    assert not plan['ok']
    for expect in ('Steps', 'Batch size', 'Learning rate', 'already exists', 'policy.nope',
                   '--steps is already set'):
        assert expect in text, expect


def test_unsupported_flag_is_an_error_not_silently_dropped(tmp_path):
    d = ds(tmp_path, version='v3.0')
    plan = planner.build(cfg(policy_params={'kl_weight': 10}), dataset=d, probe=PROBE,
                         flags=flags(), data_dir=tmp_path / 'tr',
                         default_output_root=tmp_path / 'out')
    assert not plan['ok'] and '--policy.kl_weight' in ' '.join(plan['errors'])
    assert [s['kind'] for s in plan['stages']] == ['train']  # v3 needs no conversion


def test_token_changes_with_command(tmp_path):
    d = ds(tmp_path)
    a = planner.build(cfg(), dataset=d, probe=PROBE, flags=flags(), data_dir=tmp_path / 'tr',
                      default_output_root=tmp_path / 'out')
    b = planner.build(cfg(train=dict(cfg()['train'], steps=2000)), dataset=d, probe=PROBE,
                      flags=flags(), data_dir=tmp_path / 'tr',
                      default_output_root=tmp_path / 'out')
    assert a['token'] != b['token']


def test_smolvla_defaults_rename_cameras(tmp_path):
    d = ds(tmp_path)
    dfl = catalog.defaults_for('smolvla', d, PROBE)
    assert dfl['rename_map'] == {'observation.images.global': 'observation.images.camera1',
                                 'observation.images.gripper': 'observation.images.camera2'}
    assert dfl['empty_cameras'] == 1 and dfl['train']['batch_size'] == 4
    plan = planner.build(cfg(policy='smolvla', source=dfl['source'], policy_params={},
                             rename_map=dfl['rename_map'], empty_cameras=1,
                             train=dfl['train'] | {'lr': 1e-4}),
                         dataset=d, probe=PROBE, flags=flags(), data_dir=tmp_path / 'tr',
                         default_output_root=tmp_path / 'out')
    train = plan['stages'][-1]['argv']
    assert '--policy.path=lerobot/smolvla_base' in train and '--policy.empty_cameras=1' in train
    assert any(a.startswith('--rename_map={"observation.images.global"') for a in train)


def test_compatibility_rules(tmp_path):
    d = ds(tmp_path, episodes=40)
    types = ['act', 'diffusion', 'smolvla', 'tdmpc', 'pi0']
    assert catalog.check('act', d, PROBE, types)['status'] == 'ok'
    assert catalog.check('diffusion', d, PROBE, types)['status'] == 'blocked'  # shapes + diffusers
    assert catalog.check('tdmpc', d, PROBE, types)['status'] == 'blocked'
    assert catalog.check('pi0', d, PROBE, types)['status'] == 'blocked'  # 6 GB GPU
    assert catalog.check('vqbet', d, PROBE, types)['status'] == 'blocked'  # not offered
    same = ds(tmp_path / 'b', episodes=40, shapes=((480, 640, 3), (480, 640, 3)))
    probe = dict(PROBE, packages=dict(PROBE['packages'], diffusers='0.30'))
    assert catalog.check('diffusion', same, probe, types)['status'] in ('ok', 'warn')


def test_log_parser_fresh_and_resumed():
    p = LogParser(log_freq=5)
    p.feed('Training:  8%| | 1/12 [00:00<00:05]\rTraining: 50%| | 6/12 [00:02]INFO a.py:936 '
           'Checkpoint policy after step 6\n')
    assert p.step == 6 and p.total == 12 and p.checkpoints[-1]['step'] == 6
    recs = p.feed('INFO a.py:894 step:10 smpl:20 ep:0 epch:0.11 loss:23.406 grdn:627.4 '
                  'lr:1.0e-05 updt_s:0.308 l1_loss:0.972\nINFO End of training\n')
    assert recs[0]['loss'] == pytest.approx(23.406) and recs[0]['lr'] == pytest.approx(1e-5)
    assert p.finished
    r = LogParser(log_freq=200, state={'step_offset': 80})
    r.feed('Training: 1%| | 2/320 [00:01]\r')
    assert (r.step, r.total) == (82, 400)
    r.feed('Training: 10%| | 40/320 [00:01]INFO step:120 smpl:240 ep:1 epch:0.1 loss:1.5\n')
    assert (r.step, r.total) == (120, 400)


def test_start_step_of(tmp_path):
    ck = tmp_path / 'checkpoints' / 'last'
    (ck / 'pretrained_model').mkdir(parents=True)
    (ck / 'training_state').mkdir()
    (ck / 'training_state' / 'training_step.json').write_text('{"step": 80}')
    plan = {'stages': [{'argv': ['x', '--config_path=%s' % (ck / 'pretrained_model' /
                                                            'train_config.json')]}]}
    assert start_step_of(plan) == 80


@pytest.mark.skipif(os.name != 'posix', reason='posix only')
def test_foreign_training_detection_ignores_unrelated():
    from physios_trainer.runner import foreign_trainings
    assert all('lerobot' in f['cmd'] for f in foreign_trainings())
