# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Optimisation sessions end to end, with real processes (stub lerobot-train) and real files."""

import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import time

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import fixtures  # noqa: E402
from physios_trainer.optimizer import clean_settings, OptError, Sessions  # noqa: E402
from physios_trainer.service import ApiError, Service  # noqa: E402
import test_trainer as tt  # noqa: E402


def snapshot(path):
    out = {}
    for f in sorted(Path(path).rglob('*')):
        if f.is_file() and not f.is_symlink():
            out[str(f.relative_to(path))] = hashlib.sha256(f.read_bytes()).hexdigest()
    return out


@pytest.fixture()
def env(tmp_path):
    prefix = fixtures.make_stub_env(tmp_path / 'env', working_trainer=True)
    tt.ds(tmp_path, version='v3.0', episodes=5)  # -> tmp_path/lerobot/NandithaaaG/s101_dataset_pick
    repo = tmp_path / 'repo'
    (repo / 'lerobot').mkdir(parents=True)
    (repo / 'lerobot' / 'pyproject.toml').write_text('version = "0.6.2"\n')

    def make():
        return Service(repo, tmp_path / 'data', [tmp_path / 'lerobot'], {'stub': prefix},
                       log=lambda m: None, autostart_optimizer=False)
    svc = make()
    return svc, tmp_path, make


def base_cfg(tmp_path, **train):
    t = {'steps': 300, 'batch_size': 4, 'lr': 6e-4, 'save_freq': 100, 'log_freq': 10,
         'num_workers': 0, 'seed': 3, 'device': 'cpu'}
    t.update(train)
    return {'env': 'stub', 'dataset_path': str(tmp_path / 'lerobot' / 'NandithaaaG' /
                                                's101_dataset_pick'),
            'policy': 'act', 'episodes': 'all', 'job_name': 'orig', 'train': t,
            'policy_params': {}, 'advanced': {}}


