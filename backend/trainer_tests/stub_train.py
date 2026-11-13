#!/usr/bin/env python3
# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0
"""Test-only stand-in for ``lerobot-train``.

It behaves like the real tool where the trainer service looks: ``--help`` lists flags, unknown
flags are refused, log lines have LeRobot's ``step:… smpl:… loss:… grdn:… lr:…`` format,
checkpoints are written as ``checkpoints/<step>/pretrained_model`` with a ``last`` link, and
``--resume`` continues from ``train_config.json``.

The loss is a simple model, NOT a real network: it improves faster with a higher learning rate,
and diverges (loss blows up, then NaN, like a real exploding run) when the learning rate is
>= 5e-4 and the clip norm is >= 5, from global step 120 on. Lowering either one fixes it. That
lets the optimisation workflow be tested end to end with real processes, logs and files.

``--seed`` is used as milliseconds of sleep per step so tests can make a run slow or fast.
Weights are loaded from ``--policy.path`` (the file ``stub_state.json``); optimiser state is
never loaded - a trial starts with a fresh one, exactly the property the session relies on.
"""

import json
import math
from pathlib import Path
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

def flags():
    import re
    return set(re.findall(r'--([A-Za-z0-9_.]+)', HELP_BASE + HELP_POLICY))


def main():
    args = sys.argv[1:]
    if '--help' in args:
        sys.stdout.write(HELP_BASE)
        if any(a.startswith('--policy.type=') for a in args):
            sys.stdout.write(HELP_POLICY)
        return 0
    kv = {}
    for a in args:
        if not a.startswith('--') or '=' not in a:
            sys.stderr.write('error: unrecognized argument %s\n' % a)
            return 2
        k, v = a[2:].split('=', 1)
        if k not in flags():
            sys.stderr.write('error: unrecognized arguments: %s\n' % a)
            return 2
        kv[k] = v
    start, p = 0, 0.0
    if kv.get('resume') == 'true':
        cfg = json.loads(Path(kv['config_path']).read_text())
        out = Path(cfg['output_dir'])
        steps, save, logf = cfg['steps'], cfg['save_freq'], cfg['log_freq']
        lr, clip, sleep = cfg['lr'], cfg['clip'], cfg['sleep']
        st = json.loads((out / 'checkpoints' / 'last' / 'training_state' /
                         'training_step.json').read_text())
        start = st['step']
        p = json.loads((out / 'checkpoints' / 'last' / 'pretrained_model' /
                        'stub_state.json').read_text())['p']
        steps = int(kv.get('steps', steps))
        policy = cfg['policy']['type']
    else:
        out = Path(kv['output_dir'])
        steps, save, logf = int(kv['steps']), int(kv['save_freq']), int(kv['log_freq'])
        lr = float(kv.get('policy.optimizer_lr', 1e-4))
        clip = float(kv.get('policy.optimizer_grad_clip_norm', 10))
        sleep = int(kv.get('seed', 1)) / 1000.0
        policy = kv.get('policy.type', 'act')
        src = kv.get('policy.path')
        if src and Path(src).is_dir():
            sj = Path(src) / 'stub_state.json'
            if sj.exists():
                s = json.loads(sj.read_text())
                start, p = s['step'], s['p']
        if out.exists() and any(out.iterdir()):
            sys.stderr.write('error: output_dir %s already exists\n' % out)
            return 2
    eval_on = 'dataset.eval_split' in kv
    eval_every = int(kv.get('eval_steps', 0))
    bs = int(kv.get('batch_size', 8))
    out.mkdir(parents=True, exist_ok=True)
    train_cfg = {'output_dir': str(out), 'steps': steps, 'save_freq': save, 'log_freq': logf,
                 'lr': lr, 'clip': clip, 'sleep': sleep, 'policy': {'type': policy},
                 'optimizer': {'lr': lr}, 'batch_size': bs,
                 'dataset': {'repo_id': kv.get('dataset.repo_id'), 'root': kv.get('dataset.root')}}
    blown = False
    gstep = start
    for local in range(1, steps + 1):
        gstep = start + local
        time.sleep(sleep)
        explosive = lr >= 5e-4 and clip >= 5
        if explosive and gstep >= 120:
            blown = True
        p += lr
        loss = 0.15 + 1.0 / (1 + 3000.0 * p)
        grdn = 1.0 + 3000 * lr * loss
        if blown:
            k = gstep - 119
            loss = loss * (2.0 ** k)
            grdn = grdn * (2.0 ** k)
            if k >= 40:
                loss = float('nan')
        if gstep % logf == 0:
            sys.stdout.write(
                'INFO 2026-01-01 00:00:00 ts.py:1 step:%d smpl:%d ep:0 epch:%.2f loss:%s grdn:%s '
                'lr:%.1e updt_s:0.010 data_s:0.001\n' % (
                    gstep, gstep * bs, gstep / 500.0,
                    'nan' if math.isnan(loss) else '%.4f' % loss,
                    'inf' if grdn > 1e12 else '%.3f' % grdn, lr))
            sys.stdout.flush()
        if eval_on and eval_every and gstep % eval_every == 0:
            sys.stdout.write('INFO step %d: eval_loss=%s\n' % (
                gstep, 'nan' if math.isnan(loss) else '%.4f' % (loss * 1.05)))
            sys.stdout.flush()
        if gstep % save == 0 or local == steps:
            d = out / 'checkpoints' / ('%06d' % gstep)
            pm = d / 'pretrained_model'
            pm.mkdir(parents=True, exist_ok=True)
            (pm / 'model.safetensors').write_bytes(b'w' * 4096)
            (pm / 'config.json').write_text(json.dumps({'type': policy}))
            (pm / 'train_config.json').write_text(json.dumps(train_cfg))
            (pm / 'stub_state.json').write_text(json.dumps({'p': p, 'step': gstep}))
            (d / 'training_state').mkdir(exist_ok=True)
            (d / 'training_state' / 'training_step.json').write_text(json.dumps({'step': gstep}))
            (d / 'training_state' / 'optimizer_state.json').write_text('{"fresh": false}')
            last = out / 'checkpoints' / 'last'
            if last.is_symlink() or last.exists():
                last.unlink()
            last.symlink_to(d)
            sys.stdout.write('INFO Checkpoint policy after step %d\n' % gstep)
            sys.stdout.flush()
    sys.stdout.write('INFO End of training\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
