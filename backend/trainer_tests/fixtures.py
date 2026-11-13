# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Test-only helpers: a stub LeRobot environment and synthetic run records.

The stub environment is two shell scripts that answer the probes the trainer makes
(``python -c PROBE`` and ``lerobot-train --help``). It is never used in production; real
runs use the operator's own conda environment.
"""

import json
import math
import os
from pathlib import Path
import stat
import sys
import time

HELP_BASE = """usage: lerobot-train [-h] [--config_path str] [--dataset.repo_id str]
  [--dataset.root [str]] [--dataset.episodes [list[int]]] [--dataset.exclude_episodes [list[int]]]
  [--dataset.eval_split float] [--eval_steps int] [--dataset.image_transforms.enable bool]
  [--policy.type {act,diffusion,smolvla}] [--policy.device str] [--policy.push_to_hub bool]
  [--policy.path str] [--output_dir str] [--job_name str] [--resume bool] [--seed int]
  [--num_workers int] [--batch_size int] [--steps int] [--log_freq int] [--save_freq int]
  [--wandb.enable bool] [--rename_map dict] [--optimizer.type str]
"""
HELP_POLICY = """  [--policy.optimizer_lr float] [--policy.optimizer_weight_decay float]
  [--policy.optimizer_grad_clip_norm float] [--policy.scheduler_warmup_steps int]
  [--policy.chunk_size int] [--policy.n_action_steps int] [--policy.empty_cameras int]
