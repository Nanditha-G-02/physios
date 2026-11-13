# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Training diagnostics, capability-aware recommendations and the validation option."""

import json
import math
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from physios_trainer import diagnostics as dg, planner, tuning  # noqa: E402
from physios_trainer.introspect import parse_help  # noqa: E402
from physios_trainer.runner import LogParser  # noqa: E402
import test_trainer as tt  # noqa: E402


def rows(n=100, loss=lambda i: 1.0 / (1 + i / 10.0), grdn=lambda i: 2.0, dt=0.2, lr=1e-4,
         data_s=0.01, updt_s=0.15, every=10):
    """Synthetic log records shaped like the real parser output."""
    out, t = [], 1000.0
    for i in range(n):
        dts = dt(i) if callable(dt) else dt
        t += dts * every
        out.append({'t': t, 'step': (i + 1) * every, 'step_exact': True, 'loss': loss(i),
                    'grdn': grdn(i), 'lr': lr, 'data_s': data_s, 'updt_s': updt_s,
                    'epch': (i + 1) * every / 500.0})
    return out


def ids(issues):
    return {i['id'] for i in issues}


def test_healthy_run_has_no_issues_and_a_summary():
    r = rows()
    assert dg.detect(r, [], [], {}) == []
    s = dg.summarize(r, [], [])
    assert abs(s['step_time_s'] - 0.2) < 1e-6
    assert abs(s['epoch_duration_s'] - 100.0) < 1.0  # 500 steps x 0.2 s
    assert s['stability']['label'] == 'stable'


def test_nan_loss_is_parsed_and_detected_critical():
    p = LogParser(log_freq=10)
    recs = p.feed('step:10 smpl:40 ep:0 epch:0.1 loss:0.9 grdn:2.0 lr:1.0e-04 updt_s:0.1 data_s:0.0\n'
                  'step:20 smpl:80 ep:0 epch:0.2 loss:nan grdn:inf lr:1.0e-04 updt_s:0.1 '
                  'data_s:0.0\n')
    assert recs[1]['nonfinite'] == ['loss', 'grdn'] and 'loss' not in recs[1]
    json.dumps(recs)  # must stay valid JSON for the browser
    issues = dg.detect(recs, [], [], {})
    assert issues[0]['id'] == 'nonfinite_loss' and issues[0]['severity'] == 'critical'
    assert issues[0]['evidence']['first_step'] == 20


def test_nan_eval_loss_is_flagged():
    p = LogParser()
    recs = p.feed('INFO step 500: eval_loss=nan\n')
    assert recs[0]['nonfinite'] == ['eval_loss']
    assert dg.detect([], recs, [], {})[0]['id'] == 'nonfinite_loss'


def test_loss_explosion():
    r = rows(60, loss=lambda i: 0.5 if i < 40 else 0.5 * 8 ** ((i - 38) / 5))
    got = dg.detect(r, [], [], {})
    assert 'loss_explosion' in ids(got)
    e = next(i for i in got if i['id'] == 'loss_explosion')
    assert e['severity'] == 'critical' and e['evidence']['ratio'] > 5


def test_stagnation_but_not_when_still_improving():
    flat = rows(100, loss=lambda i: 1.0 / (1 + min(i, 40) / 10.0))
    assert 'stagnation' in ids(dg.detect(flat, [], [], {}))
    improving = rows(100, loss=lambda i: 1.0 / (1 + i / 10.0))
    assert 'stagnation' not in ids(dg.detect(improving, [], [], {}))


def test_stagnation_is_not_reported_when_lr_has_decayed_to_zero():
    r = rows(100, loss=lambda i: 0.2, lr=0.0)
    assert 'stagnation' not in ids(dg.detect(r, [], [], {}))


def test_overfitting_needs_rising_validation_with_falling_training():
    r = rows(100)
    ev = [{'step': s, 'eval_loss': v, 'kind': 'eval'}
          for s, v in ((200, 0.5), (400, 0.42), (600, 0.47), (800, 0.55), (1000, 0.7))]
    got = dg.detect(r, ev, [], {})
    o = next(i for i in got if i['id'] == 'overfitting')
    assert o['evidence']['best_step'] == 400
    ok_ev = [{'step': s, 'eval_loss': v, 'kind': 'eval'}
             for s, v in ((200, 0.5), (400, 0.42), (600, 0.4), (800, 0.38))]
    assert 'overfitting' not in ids(dg.detect(r, ok_ev, [], {}))
    # two points are not enough to claim a trend
    assert 'overfitting' not in ids(dg.detect(r, ev[:2], [], {}))


