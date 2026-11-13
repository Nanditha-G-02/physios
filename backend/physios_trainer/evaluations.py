# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Real-robot evaluation log.

One JSON file per trial in <data_dir>/evaluations/. A trial is what the operator
observed when a checkpoint ran on the robot: outcome, where the object and the
target were, notes. Success rates are computed from these records only.
"""

import math
from pathlib import Path
import re
import time
import uuid

from physios_trainer.util import atomic_write_json, now_iso, read_json

OUTCOMES = {
    'success': 'Success',
    'failed_grasp': 'Failed grasp',
    'missed_place': 'Missed placement',
    'collision': 'Collision',
    'timeout': 'Did not finish',
    'other': 'Other failure',
}


def wilson(k, n, z=1.96):
    if not n:
        return None, None
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return max(0.0, (c - m) / d), min(1.0, (c + m) / d)


def _num(v, name):
    if v in (None, ''):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ValueError('%s must be a number.' % name)
    if not math.isfinite(f) or abs(f) > 5000:
        raise ValueError('%s is out of range.' % name)
    return round(f, 1)


class Evaluations:

    def __init__(self, data_dir):
        self.dir = Path(data_dir) / 'evaluations'
        self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, tid):
        if not re.match(r'^[A-Za-z0-9_-]+$', tid or ''):
            raise KeyError(tid)
        return self.dir / ('%s.json' % tid)

    def list(self, run_id=None, step=None):
        out = []
        for p in self.dir.glob('*.json'):
            t = read_json(p)
            if not t:
                continue
            if run_id and t.get('run_id') != run_id:
                continue
            if step is not None and t.get('step') != step:
                continue
            out.append(t)
        out.sort(key=lambda t: t.get('t', ''))
        return out

    def add(self, rec, checkpoint_lookup):
        run_id = rec.get('run_id')
        step = rec.get('step')
        try:
            step = int(step)
        except (TypeError, ValueError):
            raise ValueError('Choose the checkpoint that was evaluated.')
        ck = checkpoint_lookup(run_id, step)
        if not ck:
            raise ValueError('Checkpoint %s of run %s does not exist.' % (step, run_id))
        outcome = rec.get('outcome')
        if outcome not in OUTCOMES:
            raise ValueError('Outcome must be one of: %s.' % ', '.join(OUTCOMES))
        obj = rec.get('object') or {}
        tgt = rec.get('target') or {}
        t = {
            'id': time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:4],
            't': now_iso(), 'run_id': run_id, 'step': step, 'checkpoint_path': ck['path'],
            'policy': ck.get('policy_type'), 'outcome': outcome,
            'object': {'x_mm': _num(obj.get('x_mm'), 'Object x'),
                       'y_mm': _num(obj.get('y_mm'), 'Object y')},
            'target': {'x_mm': _num(tgt.get('x_mm'), 'Target x'),
                       'y_mm': _num(tgt.get('y_mm'), 'Target y')},
            'conditions': str(rec.get('conditions') or '')[:200],
            'notes': str(rec.get('notes') or '')[:2000],
            'rollout_id': rec.get('rollout_id'),
            'plan_id': rec.get('plan_id'), 'episode_id': rec.get('episode_id'),
            'duration_s': _num(rec.get('duration_s'), 'Duration'),
        }
        atomic_write_json(self._path(t['id']), t)
        return t

    def update(self, tid, patch):
        t = read_json(self._path(tid))
        if not t:
            raise KeyError('Trial %s not found' % tid)
        if 'outcome' in patch:
            if patch['outcome'] not in OUTCOMES:
                raise ValueError('Unknown outcome.')
            t['outcome'] = patch['outcome']
        for k in ('notes', 'conditions'):
            if k in patch:
                t[k] = str(patch[k] or '')[:2000]
        for k in ('object', 'target'):
            if k in patch:
                v = patch[k] or {}
                t[k] = {'x_mm': _num(v.get('x_mm'), k + ' x'),
                        'y_mm': _num(v.get('y_mm'), k + ' y')}
        t['edited_at'] = now_iso()
        atomic_write_json(self._path(tid), t)
        return t

    def delete(self, tid):
        p = self._path(tid)
        if not p.exists():
            raise KeyError('Trial %s not found' % tid)
        trash = self.dir / 'deleted'
        trash.mkdir(exist_ok=True)
        p.replace(trash / p.name)   # kept, just not counted
        return {'ok': True}

    def evaluated_steps(self):
        return {(t['run_id'], t['step']) for t in self.list()}

    def summary(self, trials=None):
        trials = self.list() if trials is None else trials
        groups = {}
        for t in trials:
            g = groups.setdefault((t['run_id'], t['step']), {
                'run_id': t['run_id'], 'step': t['step'], 'policy': t.get('policy'),
                'n': 0, 'success': 0, 'outcomes': {k: 0 for k in OUTCOMES}, 'last': None})
            g['n'] += 1
            g['success'] += t['outcome'] == 'success'
            g['outcomes'][t['outcome']] += 1
            g['last'] = t['t']
        out = []
        for g in groups.values():
            lo, hi = wilson(g['success'], g['n'])
            g['rate'] = g['success'] / g['n'] if g['n'] else None
            g['ci'] = [lo, hi]
            out.append(g)
        out.sort(key=lambda g: (-(g['rate'] or 0), -g['n']))
        return out
