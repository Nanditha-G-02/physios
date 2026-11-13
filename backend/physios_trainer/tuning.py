# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Capability-aware optimisation recommendations.

Nothing is recommended that the installed ``lerobot-train`` cannot take: each lever is
tied to the exact flags it needs, and those flags are looked up in the ``--help`` output of
the environment the run uses (``flags``). A lever whose flags are missing is still listed,
marked unsupported with the reason, so the operator sees what exists and what does not.

A candidate is a *config patch* in the same shape as a training config
(``train`` / ``policy_params`` / ``advanced``), so it can be merged into the run's
original config and re-planned through the normal validated planner. The optimiser state
of a running job is never touched - candidates are only ever applied to a NEW run.
"""

import copy
import os

CAPABILITIES = [
    ('lr', 'Learning rate', ['policy.optimizer_lr'],
     'This policy has no --policy.optimizer_lr; its learning rate comes from the preset.'),
    ('weight_decay', 'Weight decay (AdamW)', ['policy.optimizer_weight_decay'],
     'This policy has no --policy.optimizer_weight_decay.'),
    ('grad_clip', 'Gradient clipping', ['policy.optimizer_grad_clip_norm'],
     'This policy has no --policy.optimizer_grad_clip_norm.'),
    ('warmup', 'LR warm-up steps', ['policy.scheduler_warmup_steps'],
     'This policy has no scheduler warm-up option (--policy.scheduler_warmup_steps).'),
    ('lr_decay', 'LR decay schedule', ['policy.scheduler_decay_steps', 'policy.scheduler_decay_lr'],
     'This policy has no decay-schedule options.'),
    ('batch_size', 'Batch size', ['batch_size'], 'lerobot-train has no --batch_size.'),
    ('workers', 'Data-loader workers', ['num_workers'], 'lerobot-train has no --num_workers.'),
    ('grad_accum', 'Gradient accumulation', [],
     'This lerobot-train has no gradient-accumulation option. Lowering the batch size is the '
     'only way to cut memory, and it also lowers the effective batch.'),
    ('mixed_precision', 'Mixed precision', [],
     'This policy exposes neither --policy.use_amp nor --policy.dtype.'),
    ('validation', 'Held-out validation loss', ['dataset.eval_split', 'eval_steps'],
     'This lerobot-train cannot hold out episodes (--dataset.eval_split / --eval_steps).'),
    ('augment', 'Image augmentation', ['dataset.image_transforms.enable'],
     'This lerobot-train has no --dataset.image_transforms.enable.'),
    ('optimizer_type', 'Optimiser type (adam / adamw / sgd / …)', ['optimizer.type'],
     'This lerobot-train has no --optimizer.type.'),
    ('scheduler_type', 'Scheduler type', ['scheduler.type'],
     'This lerobot-train has no --scheduler.type.'),
]

# Levers that are present but deliberately never recommended automatically.
MANUAL_ONLY = {
    'optimizer_type': 'Changing the optimiser type needs --use_policy_training_preset=false and a '
                      'full optimiser and scheduler definition, which discards the policy\'s '
                      'tuned defaults. It is available as an advanced flag but never suggested '
                      'automatically.',
    'scheduler_type': 'Same as optimiser type: requires turning the policy preset off.',
}


def _has(flags, name):
    return name in flags


def capabilities(flags, extra_notes=None):
    """List every lever with whether this lerobot-train accepts it."""
    flags = set(flags or [])
    out = []
    for cid, label, needs, why_not in CAPABILITIES:
        if cid == 'grad_accum':
            ok = any('accum' in f for f in flags)
            found = sorted(f for f in flags if 'accum' in f)
        elif cid == 'mixed_precision':
            found = [f for f in ('policy.use_amp', 'policy.dtype') if f in flags]
            ok = bool(found)
        else:
            ok = all(_has(flags, n) for n in needs)
            found = needs if ok else [n for n in needs if not _has(flags, n)]
        row = {'id': cid, 'label': label, 'supported': ok,
               'flags': found if ok else needs,
               'reason': None if ok else why_not}
        if ok and cid in MANUAL_ONLY:
            row['manual_only'] = MANUAL_ONLY[cid]
        out.append(row)
    return out


def _round(x):
    return float('%.2g' % x)


def _current(cfg):
    t = cfg.get('train') or {}
    pp = cfg.get('policy_params') or {}
    adv = cfg.get('advanced') or {}

    def num(v, default=None):
        try:
            return float(v)
        except (TypeError, ValueError):
            return default
    return {
        'lr': num(t.get('lr')),
        'batch': int(num(t.get('batch_size'), 0) or 0) or None,
        'steps': int(num(t.get('steps'), 0) or 0) or None,
        'workers': int(num(t.get('num_workers'), 0) or 0),
        'wd': num(pp.get('optimizer_weight_decay', adv.get('policy.optimizer_weight_decay'))),
        'clip': num(pp.get('optimizer_grad_clip_norm',
                           adv.get('policy.optimizer_grad_clip_norm'))),
        'warmup': num(pp.get('scheduler_warmup_steps', adv.get('policy.scheduler_warmup_steps'))),
        'amp': str(pp.get('use_amp', adv.get('policy.use_amp', ''))).lower() == 'true' or
        str(pp.get('dtype', adv.get('policy.dtype', ''))).lower() in ('bfloat16', 'float16'),
    }


def _patch(**parts):
    return {k: v for k, v in parts.items() if v}


def recommend(issues, cfg, flags, cpu_count=None, best_eval_step=None):
    """Return {'capabilities', 'candidates', 'trial_set', 'notes'} for these issues."""
    flags = set(flags or [])
    caps = {c['id']: c for c in capabilities(flags)}
    cur = _current(cfg)
    cpu = cpu_count or os.cpu_count() or 4
    want = {}  # lever id -> set of issue ids

    for i in issues:
        for lv in i.get('levers', []):
            want.setdefault(lv, set()).add(i['id'])

    cands = []

    def add(lever, cap, title, why, patch, risk, issue_ids, kind='config'):
        c = caps.get(cap) if cap else {'supported': True}
        ok = bool(c and c['supported'])
        cands.append({
            'id': lever, 'title': title, 'why': why, 'kind': kind,
            'patch': patch if ok else {}, 'would_change': patch,
            'supported': ok, 'unsupported_reason': None if ok else (c or {}).get('reason'),
            'risk': risk, 'addresses': sorted(issue_ids),
            'init': 'checkpoint' if kind == 'config' else None})

    if 'lr_down' in want:
        base = cur['lr']
        if base:
            new = _round(base * 0.3)
            add('lr_down', 'lr', 'Lower the learning rate to %g' % new,
                'Current %g. A smaller step is the first remedy for divergence and for '
                'constantly clipped gradients.' % base,
                {'train': {'lr': new}}, 'Slower convergence; may need more steps.',
                want['lr_down'])
        else:
            add('lr_down', 'lr', 'Lower the learning rate',
                'The run did not set a learning rate, so its preset default is in use; set one '
                'explicitly at about a third of that default.', {}, 'Needs a baseline value.',
                want['lr_down'])
    if 'lr_up' in want and cur['lr']:
        new = _round(min(cur['lr'] * 3, 1e-3))
        if new > cur['lr']:
            add('lr_up', 'lr', 'Raise the learning rate to %g' % new,
                'Current %g. Only sensible when the loss is smooth and flat, not noisy.' %
                cur['lr'], {'train': {'lr': new}},
                'Can destabilise training; compare against the control run.', want['lr_up'])
    if 'clip_down' in want:
        base = cur['clip'] or 10.0
        new = 1.0 if base > 2 else _round(base / 2)
        add('clip_down', 'grad_clip', 'Lower gradient clipping to %g' % new,
            'Current %s. A tighter clip bounds the size of any one update.' %
            ('%g' % base if cur['clip'] else '10 (preset default)'),
            {'policy_params': {'optimizer_grad_clip_norm': new}},
            'Slows learning if gradients are legitimately large.', want['clip_down'])
    if 'clip_up' in want:
        base = cur['clip'] or 10.0
        new = _round(base * 3)
        add('clip_up', 'grad_clip', 'Raise gradient clipping to %g' % new,
            'Current %s. Use when most steps are clipped but the loss still falls.' %
            ('%g' % base if cur['clip'] else '10 (preset default)'),
            {'policy_params': {'optimizer_grad_clip_norm': new}},
            'Larger updates; can reintroduce spikes.', want['clip_up'])
    if 'warmup_up' in want:
        base = cur['warmup'] or 1000
        new = int(min(max(base * 2, 1000), (cur['steps'] or 20000) * 0.2))
        add('warmup_up', 'warmup', 'Lengthen LR warm-up to %d steps' % new,
            'A longer ramp-up avoids large early updates, a common cause of early divergence.',
            {'policy_params': {'scheduler_warmup_steps': new}},
            'Little risk; slightly slower start.', want['warmup_up'])
    if 'wd_up' in want:
        base = cur['wd']
        new = 1e-4 if base is None or base < 1e-4 else _round(min(base * 10, 0.1))
        add('wd_up', 'weight_decay', 'Raise weight decay to %g' % new,
            'Current %s. Regularises the weights; the usual first step against overfitting.' %
            ('%g' % base if base is not None else 'preset default'),
            {'policy_params': {'optimizer_weight_decay': new}},
            'Too much underfits; the effect is small on short fine-tunes.', want['wd_up'])
    if 'augment' in want:
        add('augment', 'augment', 'Turn on image augmentation',
            'Random colour/crop changes make a small demonstration set harder to memorise, '
            'and help with the camera differences between recording and running.',
            {'advanced': {'dataset.image_transforms.enable': 'true'}},
            'Changes the training images; keep the live camera setup close to training anyway.',
            want['augment'])
    if 'batch_down' in want and cur['batch'] and cur['batch'] > 1:
        new = max(1, cur['batch'] // 2)
        add('batch_down', 'batch_size', 'Halve the batch size to %d' % new,
            'Current %d. Less GPU memory per step; this also changes the effective batch '
            '(there is no gradient accumulation in this lerobot-train to compensate).' %
            cur['batch'], {'train': {'batch_size': new}},
            'Noisier gradients; scale the learning rate down a little if loss gets noisy.',
            want['batch_down'])
    if 'amp' in want and not cur['amp']:
        if 'policy.use_amp' in flags:
            p = {'policy_params': {'use_amp': 'true'}}
        else:
            p = {'policy_params': {'dtype': 'bfloat16'}}
        add('amp', 'mixed_precision', 'Use mixed precision',
            'Roughly halves activation memory on GPUs that support it.', p,
            'Can reduce numeric accuracy (fp16 especially); bfloat16 needs an Ampere-class GPU '
            'or newer.', want['amp'])
    if 'fp32' in want and cur['amp']:
        if 'policy.use_amp' in flags:
            p = {'policy_params': {'use_amp': 'false'}}
        else:
            p = {'policy_params': {'dtype': 'float32'}}
        add('fp32', 'mixed_precision', 'Switch to full precision',
            'Mixed precision is on in this run; fp16 overflow is a classic source of NaN.', p,
            'Uses more memory and time.', want['fp32'])
    if 'workers_up' in want:
        new = min(cpu, max(2, cur['workers'] * 2))
        if new > cur['workers']:
            add('workers_up', 'workers', 'Use %d data-loader workers' % new,
                'Current %d. Loads the next batch while the GPU computes.' % cur['workers'],
                {'train': {'num_workers': new}}, 'More RAM and CPU use.', want['workers_up'])
    if 'early_stop' in want:
        add('early_stop', None, 'Use the checkpoint at the best validation step',
            ('The validation loss was lowest at step %s. Evaluate that checkpoint on the robot '
             'rather than the final one.' % best_eval_step) if best_eval_step is not None else
            'Evaluate the checkpoint at the best validation step rather than the final one.',
            {}, 'Validation on a few episodes is noisy.', want['early_stop'], kind='selection')

    cands.sort(key=lambda c: (not c['supported'], c['kind'] == 'selection',
                              -len(c['addresses'])))
    # the trial set: at most three supported config candidates, distinct levers
    trial = [c['id'] for c in cands if c['supported'] and c['kind'] == 'config' and c['patch']][:3]
    notes = []
    if not issues:
        notes.append('No problems detected - nothing to change. Keep the current configuration.')
    for cid, row in caps.items():
        if row.get('manual_only'):
            notes.append(row['manual_only'])
    return {'capabilities': list(caps.values()), 'candidates': cands, 'trial_set': trial,
            'notes': notes}


def apply_patch(cfg, patch):
    """Return a deep copy of ``cfg`` with ``patch`` merged in (train / policy_params / advanced)."""
    out = copy.deepcopy(cfg)
    for section in ('train', 'policy_params', 'advanced'):
        if patch.get(section):
            out.setdefault(section, {})
            out[section] = dict(out[section] or {}, **patch[section])
    return out