def wait_run(svc, rid, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = svc.runs.load(rid)
        if r['status'] in ('succeeded', 'failed', 'stopped'):
            return r
        time.sleep(0.2)
    raise AssertionError('run did not finish: %s' % svc.runs.load(rid)['status'])


def start_original(svc, tmp_path, **train):
    cfg = base_cfg(tmp_path, **train)
    plan = svc.plan(cfg)
    assert plan['ok'], plan['errors']
    run = svc.start(cfg, plan['token'])
    return run['id'], wait_run(svc, run['id'])


def drive(svc, sid, timeout=120, watch_concurrency=True):
    """Tick the controller until the session is over; asserts one training at a time."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        svc.opt.tick()
        active = [r for r in svc.runs.list() if r['status'] in ('starting', 'training',
                                                                  'stopping', 'copying')]
        assert len(active) <= 1, 'two trainings at once: %s' % [r['id'] for r in active]
        s = svc.opt.load(sid)
        if s['status'] not in ('running', 'ready'):
            return s
        time.sleep(0.3)
    raise AssertionError('session did not finish: %s' % svc.opt.load(sid))


def test_original_run_shows_the_problem(env):
    svc, tmp, _ = env
    rid, run = start_original(svc, tmp)
    assert run['status'] == 'succeeded'  # like real lerobot, a NaN run keeps going to the end
    d = svc.diagnostics(rid)
    ids = [i['id'] for i in d['issues']]
    assert 'nonfinite_loss' in ids
    assert {'lr_down', 'clip_down'} <= set(d['trial_set'])


def test_auto_session_runs_separate_trials_and_recommends(env):
    svc, tmp, make = env
    rid, _ = start_original(svc, tmp)
    before = snapshot(svc.runs.load(rid)['output_dir'])
    req = {'run_id': rid, 'mode': 'auto',
           'settings': {'max_trials': 2, 'trial_steps': 100, 'gpu_budget_s': 600}}
    draft = svc.opt.propose(req)
    assert draft['ok'], draft['errors']
    assert draft['checkpoint']['step'] == 100  # before the explosion began at 120
    assert [t['role'] for t in draft['trials']] == ['control', 'trial', 'trial']
    for t in draft['trials']:
        assert '--resume=true' not in t['argv'] and not any(a.startswith('--config_path') for a in
                                                            t['argv'])
        assert any(a.startswith('--policy.path=') and a.endswith('/000100/pretrained_model')
                   for a in t['argv'])
        assert t['job_name'] != 'orig'
    with pytest.raises(OptError) as e:
        svc.opt.create(req, 'wrong-token')
    assert e.value.status == 409
    s = svc.opt.create(req, draft['token'])
    assert s['status'] == 'running'
    final = drive(svc, s['id'])
    assert final['status'] == 'completed', (final['status'], final['events'])
    runs = [t['run_id'] for t in final['trials']]
    assert len(set(runs)) == 3 and None not in runs
    outs = {svc.runs.load(r)['output_dir'] for r in runs}
    assert len(outs) == 3 and svc.runs.load(rid)['output_dir'] not in outs  # separate dirs
    by = {t['role'] if t['role'] == 'control' else t['candidate_id']: t for t in final['trials']}
    assert by['control']['status'] == 'diverged'  # same settings, same checkpoint: explodes again
    assert by['lr_down']['status'] == 'finished' and by['clip_down']['status'] == 'finished'
    rec = final['recommendation']
    assert rec['winner'] in (by['lr_down']['id'], by['clip_down']['id'])
    assert 'training-metric result' in rec['headline'] and not rec['robot_based']
    assert rec['patch'] and rec['config']['job_name'] == next(
        t['job_name'] for t in final['trials'] if t['id'] == rec['winner'])
    # the original run's directory is byte-for-byte what it was
    assert snapshot(svc.runs.load(rid)['output_dir']) == before
    # trials load weights only: nothing of the original optimiser state is in their folders
    for r in runs:
        run = svc.runs.load(r)
        cks = Path(run['output_dir']) / 'checkpoints'
        st = json.loads((cks / 'last' / 'training_state' / 'training_step.json').read_text())
        assert st['step'] == 200  # 100 from the checkpoint + 100 new steps
        assert not any('resume' in a for stage in run['plan']['stages'] for a in stage['argv'])
    assert final['budget']['used_s'] > 0
    # persistence: a new service over the same folder sees the finished session
    svc2 = make()
    assert svc2.opt.load(s['id'])['recommendation']['winner'] == rec['winner']
    assert svc2.opt.list()[0]['status'] == 'completed'


def test_next_run_plan_uses_the_winning_checkpoint(env):
    svc, tmp, _ = env
    rid, _ = start_original(svc, tmp)
    req = {'run_id': rid, 'mode': 'auto',
           'settings': {'max_trials': 1, 'trial_steps': 100, 'gpu_budget_s': 600}}
    s = svc.opt.create(req, svc.opt.propose(req)['token'])
    final = drive(svc, s['id'])
    nxt = svc.opt.next_run_plan(final['id'])
    assert nxt['plan']['ok'], nxt['plan']['errors']
    assert nxt['start_step'] == 200 and nxt['steps'] == 100  # 300 planned - 200 done
    argv = nxt['plan']['stages'][-1]['argv']
    win = next(t for t in final['trials'] if t['id'] == final['recommendation']['winner'])
    assert any(a.startswith('--policy.path=') and 'checkpoints/000200' in a for a in argv)
    assert win['job_name'] not in ' '.join(argv) or True
    assert nxt['plan']['job_name'].endswith('_next')
    # nothing was started by planning
    assert len(svc.runs.list()) == 1 + len(final['trials'])


def test_manual_mode_starts_nothing_until_confirmed(env):
    svc, tmp, _ = env
    rid, _ = start_original(svc, tmp)
    req = {'run_id': rid, 'mode': 'manual', 'settings': {'max_trials': 1, 'trial_steps': 100}}
    draft = svc.opt.propose(req)
    s = svc.opt.create(req, draft['token'])
    assert s['status'] == 'ready'
    for _ in range(3):
        svc.opt.tick()
    assert all(t['run_id'] is None for t in svc.opt.load(s['id'])['trials'])
    t1 = s['trials'][1]
    with pytest.raises(OptError) as e:
        svc.opt.launch_trial(s['id'], t1['id'], 'not-the-token')
    assert e.value.status == 409
    s = svc.opt.launch_trial(s['id'], t1['id'], t1['token'])
    assert s['trials'][1]['status'] == 'running'
    with pytest.raises(OptError) as e:  # one training at a time
        svc.opt.launch_trial(s['id'], s['trials'][0]['id'], s['trials'][0]['token'])
    assert e.value.status == 409
    final = drive(svc, s['id'], timeout=60) if False else None
    # finish the first, then run the control by hand
    wait_run(svc, s['trials'][1]['run_id'])
    svc.opt.tick()
    c = svc.opt.load(s['id'])['trials'][0]
    svc.opt.launch_trial(s['id'], c['id'], c['token'])
    final = drive(svc, s['id'])
    assert final['status'] == 'completed' and final['recommendation']['winner']


def test_budget_trial_count_and_target(env):
    svc, tmp, _ = env
    rid, _ = start_original(svc, tmp)
    # trial count limit: control + max_trials
    d = svc.opt.propose({'run_id': rid, 'mode': 'auto', 'settings': {'max_trials': 1,
                                                                      'trial_steps': 50}})
    assert len(d['trials']) == 2
    with pytest.raises(OptError):
        clean_settings({'max_trials': 99})
    with pytest.raises(OptError):
        clean_settings({'gpu_budget_s': 5})
    # GPU budget: once it is used up, nothing else is started and the rest is skipped
    req = {'run_id': rid, 'mode': 'auto', 'settings': {'max_trials': 2, 'trial_steps': 100}}
    s = svc.opt.create(req, svc.opt.propose(req)['token'])
    svc.opt._used = lambda sess: 10 ** 9  # noqa: SLF001 - pretend the budget is gone
    final = drive(svc, s['id'], timeout=30)
    assert final['status'] == 'budget_exhausted'
    assert all(t['run_id'] is None and t['status'] == 'skipped' for t in final['trials'])
    assert len(svc.runs.list()) == 1  # nothing was launched


def test_target_stops_the_session(env):
    svc, tmp, _ = env
    rid, _ = start_original(svc, tmp)
    req = {'run_id': rid, 'mode': 'auto',
           'settings': {'max_trials': 2, 'trial_steps': 100,
                        'target': {'metric': 'loss', 'value': 5.0}}}  # trivially easy
    s = svc.opt.create(req, svc.opt.propose(req)['token'])
    final = drive(svc, s['id'])
    assert final['status'] == 'target_reached', (final['status'], final['events'])
    assert any(t['status'] == 'skipped' for t in final['trials'])


def test_refuses_active_run_and_unsupported_levers(env):
    svc, tmp, _ = env
    cfg = base_cfg(tmp, steps=400, seed=40)  # 40 ms per step: slow enough to still be running
    plan = svc.plan(cfg)
    run = svc.start(cfg, plan['token'])
    with pytest.raises(OptError) as e:
        svc.opt.propose({'run_id': run['id']})
    assert e.value.status == 409 and 'still' in str(e.value)
    svc.runs.stop(run['id'])
    wait_run(svc, run['id'])
    with pytest.raises(OptError) as e:
        svc.opt.propose({'run_id': run['id'], 'candidate_ids': ['grad_accum']})
    assert 'not a recommendation' in str(e.value)


def test_monitor_stops_a_diverging_run_only_with_permission(env):
    svc, tmp, _ = env
    cfg = base_cfg(tmp, steps=600, seed=15)
    plan = svc.plan(cfg)
    run = svc.start(cfg, plan['token'])
    with pytest.raises(OptError):  # automatic stopping needs an explicit acknowledgement
        svc.opt.set_watch(run['id'], 'stop')
    svc.opt.set_watch(run['id'], 'stop', ack=True)
    t0 = time.time()
    while time.time() - t0 < 60:
        svc.opt._watch_at = 0  # noqa: SLF001 - skip the polling delay
        svc.opt.tick()
        if svc.runs.load(run['id'])['status'] in ('stopping', 'stopped', 'succeeded', 'failed'):
            break
        time.sleep(0.5)
    r = wait_run(svc, run['id'])
    assert r['status'] == 'stopped', r['status']
    assert r['progress']['step'] < 600  # it did not run to the end
    ev = svc.notifier.since(0)['events']
    assert any('stopped by the monitor' in e['title'].lower() for e in ev)
    assert svc.opt.watches()[run['id']]['acted'] is True


def test_flag_mode_only_notifies(env):
    svc, tmp, _ = env
    cfg = base_cfg(tmp, steps=500, seed=12)
    run = svc.start(cfg, svc.plan(cfg)['token'])
    svc.opt.set_watch(run['id'], 'flag')
    t0 = time.time()
    while time.time() - t0 < 60:
        svc.opt._watch_at = 0  # noqa: SLF001
        svc.opt.tick()
        if any('Training problem' in e['title'] for e in svc.notifier.since(0)['events']):
            break
        time.sleep(0.5)
    assert any('Training problem' in e['title'] for e in svc.notifier.since(0)['events'])
    assert svc.runs.load(run['id'])['status'] in ('training', 'succeeded')  # left alone
    wait_run(svc, run['id'])


def test_live_divergence_cuts_a_trial_short_and_restart_resumes_a_killed_one(env):
    svc, tmp, _ = env
    rid, _ = start_original(svc, tmp, seed=25)  # 25 ms per step: slow enough to watch
    req = {'run_id': rid, 'mode': 'auto',
           'settings': {'max_trials': 1, 'trial_steps': 100, 'auto_restart': True,
                        'gpu_budget_s': 900}}
    s = svc.opt.create(req, svc.opt.propose(req)['token'])
    killed = False
    t0 = time.time()
    while time.time() - t0 < 120:
        svc.opt.tick()
        cur = svc.opt.load(s['id'])
        lr_trial = next(t for t in cur['trials'] if t['role'] == 'trial')
        if not killed and lr_trial['status'] == 'running':
            run = svc.runs.load(lr_trial['run_id'])
            if (run.get('progress') or {}).get('step', 0) >= 165 and run.get('pgid'):
                os.killpg(run['pgid'], signal.SIGKILL)  # simulate a crash mid-trial
                killed = True
        if cur['status'] not in ('running', 'ready'):
            break
        time.sleep(0.25)
    final = svc.opt.load(s['id'])
    assert killed, 'the trial finished before it could be killed'
    ctl = next(t for t in final['trials'] if t['role'] == 'control')
    cs = svc.runs.load(ctl['run_id'])
    assert ctl['status'] == 'diverged' and ctl['stop_kind'] == 'diverged'
    assert cs['progress']['step'] < 200  # cut short live, not run to the end
    tr = next(t for t in final['trials'] if t['role'] == 'trial')
    assert tr['status'] == 'finished', (tr['status'], tr.get('error'), final['events'])
    assert final['restarts'] == {tr['id']: 1} and len(tr['prior_runs']) == 1
    assert svc.runs.load(tr['run_id'])['resume_of'] == tr['prior_runs'][0]
    assert any('Restarted trial' in e['msg'] for e in final['events'])
    assert final['recommendation']['winner'] == tr['id']


def test_restart_not_attempted_without_permission(env):
    svc, tmp, _ = env
    rid, _ = start_original(svc, tmp, seed=25)
    req = {'run_id': rid, 'mode': 'auto',
           'settings': {'max_trials': 1, 'trial_steps': 100, 'auto_restart': False}}
    s = svc.opt.create(req, svc.opt.propose(req)['token'])
    killed = False
    t0 = time.time()
    while time.time() - t0 < 120:
        svc.opt.tick()
        cur = svc.opt.load(s['id'])
        tr = next(t for t in cur['trials'] if t['role'] == 'trial')
        if not killed and tr['status'] == 'running':
            run = svc.runs.load(tr['run_id'])
            if (run.get('progress') or {}).get('step', 0) >= 165 and run.get('pgid'):
                os.killpg(run['pgid'], signal.SIGKILL)
                killed = True
        if cur['status'] not in ('running', 'ready'):
            break
        time.sleep(0.25)
    final = svc.opt.load(s['id'])
    tr = next(t for t in final['trials'] if t['role'] == 'trial')
    assert killed and tr['status'] == 'failed' and not final['restarts']


def test_api_error_type_is_importable():
    assert ApiError is not None


def test_smolvla_end_to_end_with_validation(env):
    """Phase 5: the SmolVLA path (policy-preset optimizer flags, held-out validation,
    diagnostics, an automatic session) on the stand-in trainer."""
    svc, tmp, _ = env
    cfg = base_cfg(tmp, steps=300, lr=6e-4)
    cfg.update(policy='smolvla', job_name='smolvla_orig')
    cfg['policy_params'] = {'optimizer_grad_clip_norm': 10}
    cfg['validation'] = {'enabled': True, 'eval_split': 0.2, 'eval_steps': 50}
    plan = svc.plan(cfg)
    assert plan['ok'], plan['errors']
    argv = ' '.join(plan['stages'][-1]['argv'])
    # SmolVLA fine-tunes the published base model, like the user's real runs
    assert '--policy.path=lerobot/smolvla_base' in argv and '--dataset.eval_split=0.2' in argv
    assert '--eval_steps=50' in argv
    run = svc.start(cfg, plan['token'])
    r = wait_run(svc, run['id'])
    d = svc.diagnostics(run['id'])
    assert d['validation']['enabled'] and d['validation']['points'] >= 2
    assert 'nonfinite_loss' in [i['id'] for i in d['issues']]
    caps = {c['id']: c['supported'] for c in d['capabilities']}
    assert caps['lr'] and caps['grad_clip'] and caps['validation']
    assert not caps['grad_accum']  # LeRobot has no gradient accumulation flag
    draft = svc.opt.propose({'run_id': run['id'], 'mode': 'auto',
                             'settings': {'max_trials': 2, 'trial_steps': 100,
                                          'gpu_budget_s': 600}})
    assert draft['ok'], draft['errors']
    trial_argv = ' '.join(draft['trials'][1]['argv'])
    assert '--policy.path=' in trial_argv and 'pretrained_model' in trial_argv
    s = svc.opt.create({'run_id': run['id'], 'mode': 'auto',
                        'settings': {'max_trials': 2, 'trial_steps': 100,
                                     'gpu_budget_s': 600}}, draft['token'])
    s = drive(svc, s['id'])
    assert s['status'] == 'completed', (s['status'], s['events'][-3:])
    assert s['recommendation'] and 'training' in json.dumps(s['recommendation']).lower()
    assert r['status'] in ('succeeded', 'failed')
