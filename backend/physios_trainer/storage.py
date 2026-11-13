# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Disk space: estimates before training, an inventory of what this service
wrote, and cleanup that can only touch files this service created.

Never listed, never deleted: recorded datasets (anything outside
<data_dir>/datasets), the last checkpoint of a run, checkpoints that have
evaluation results or were marked "keep", and anything an active or queued
run still needs.
"""

import math
import os
from pathlib import Path
import re
import shutil

from physios_trainer.util import dir_size, now_iso

# rough size of ONE checkpoint folder (weights + optimizer state), MB; replaced by
# the measured size of earlier checkpoints of the same policy when there are any
CKPT_MB = {'act': 620, 'diffusion': 1100, 'smolvla': 2500, 'vqbet': 350, 'tdmpc': 120,
           'pi0': 14000, 'pi05': 14000}
MARGIN = 2 * 1024 ** 3   # keep 2 GB free for logs, caches and the OS


def free_bytes(path):
    p = Path(path)
    while not p.exists() and p != p.parent:
        p = p.parent
    try:
        return shutil.disk_usage(p).free
    except OSError:
        return None


def _device(path):
    p = Path(path)
    while not p.exists() and p != p.parent:
        p = p.parent
    try:
        return os.stat(p).st_dev
    except OSError:
        return None


def measured_ckpt_bytes(runs, policy):
    sizes = []
    for r in runs:
        if (r.get('plan') or {}).get('policy') != policy:
            continue
        ck = Path(r.get('output_dir') or '/nonexistent') / 'checkpoints'
        if not ck.is_dir():
            continue
        for d in ck.iterdir():
            if re.match(r'^\d+$', d.name) and d.is_dir():
                sizes.append(dir_size(d))
                break
    sizes = [s for s in sizes if s > 0]
    return (sum(sizes) // len(sizes)) if sizes else None


def estimate(plan, train_cfg, runs):
    """Bytes this plan will write, and whether the disks can take it."""
    policy = plan.get('policy')
    steps = int(train_cfg.get('steps') or 0)
    save = max(1, int(train_cfg.get('save_freq') or steps or 1))
    n_ck = max(1, math.ceil(steps / save)) if steps else 1
    measured = measured_ckpt_bytes(runs, policy)
    per = measured or CKPT_MB.get(policy, 1000) * 1024 ** 2
    ckpt = per * n_ck
    snap = (plan.get('resources') or {}).get('snapshot_bytes') or 0
    items = [{'what': 'checkpoints', 'bytes': ckpt, 'path': plan['output_dir'],
              'detail': '%d × ~%.0f MB (%s)' % (
                  n_ck, per / 1024 ** 2, 'measured on earlier runs' if measured else 'estimate')}]
    if snap:
        items.append({'what': 'converted dataset copy', 'bytes': snap,
                      'path': plan.get('snapshot'), 'detail': 'copy of the recorded dataset'})
    # group needs per filesystem
    need = {}
    for it in items:
        dev = _device(it['path'] or plan['output_dir'])
        need.setdefault(dev, {'bytes': 0, 'path': it['path'] or plan['output_dir']})
        need[dev]['bytes'] += it['bytes']
    disks, errors, warnings = [], [], []
    for d in need.values():
        free = free_bytes(d['path'])
        disks.append({'path': d['path'], 'need': d['bytes'], 'free': free})
        if free is None:
            continue
        if d['bytes'] > free:
            errors.append('Not enough disk space: about %.1f GB needed on %s, %.1f GB free. '
                          'Free space in Training → Storage or save checkpoints less often.' % (
                              d['bytes'] / 1024 ** 3, d['path'], free / 1024 ** 3))
        elif d['bytes'] + MARGIN > free:
            warnings.append('Disk space is tight: about %.1f GB needed, %.1f GB free on %s.' % (
                d['bytes'] / 1024 ** 3, free / 1024 ** 3, d['path']))
    return {'items': items, 'total': sum(i['bytes'] for i in items), 'disks': disks,
            'errors': errors, 'warnings': warnings, 'checkpoint_count': n_ck}


class Storage:

    def __init__(self, data_dir, runs, evaluations=None, queued_roots=lambda: set(), log=print):
        self.data_dir = Path(data_dir)
        self.runs = runs
        self.evaluations = evaluations
        self.queued_roots = queued_roots
        self.log = log

    def _in_use_roots(self):
        roots = set(self.queued_roots())
        for r in self.runs.list():
            if r.get('status') in ('starting', 'copying', 'converting', 'training', 'paused',
                                   'stopping'):
                roots.add((r.get('plan') or {}).get('dataset_root'))
                roots.add((r.get('plan') or {}).get('snapshot'))
        return {str(Path(x).resolve()) for x in roots if x}

    def inventory(self):
        used = self._in_use_roots()
        copies = []
        base = self.data_dir / 'datasets'
        if base.is_dir():
            for owner in sorted(p for p in base.iterdir() if p.is_dir()):
                for d in sorted(p for p in owner.iterdir() if p.is_dir()):
                    users = [r['id'] for r in self.runs.list()
                             if (r.get('plan') or {}).get('dataset_root') and
                             Path(r['plan']['dataset_root']).resolve() == d.resolve()]
                    prot = str(d.resolve()) in used
                    copies.append({'kind': 'copy', 'path': str(d), 'bytes': dir_size(d),
                                   'name': '%s/%s' % (owner.name, d.name), 'used_by': users,
                                   'protected': prot,
                                   'reason': 'used by an active or queued run' if prot else
                                   'converted copy - the recorded dataset is not affected'})
        ckpts = []
        evaluated = self.evaluations.evaluated_steps() if self.evaluations else set()
        # several runs can share one output folder (a resumed run continues in the
        # folder of the run it resumes): protection is the union over all of them
        groups = {}
        for r in self.runs.list():
            ck = Path(r.get('output_dir') or '/nonexistent') / 'checkpoints'
            if ck.is_dir():
                groups.setdefault(os.path.realpath(ck), (ck, []))[1].append(r)
        for ck, rs in groups.values():
            newest = max(rs, key=lambda r: r.get('created_at', ''))
            last = os.path.realpath(ck / 'last') if (ck / 'last').exists() else None
            keep = set()
            for r in rs:
                keep |= set(r.get('keep_steps') or [])
            ids = {r['id'] for r in rs}
            active = any(r.get('status') in ('starting', 'copying', 'converting', 'training',
                                             'paused', 'stopping') for r in rs)
            for d in sorted(ck.iterdir()):
                if not re.match(r'^\d+$', d.name) or not d.is_dir():
                    continue
                step = int(d.name)
                why = None
                if active:
                    why = 'run is active'
                elif last == os.path.realpath(d):
                    why = 'last checkpoint of the run'
                elif any((rid, step) in evaluated for rid in ids):
                    why = 'has evaluation results'
                elif step in keep:
                    why = 'marked keep'
                ckpts.append({'kind': 'checkpoint', 'path': str(d), 'bytes': dir_size(d),
                              'run_id': newest['id'], 'job_name': newest['job_name'],
                              'step': step, 'protected': bool(why),
                              'reason': why or 'intermediate checkpoint',
                              'policy': (newest.get('plan') or {}).get('policy')})
        exports = []
        ex = self.data_dir / 'exports'
        if ex.is_dir():
            for f in sorted(ex.iterdir()):
                if f.is_file():
                    exports.append({'kind': 'export', 'path': str(f), 'bytes': f.stat().st_size,
                                    'name': f.name, 'protected': f.name.endswith('.partial'),
                                    'reason': 'being written' if f.name.endswith('.partial')
                                    else 'exported archive (the checkpoint itself stays)'})
        disks = []
        seen = set()
        for p in [self.data_dir] + [Path(r['output_dir']).parent for r in self.runs.list()
                                    if r.get('output_dir')]:
            dev = _device(p)
            if dev in seen:
                continue
            seen.add(dev)
            try:
                u = shutil.disk_usage(p if p.exists() else self.data_dir)
                disks.append({'path': str(p), 'total': u.total, 'used': u.used, 'free': u.free})
            except OSError:
                pass
        total = sum(x['bytes'] for x in copies + ckpts + exports)
        reclaim = sum(x['bytes'] for x in copies + ckpts + exports if not x['protected'])
        return {'copies': copies, 'checkpoints': ckpts, 'exports': exports, 'disks': disks,
                'total_bytes': total, 'reclaimable_bytes': reclaim}

    def cleanup(self, paths, confirm):
        """Delete exactly the given inventory entries. Every path is re-checked
        against a fresh inventory; anything protected or unknown is refused."""
        if confirm != 'DELETE':
            raise ValueError('Type DELETE to confirm.')
        inv = self.inventory()
        allowed = {x['path']: x for x in inv['copies'] + inv['checkpoints'] + inv['exports']}
        done, refused = [], []
        for p in paths or []:
            x = allowed.get(p)
            if not x:
                refused.append({'path': p, 'reason': 'not something this service created'})
                continue
            if x['protected']:
                refused.append({'path': p, 'reason': x['reason']})
                continue
            try:
                if x['kind'] == 'export':
                    os.remove(p)
                else:
                    shutil.rmtree(p)
                done.append({'path': p, 'bytes': x['bytes'], 'kind': x['kind']})
            except OSError as e:
                refused.append({'path': p, 'reason': str(e)})
        if done:
            with open(self.data_dir / 'cleanup.log', 'a', encoding='utf-8') as f:
                for d in done:
                    f.write('%s deleted %s %s (%d bytes)\n' % (
                        now_iso(), d['kind'], d['path'], d['bytes']))
            self.log('cleanup: deleted %d item(s)' % len(done))
        return {'deleted': done, 'refused': refused,
                'freed_bytes': sum(d['bytes'] for d in done)}
