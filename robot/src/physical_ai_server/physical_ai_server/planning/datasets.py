# Copyright 2026 ROBOTIS CO., LTD.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Read-only access to local LeRobot datasets (codebase v2.1 and v3.0).

Nothing here writes into a dataset.  Paths are always resolved inside the
dataset root, so a crafted dataset id cannot escape it.
"""

import datetime
import json
import math
import os
from pathlib import Path

REQUIRED_FOLDERS = ('meta', 'data', 'videos')


class DatasetError(ValueError):
    pass


def default_dataset_root():
    return Path(os.environ.get('HF_LEROBOT_HOME',
                               Path.home() / '.cache' / 'huggingface' / 'lerobot'))


def resolve(root, dataset_id):
    root = Path(root).resolve()
    if not dataset_id or dataset_id.count('/') != 1:
        raise DatasetError('Dataset id must look like "<owner>/<name>".')
    path = (root / dataset_id).resolve()
    if root not in path.parents:
        raise DatasetError('Dataset path escapes the dataset root.')
    return path


def folder_integrity(path):
    """('missing' | 'complete' | 'incomplete', missing folders)."""
    path = Path(path)
    if not path.exists():
        return 'missing', []
    missing = [f for f in REQUIRED_FOLDERS if not (path / f).is_dir()]
    if (path / 'meta' / 'info.json').exists() and not missing:
        return 'complete', []
    return 'incomplete', missing or ['meta/info.json']


def _read_json(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def _read_jsonl(p):
    out = []
    if not Path(p).exists():
        return out
    with open(p, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def _dir_size(path):
    total = 0
    for dirpath, _, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(dirpath, name))
            except OSError:
                pass
    return total


def _version(info):
    v = str(info.get('codebase_version', ''))
    return 'v3' if v.startswith('v3') else 'v2'


def list_datasets(root):
    root = Path(root)
    out = []
    if not root.exists():
        return out
    for owner in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith('.')):
        for ds in sorted(p for p in owner.iterdir() if p.is_dir() and not p.name.startswith('.')):
            info_path = ds / 'meta' / 'info.json'
            state, missing = folder_integrity(ds)
            if not info_path.exists():
                if state == 'incomplete' and (ds / 'meta').exists():
                    out.append({'id': '%s/%s' % (owner.name, ds.name), 'integrity': state,
                                'missing': missing})
                continue
            try:
                info = _read_json(info_path)
            except (OSError, ValueError):
                continue
            out.append({
                'id': '%s/%s' % (owner.name, ds.name),
                'owner': owner.name,
                'name': ds.name,
                'codebase_version': info.get('codebase_version'),
                'robot_type': info.get('robot_type'),
                'fps': info.get('fps'),
                'total_episodes': info.get('total_episodes', 0),
                'total_frames': info.get('total_frames', 0),
                'modified': datetime.datetime.fromtimestamp(
                    info_path.stat().st_mtime).isoformat(timespec='seconds'),
                'integrity': state,
                'missing': missing,
            })
    out.sort(key=lambda d: d.get('modified', ''), reverse=True)
    return out


class Dataset:

    def __init__(self, root, dataset_id):
        self.id = dataset_id
        self.path = resolve(root, dataset_id)
        info_path = self.path / 'meta' / 'info.json'
        if not info_path.exists():
            raise DatasetError('No LeRobot dataset at %s (meta/info.json missing).' % dataset_id)
        self.info = _read_json(info_path)
        self.version = _version(self.info)
        self.fps = float(self.info.get('fps') or 30)
        self.features = self.info.get('features', {})
        self.video_keys = [k for k, f in self.features.items() if f.get('dtype') == 'video']
        self.image_keys = [k for k, f in self.features.items() if f.get('dtype') == 'image']
        self._episodes = None

    # ---- metadata ----------------------------------------------------------
    def tasks(self):
        if self.version == 'v2':
            return [t.get('task') for t in _read_jsonl(self.path / 'meta' / 'tasks.jsonl')]
        p = self.path / 'meta' / 'tasks.parquet'
        if not p.exists():
            return []
        import pandas as pd
        df = pd.read_parquet(p)
        if 'task' in df.columns:
            return list(df['task'])
        return [str(i) for i in df.index]

    def episodes(self):
        if self._episodes is not None:
            return self._episodes
        if self.version == 'v2':
            eps = _read_jsonl(self.path / 'meta' / 'episodes.jsonl')
            rows = [{'episode_index': int(e['episode_index']), 'length': int(e.get('length', 0)),
                     'tasks': e.get('tasks', [])} for e in eps]
        else:
            import pandas as pd
            files = sorted((self.path / 'meta' / 'episodes').glob('chunk-*/file-*.parquet'))
            rows = []
            for f in files:
                df = pd.read_parquet(f)
                for rec in df.to_dict('records'):
                    tasks = rec.get('tasks')
                    rows.append({
                        'episode_index': int(rec['episode_index']),
                        'length': int(rec.get('length', 0)),
                        'tasks': list(tasks) if tasks is not None else [],
                        '_v3': rec,
                    })
        rows.sort(key=lambda r: r['episode_index'])
        for r in rows:
            r['duration_s'] = round(r['length'] / self.fps, 2) if self.fps else None
        self._episodes = rows
        return rows

    def episode(self, index):
        for e in self.episodes():
            if e['episode_index'] == int(index):
                return e
        raise DatasetError('Episode %s not in %s' % (index, self.id))

    def chunk_of(self, index):
        return int(index) // int(self.info.get('chunks_size') or 1000)

    def data_file(self, index):
        if self.version == 'v2':
            rel = self.info['data_path'].format(episode_chunk=self.chunk_of(index),
                                                episode_index=int(index))
            return self.path / rel
        rec = self.episode(index)['_v3']
        rel = self.info['data_path'].format(chunk_index=int(rec['data/chunk_index']),
                                            file_index=int(rec['data/file_index']))
        return self.path / rel

    def video(self, index, key):
        """Relative path (from the dataset folder) and time window of a video."""
        if self.version == 'v2':
            rel = self.info['video_path'].format(episode_chunk=self.chunk_of(index),
                                                 video_key=key, episode_index=int(index))
            return {'path': rel, 'from_s': 0.0, 'to_s': None}
        rec = self.episode(index)['_v3']
        rel = self.info['video_path'].format(
            video_key=key, chunk_index=int(rec['videos/%s/chunk_index' % key]),
            file_index=int(rec['videos/%s/file_index' % key]))
        return {'path': rel, 'from_s': float(rec.get('videos/%s/from_timestamp' % key, 0)),
                'to_s': float(rec.get('videos/%s/to_timestamp' % key, 0)) or None}

    def overview(self):
        eps = self.episodes()
        size = _dir_size(self.path)
        state_names = (self.features.get('observation.state') or {}).get('names')
        created = None
        try:
            created = datetime.datetime.fromtimestamp(
                min(p.stat().st_mtime for p in (self.path / 'meta').iterdir())
            ).isoformat(timespec='seconds')
        except (OSError, ValueError):
            pass
        return {
            'id': self.id,
            'path': str(self.path),
            'codebase_version': self.info.get('codebase_version'),
            'robot_type': self.info.get('robot_type'),
            'fps': self.fps,
            'total_episodes': len(eps),
            'total_frames': int(self.info.get('total_frames') or sum(e['length'] for e in eps)),
            'duration_s': round(sum(e['length'] for e in eps) / self.fps, 1) if self.fps else None,
            'size_bytes': size,
            'tasks': self.tasks(),
            'cameras': [{'key': k, 'shape': self.features[k].get('shape'),
                         'info': self.features[k].get('info')} for k in self.video_keys],
            'state_names': _flat_names(state_names),
            'action_names': _flat_names((self.features.get('action') or {}).get('names')),
            'created': created,
            'modified': datetime.datetime.fromtimestamp(
                (self.path / 'meta' / 'info.json').stat().st_mtime).isoformat(
                    timespec='seconds'),
            'integrity': folder_integrity(self.path)[0],
        }

    # ---- frames ------------------------------------------------------------
    def timeseries(self, index, max_points=600):
        import pandas as pd
        path = self.data_file(index)
        if not path.exists():
            raise DatasetError('Data file missing: %s' % path.relative_to(self.path))
        cols = [c for c in ('timestamp', 'frame_index', 'episode_index', 'observation.state',
                            'action') if c in self.features or c in (
                                'timestamp', 'frame_index', 'episode_index')]
        df = pd.read_parquet(path, columns=[c for c in cols if c])
        if self.version == 'v3' and 'episode_index' in df.columns:
            df = df[df['episode_index'] == int(index)]
        n = len(df)
        step = max(1, math.ceil(n / max_points))
        df = df.iloc[::step]

        def mat(col):
            if col not in df.columns:
                return []
            return [[_finite(v) for v in row] for row in df[col].tolist()]

        return {
            'episode_index': int(index),
            'frames': n,
            'step': step,
            'timestamp': [round(float(t), 4) for t in df['timestamp'].tolist()]
            if 'timestamp' in df.columns else [],
            'state': mat('observation.state'),
            'action': mat('action'),
            'state_names': _flat_names(
                (self.features.get('observation.state') or {}).get('names')),
            'action_names': _flat_names((self.features.get('action') or {}).get('names')),
        }

    # ---- checks ------------------------------------------------------------
    def check_episode(self, index, min_duration_s=1.0):
        """File-level validation of one recorded episode."""
        problems = []
        warnings = []
        try:
            ep = self.episode(index)
        except DatasetError as e:
            return {'ok': False, 'problems': [str(e)], 'warnings': []}
        length = ep['length']
        if length <= 0:
            problems.append('Episode has 0 frames.')
        elif length < min_duration_s * self.fps:
            warnings.append('Only %.1f s recorded (minimum %.1f s).' % (
                length / self.fps, min_duration_s))
        data = self.data_file(index)
        if not data.exists():
            problems.append('Data file missing (%s).' % data.relative_to(self.path))
        else:
            try:
                import pandas as pd
                df = pd.read_parquet(data)
                if self.version == 'v3':
                    df = df[df['episode_index'] == int(index)]
                if len(df) != length:
                    problems.append('Data has %d rows but metadata says %d frames.' % (
                        len(df), length))
                for col in ('observation.state', 'action'):
                    if col in df.columns:
                        bad = sum(1 for row in df[col] for v in row
                                  if v is None or not math.isfinite(float(v)))
                        if bad:
                            problems.append('%d non-finite values in %s.' % (bad, col))
                        else:
                            vals = [list(r) for r in df[col]]
                            if vals and all(v == vals[0] for v in vals):
                                warnings.append('%s never changes - was the arm moving?' % col)
            except Exception as e:  # pragma: no cover - corrupted parquet
                problems.append('Data file unreadable: %s' % e)
        for key in self.video_keys:
            v = self.video(index, key)
            p = self.path / v['path']
            if not p.exists():
                problems.append('Video missing for %s.' % key)
            elif p.stat().st_size == 0:
                problems.append('Video for %s is 0 bytes.' % key)
        return {'ok': not problems, 'problems': problems, 'warnings': warnings,
                'frames': length, 'duration_s': round(length / self.fps, 2)}


def _finite(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f, 5) if math.isfinite(f) else None


def _flat_names(names):
    if names is None:
        return []
    if isinstance(names, dict):
        flat = []
        for v in names.values():
            flat.extend(v if isinstance(v, list) else [v])
        return [str(x) for x in flat]
    return [str(x) for x in names]


def read_info(path):
    p = Path(path) / 'meta' / 'info.json'
    return _read_json(p) if p.exists() else None