def test_excessive_clipping_uses_the_configured_clip_norm():
    r = rows(60, grdn=lambda i: 25.0)
    got = dg.detect(r, [], [], {}, clip_norm=10)
    c = next(i for i in got if i['id'] == 'excess_clipping')
    assert c['severity'] == 'critical' and c['evidence']['fraction_clipped'] == 1.0
    assert 'excess_clipping' not in ids(dg.detect(r, [], [], {}, clip_norm=100))


def test_gpu_memory_and_oom():
    res = [{'t': 1.0, 'gpu': {'memory_used_mb': 5900, 'memory_total_mb': 6144}}]
    assert 'gpu_memory' in ids(dg.detect(rows(), [], res, {}))
    low = [{'t': 1.0, 'gpu': {'memory_used_mb': 2500, 'memory_total_mb': 6144}}]
    assert 'gpu_memory' not in ids(dg.detect(rows(), [], low, {}))
    got = dg.detect(rows(), [], low, {}, error_tail=['torch.OutOfMemoryError: CUDA out of memory'])
    assert 'gpu_oom' in ids(got)


def test_slow_and_data_bound():
    r = rows(60, dt=lambda i: 0.2 if i < 30 else 0.6)
    got = dg.detect(r, [], [], {})
    assert 'slow_training' in ids(got)
    d = rows(60, data_s=0.3, updt_s=0.1)
    got = dg.detect(d, [], [], {'train': {'num_workers': 0}})
    x = next(i for i in got if i['id'] == 'data_bound')
    assert x['levers'] == ['workers_up'] and x['evidence']['num_workers'] == 0


def test_issues_sorted_by_severity():
    r = rows(60, grdn=lambda i: 25.0, dt=lambda i: 0.2 if i < 30 else 0.6)
    sev = [i['severity'] for i in dg.detect(r, [], [], {}, clip_norm=10)]
    assert sev == sorted(sev, key=lambda s: dg.SEVERITY_ORDER[s])


def test_gpu_series_aligned_to_steps():
    r = rows(10)
    res = [{'t': r[3]['t'] + 0.1, 'gpu': {'memory_used_mb': 1234, 'memory_total_mb': 6144}}]
    assert dg.gpu_series(res, r)[0]['step'] == r[3]['step']


# ---- capability-aware recommendations -------------------------------------------------
def test_capabilities_follow_the_installed_flags():
    caps = {c['id']: c for c in tuning.capabilities(tt.flags())}
    assert not caps['grad_accum']['supported'] and 'no gradient-accumulation' in caps['grad_accum']['reason']
    assert not caps['weight_decay']['supported']  # not in the test --help
    assert caps['lr']['supported'] and caps['batch_size']['supported']
    full = tt.flags() | {'policy.optimizer_weight_decay', 'policy.use_amp',
                         'dataset.eval_split', 'eval_steps', 'optimizer.type'}
    caps = {c['id']: c for c in tuning.capabilities(full)}
    assert caps['weight_decay']['supported'] and caps['mixed_precision']['supported']
    assert caps['validation']['supported'] and caps['optimizer_type']['manual_only']
    accum = {c['id']: c for c in tuning.capabilities(full | {'gradient_accumulation_steps'})}
    assert accum['grad_accum']['supported']


def explosion_issues():
    r = rows(60, loss=lambda i: 0.5 if i < 40 else 0.5 * 8 ** ((i - 38) / 5))
    return dg.detect(r, [], [], {})


def test_recommendations_only_use_supported_flags():
    cfg = {'train': {'lr': 1e-4, 'batch_size': 8, 'steps': 20000}}
    flags = tt.flags()  # no clip / warmup flags
    rec = tuning.recommend(explosion_issues(), cfg, flags)
    by = {c['id']: c for c in rec['candidates']}
    assert by['lr_down']['supported'] and by['lr_down']['patch'] == {'train': {'lr': 3e-05}}
    assert not by['clip_down']['supported'] and by['clip_down']['patch'] == {}
    assert by['clip_down']['unsupported_reason']
    assert rec['trial_set'] == ['lr_down']  # unsupported levers are never trialled
    flags2 = flags | {'policy.optimizer_grad_clip_norm', 'policy.scheduler_warmup_steps'}
    rec2 = tuning.recommend(explosion_issues(), cfg, flags2)
    assert set(rec2['trial_set']) == {'lr_down', 'clip_down', 'warmup_up'}


