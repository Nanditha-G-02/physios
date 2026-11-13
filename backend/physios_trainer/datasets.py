# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Find the LeRobot datasets on this machine (read-only)."""

import datetime
import json
import os
from pathlib import Path

from physios_trainer.util import dir_size, read_json

REQUIRED = ('meta', 'data')


def _jsonl(path):
    out = []
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
    except (OSError, ValueError):
        pass
    return out


def reviews_for(path, dataset_id, review_store=None):
    """Episode review decisions: the review store (if reachable) wins over the
    copy exported into the dataset's meta/episode_reviews.json."""
    data = None
    if review_store:
        data = read_json(Path(review_store) / (dataset_id.replace('/', '__') + '.json'))
    if not data:
        data = read_json(Path(path) / 'meta' / 'episode_reviews.json')
    eps = (data or {}).get('episodes') or {}
    return {str(k): (v or {}).get('status') for k, v in eps.items()}


def describe(root, owner, name, review_store=None, with_size=True):
    path = Path(root) / owner / name
    info = read_json(path / 'meta' / 'info.json')
    if not info:
        return None
    dataset_id = '%s/%s' % (owner, name)
    total = int(info.get('total_episodes') or 0)
    reviews = reviews_for(path, dataset_id, review_store)
    counts = {'accepted': 0, 'rejected': 0, 'needs_review': 0}
    for k, st in reviews.items():
        if st in counts and int(k) < total:
            counts[st] += 1
    counts['unreviewed'] = max(0, total - sum(counts.values()))
    features = info.get('features') or {}
    cameras = [k for k, f in features.items() if f.get('dtype') == 'video']
    tasks = [t.get('task') for t in _jsonl(path / 'meta' / 'tasks.jsonl')]
    missing = [d for d in REQUIRED if not (path / d).is_dir()]
    return {
        'id': dataset_id, 'owner': owner, 'name': name, 'path': str(path), 'root': str(root),
        'codebase_version': info.get('codebase_version'),
        'robot_type': info.get('robot_type'),
        'fps': info.get('fps'),
        'total_episodes': total,
        'total_frames': info.get('total_frames'),
        'cameras': cameras,
        'camera_shapes': {k: features[k].get('shape') for k in cameras},
        'state_dim': (features.get('observation.state') or {}).get('shape'),
        'action_dim': (features.get('action') or {}).get('shape'),
        'tasks': tasks,
        'review_counts': counts,
        'rejected_indices': sorted(int(k) for k, s in reviews.items()
                                   if s == 'rejected' and int(k) < total),
        'accepted_indices': sorted(int(k) for k, s in reviews.items()
                                   if s == 'accepted' and int(k) < total),
        'size_bytes': dir_size(path) if with_size else None,
        'modified': datetime.datetime.fromtimestamp(
            (path / 'meta' / 'info.json').stat().st_mtime).isoformat(timespec='seconds'),
        'complete': not missing,
        'missing': missing,
    }


def scan(roots, review_store=None, with_size=True):
    out, seen = [], set()
    for root in roots:
        root = Path(os.path.expanduser(str(root)))
        if not root.is_dir():
            continue
        owners = (p for p in root.iterdir() if p.is_dir() and not p.name.startswith('.'))
        for owner in sorted(owners):
            for ds in sorted(p for p in owner.iterdir() if p.is_dir()):
                if ds.name.startswith('.') or ds.name.endswith('_old') or \
                        ds.name.endswith('_v30'):
                    continue
                real = str(ds.resolve())
                if real in seen:
                    continue
                seen.add(real)
                d = describe(root, owner.name, ds.name, review_store, with_size)
                if d:
                    out.append(d)
    out.sort(key=lambda d: d['modified'], reverse=True)
    return out