"""


def make_stub_env(prefix, lerobot='0.6.2', extra_policy_flags='', extra_base_flags='',
                  working_trainer=False):
    prefix = Path(prefix)
    (prefix / 'bin').mkdir(parents=True, exist_ok=True)
    probe = {'python': '3.12.0', 'executable': str(prefix / 'bin' / 'python'),
             'packages': {'lerobot': lerobot, 'torch': '2.11.0', 'torchvision': '0.2',
                          'datasets': '3', 'av': '15', 'torchcodec': None, 'transformers': '4.5',
                          'diffusers': None, 'num2words': '0.5', 'accelerate': '1.0',
                          'draccus': '0.10', 'huggingface_hub': '0.3', 'safetensors': '0.4'},
             'cuda_available': True, 'torch_cuda_build': '12.8',
             'gpu': {'name': 'Stub GPU', 'total_mb': 6144, 'capability': '8.6', 'count': 1},
             'codebase_version': 'v3.0', 'has_converter': True}
    py = prefix / 'bin' / 'python'
    py.write_text("#!/bin/sh\necho 'PAM_PROBE%s'\n" % json.dumps(probe))
    exe = prefix / 'bin' / 'lerobot-train'
    # policy specific help appends the policy flags
    exe.write_text(
        "#!/bin/sh\ncat <<'EOF'\n%s%s\nEOF\ncase \"$*\" in *policy.type=*) cat <<'EOF'\n%s%sEOF\n;;"
        " esac\n" % (HELP_BASE, extra_base_flags, HELP_POLICY, extra_policy_flags))
    if working_trainer:  # a runnable stand-in for lerobot-train (see stub_train.py)
        exe.write_text('#!/bin/sh\nexec %s %s "$@"\n' % (
            sys.executable, Path(__file__).with_name('stub_train.py')))
    for f in (py, exe):
        f.chmod(f.stat().st_mode | stat.S_IEXEC)
    return str(prefix)


def synth_rows(n, every=10, loss=None, grdn=None, lr=1e-4, step_s=0.2, t0=None, nan_at=None):
    loss = loss or (lambda i: 1.0 / (1 + i / 10.0))
    grdn = grdn or (lambda i: 2.0)
    t = t0 or time.time() - n * every * step_s
    rows = []
    for i in range(n):
        t += every * step_s
        r = {'t': t, 'step': (i + 1) * every, 'step_exact': True, 'lr': lr, 'data_s': 0.01,
             'updt_s': step_s - 0.05, 'epch': (i + 1) * every / 500.0, 'grdn': grdn(i)}
        if nan_at is not None and i >= nan_at:
            r['nonfinite'] = ['loss']
        else:
            r['loss'] = loss(i)
        rows.append(r)
    return rows


def write_run(data_dir, rid, name, rows, evals=(), config=None, status='succeeded', gpu_mb=None,
              policy='act', error_tail=(), steps_total=None, extra=None):
    d = Path(data_dir) / 'runs' / rid
    d.mkdir(parents=True, exist_ok=True)
    with open(d / 'metrics.jsonl', 'w') as f:
        for r in rows:
            f.write(json.dumps(r) + '\n')
        for e in evals:
            f.write(json.dumps(dict(e, kind='eval', t=rows[-1]['t'])) + '\n')
    if gpu_mb:
        with open(d / 'resources.jsonl', 'w') as f:
            for i, r in enumerate(rows[::5]):
                f.write(json.dumps({'t': r['t'], 'gpu': {
                    'memory_used_mb': gpu_mb + (i % 3) * 20, 'memory_total_mb': 6144,
                    'utilization_pct': 90}}) + '\n')
    out = Path(data_dir) / 'out' / name
    ck = out / 'checkpoints'
    last_step = rows[-1]['step']
    for s in sorted({max(1, last_step // 2), last_step}):
        m = ck / ('%06d' % s) / 'pretrained_model'
        m.mkdir(parents=True, exist_ok=True)
        (m / 'model.safetensors').write_bytes(b'x' * 2048)
        (m / 'config.json').write_text('{"type": "%s"}' % policy)
    if not (ck / 'last').exists():
        (ck / 'last').symlink_to(ck / ('%06d' % last_step))
    cfg = config or {'train': {'lr': 1e-4, 'batch_size': 8, 'steps': steps_total or 5000,
                               'log_freq': 10, 'save_freq': 500, 'num_workers': 2,
                               'device': 'cuda', 'seed': 1}, 'policy_params': {}, 'advanced': {}}
    t = rows[0]['t']
    from datetime import datetime, timezone
    iso = lambda x: datetime.fromtimestamp(x, timezone.utc).isoformat()  # noqa: E731
    run = {'id': rid, 'created_at': iso(t), 'started_at': iso(t),
           'finished_at': iso(rows[-1]['t']) if status != 'training' else None,
           'status': status, 'config': cfg, 'job_name': name, 'output_dir': str(out),
           'env': {'name': 'stub', 'prefix': '', 'lerobot': '0.6.2'},
           'plan': {'policy': policy, 'output_dir': str(out), 'job_name': name,
                    'dataset': {'id': 'o/ds'}, 'resources': {},
                    'stages': [{'kind': 'train', 'argv': ['lerobot-train', '--steps=5000']}]},
           'stage_index': 0, 'stage_results': [], 'pid': None, 'pgid': None, 'exit_code': 0,
           'log_freq': 10, 'events': [], 'exports': [],
           'progress': {'step': last_step, 'total': steps_total or 5000, 'last': rows[-1]},
           'parser': {'error_tail': list(error_tail), 'step': last_step}}
    run.update(extra or {})
    (d / 'run.json').write_text(json.dumps(run))
    (d / 'run.log').write_text('')
    return run


def standard_fixture(data_dir):
    """Four runs: healthy, exploding, overfitting (with validation) and NaN."""
    write_run(data_dir, 'fx-healthy', 'healthy_act', synth_rows(80), gpu_mb=2400)
    write_run(data_dir, 'fx-explode', 'exploding_act',
              synth_rows(60, loss=lambda i: 0.5 if i < 40 else 0.5 * 8 ** ((i - 38) / 5),
                         grdn=lambda i: 30.0), gpu_mb=2600, status='failed')
    ev = [{'step': s, 'eval_loss': v} for s, v in
          ((100, 0.5), (200, 0.42), (300, 0.47), (400, 0.55), (500, 0.7))]
    write_run(data_dir, 'fx-overfit', 'overfit_act', synth_rows(60), evals=ev, gpu_mb=3000)
    write_run(data_dir, 'fx-nan', 'nan_act', synth_rows(40, nan_at=30), gpu_mb=2500,
              status='failed')
    return ['fx-healthy', 'fx-explode', 'fx-overfit', 'fx-nan']


if __name__ == '__main__':
    import sys
    root = Path(sys.argv[1])
    make_stub_env(root / 'stub_env')
    standard_fixture(root / 'training')
    print(root / 'stub_env')
    _ = (math, os)