def test_patch_merges_into_a_copy_and_plans_cleanly(tmp_path):
    base = tt.cfg()
    flags = tt.flags() | {'policy.optimizer_weight_decay'}
    patched = tuning.apply_patch(base, {'train': {'lr': 3e-6},
                                        'policy_params': {'optimizer_weight_decay': 0.0001}})
    assert base['train']['lr'] == 1e-5 and patched['train']['lr'] == 3e-6  # original untouched
    d = tt.ds(tmp_path)
    plan = planner.build(patched, dataset=d, probe=tt.PROBE, flags=flags,
                         data_dir=tmp_path / 'tr', default_output_root=tmp_path / 'out')
    assert plan['ok'], plan['errors']
    assert '--policy.optimizer_weight_decay=0.0001' in plan['stages'][-1]['argv']


def test_overfitting_recommends_weight_decay_and_checkpoint_selection():
    r = rows(100)
    ev = [{'step': s, 'eval_loss': v, 'kind': 'eval'}
          for s, v in ((200, 0.5), (400, 0.42), (600, 0.47), (800, 0.55), (1000, 0.7))]
    issues = dg.detect(r, ev, [], {})
    flags = tt.flags() | {'policy.optimizer_weight_decay', 'dataset.image_transforms.enable'}
    rec = tuning.recommend(issues, {'train': {'lr': 1e-4, 'steps': 5000}}, flags,
                           best_eval_step=400)
    by = {c['id']: c for c in rec['candidates']}
    assert by['wd_up']['patch']['policy_params']['optimizer_weight_decay'] == 1e-4
    assert by['early_stop']['kind'] == 'selection' and '400' in by['early_stop']['why']
    assert 'early_stop' not in rec['trial_set']  # not a config, nothing to run


def test_no_issues_means_no_changes():
    rec = tuning.recommend([], {'train': {'lr': 1e-4}}, tt.flags())
    assert rec['candidates'] == [] and rec['trial_set'] == []
    assert 'No problems detected' in rec['notes'][0]


# ---- optional held-out validation -----------------------------------------------------
def test_validation_flags_added_only_when_supported(tmp_path):
    d = tt.ds(tmp_path, version='v3.0', episodes=39)
    cfg = tt.cfg(validation={'enabled': True, 'eval_split': 0.1, 'eval_steps': 200})
    good = tt.flags() | {'dataset.eval_split', 'eval_steps'}
    plan = planner.build(cfg, dataset=d, probe=tt.PROBE, flags=good, data_dir=tmp_path / 'tr',
                         default_output_root=tmp_path / 'out')
    assert plan['ok'], plan['errors']
    argv = plan['stages'][-1]['argv']
    assert '--dataset.eval_split=0.1' in argv and '--eval_steps=200' in argv
    assert any('about 4 of 39 episodes' in w for w in plan['warnings'])
    bad = planner.build(cfg, dataset=d, probe=tt.PROBE, flags=tt.flags(),
                        data_dir=tmp_path / 'tr2', default_output_root=tmp_path / 'out')
    assert not bad['ok'] and any('cannot hold out' in e for e in bad['errors'])
    off = planner.build(tt.cfg(), dataset=d, probe=tt.PROBE, flags=good,
                        data_dir=tmp_path / 'tr3', default_output_root=tmp_path / 'out')
    assert not any('eval_split' in a for a in off['stages'][-1]['argv'])


def test_validation_split_bounds(tmp_path):
    d = tt.ds(tmp_path, version='v3.0')
    good = tt.flags() | {'dataset.eval_split', 'eval_steps'}
    for frac in (0, 0.6, 'x'):
        plan = planner.build(tt.cfg(validation={'enabled': True, 'eval_split': frac}),
                             dataset=d, probe=tt.PROBE, flags=good, data_dir=tmp_path / 'tr',
                             default_output_root=tmp_path / 'out')
        assert not plan['ok'], frac


def test_nan_never_reaches_the_summary_json():
    p = LogParser(log_freq=10)
    recs = p.feed('step:10 smpl:40 ep:0 epch:0.1 loss:nan grdn:2.0 lr:1.0e-04 updt_s:0.1 '
                  'data_s:0.0\n')
    s = dg.summarize(recs, [], [])
    assert json.dumps(s) and not any(isinstance(v, float) and math.isnan(v) for v in s.values())


# ---- service level ---------------------------------------------------------------------
class _Runs:
    def __init__(self, run, rows, evals, res):
        self.run, self.rows, self.evals, self.res = run, rows, evals, res

    def load(self, rid):
        if rid != self.run['id']:
            raise KeyError(rid)
        return self.run

    def metrics(self, rid, max_points=1500):
        return {'train': self.rows, 'eval': self.evals}

    def resource_history(self, rid, max_points=600):
        return self.res


class _Intro:
    def policy(self, env, policy):
        return tt.flags() | {'policy.optimizer_grad_clip_norm', 'dataset.eval_split', 'eval_steps'}


class _Eval:
    def summary(self):
        return [{'run_id': 'r1', 'step': 1000, 'n': 5, 'rate': 0.6}]


def test_service_diagnostics_is_json_safe_and_read_only():
    from physios_trainer.service import ApiError, Service
    r = rows(60, grdn=lambda i: 25.0)
    run = {'id': 'r1', 'job_name': 'j', 'status': 'training', 'env': {'name': 'lerobot'},
           'plan': {'policy': 'act', 'stages': [{'argv': ['x', '--dataset.eval_split=0.1']}]},
           'config': {'train': {'lr': 1e-4, 'batch_size': 8, 'steps': 5000}},
           'parser': {'error_tail': []}, 'progress': {'step': 600}}
    before = json.dumps(run, sort_keys=True)
    fake = type('S', (), {})()
    fake.runs, fake.intro, fake.evaluations = _Runs(run, r, [], []), _Intro(), _Eval()
    fake.run_config_clip = lambda cfg: Service.run_config_clip(fake, cfg)
    out = Service.diagnostics(fake, 'r1')
    json.dumps(out)
    assert json.dumps(run, sort_keys=True) == before  # the run record is untouched
    assert out['issues'][0]['id'] == 'excess_clipping'
    assert out['validation'] == {'enabled': True, 'supported': True, 'points': 0}
    assert out['robot_evaluations'][0]['rate'] == 0.6
    assert any('do not measure grasping' in c for c in out['caveats'])
    assert out['clip_norm_assumed'] is True and out['trial_set']
    assert len(out['series']['loss']) <= 600
    try:
        Service.diagnostics(fake, 'nope')
        raise AssertionError('expected ApiError')
    except ApiError as e:
        assert e.status == 404


def test_real_service_with_stub_environment(tmp_path):
    """The whole path: run records on disk -> real Service -> real flag introspection."""
    import fixtures
    from physios_trainer.service import Service
    prefix = fixtures.make_stub_env(tmp_path / 'env')
    fixtures.standard_fixture(tmp_path / 'data')
    repo = tmp_path / 'repo'
    (repo / 'lerobot').mkdir(parents=True)
    (repo / 'lerobot' / 'pyproject.toml').write_text('version = "0.6.2"\n')
    svc = Service(repo, tmp_path / 'data', [], {'stub': prefix}, log=lambda m: None)
    d = svc.diagnostics('fx-explode')
    assert [i['id'] for i in d['issues']][:2] == ['loss_explosion', 'excess_clipping']
    caps = {c['id']: c for c in d['capabilities']}
    assert caps['weight_decay']['supported'] and not caps['grad_accum']['supported']
    assert caps['validation']['supported']
    assert 'lr_down' in d['trial_set'] and 'clip_down' in d['trial_set']
    assert svc.diagnostics('fx-healthy')['issues'] == []
    o = svc.diagnostics('fx-overfit')
    assert o['issues'][0]['id'] == 'overfitting' and o['validation']['points'] == 5
    n = svc.diagnostics('fx-nan')
    assert n['issues'][0]['id'] == 'nonfinite_loss'
    json.dumps([d, o, n])
    cmp_ = svc.compare(['fx-healthy', 'fx-overfit'])
    assert cmp_['runs'][1]['eval_best'] == 0.42 and cmp_['runs'][0]['gpu_peak_mb'] >= 2400
    assert 'validation' in cmp_['best']['basis'] or 'training loss' in cmp_['best']['basis']


def test_stop_advice_only_for_live_runs():
    r = rows(60, loss=lambda i: 0.5 if i < 40 else 0.5 * 8 ** ((i - 38) / 5))
    live = dg.detect(r, [], [], {}, status='training')[0]['action']
    done = dg.detect(r, [], [], {}, status='failed')[0]['action']
    assert live.startswith('Stop the run.') and done.startswith('Restart')


def test_json_roundtrip_does_not_change_the_command(tmp_path):
    """The browser sends the config back as JSON (1.0 becomes 1); the token must not change."""
    d = tt.ds(tmp_path, version='v3.0')
    flags = tt.flags() | {'policy.optimizer_grad_clip_norm'}
    cfg = tt.cfg(policy_params={'optimizer_grad_clip_norm': 1.0})
    a = planner.build(cfg, dataset=d, probe=tt.PROBE, flags=flags, data_dir=tmp_path / 'tr',
                      default_output_root=tmp_path / 'out')
    b = planner.build(json.loads(json.dumps(cfg)), dataset=d, probe=tt.PROBE, flags=flags,
                      data_dir=tmp_path / 'tr', default_output_root=tmp_path / 'out')
    assert a['token'] == b['token'] and '--policy.optimizer_grad_clip_norm=1' in a['stages'][-1]['argv']
