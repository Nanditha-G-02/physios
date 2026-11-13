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

"""File-backed persistence for plans, recording progress, reviews and history.

Layout under the data root (default ``/workspace/physical_ai_manager``, which
the stock docker-compose maps to ``docker/workspace`` on the host)::

    state.json                      active plan, last robot type
    plans/<plan_id>/plan.json       working copy (draft or approved)
    plans/<plan_id>/versions/vN.json immutable approved snapshots
    plans/<plan_id>/progress.json   per-episode recording state
    plans/<plan_id>/events.jsonl    audit log
    reviews/<owner>__<repo>.json    per-dataset episode reviews
    uploads.jsonl                   publish history (HF and GitHub)
    secrets/                        0600 files (GitHub token)

Writes are atomic (temp file + fsync + rename) and serialised by a lock, so a
power cut leaves either the old or the new file, never a half-written one.
"""

import datetime
import json
import os
from pathlib import Path
import tempfile
import threading
import uuid

_LOCK = threading.RLock()


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(
        timespec='seconds')


def default_root():
    env = os.environ.get('PHYSICAL_AI_MANAGER_DATA')
    if env:
        return Path(env)
    ws = Path('/workspace')
    if ws.is_dir() and os.access(ws, os.W_OK):
        return ws / 'physical_ai_manager'
    return Path.home() / '.cache' / 'physical_ai_manager'


def atomic_write_json(path, data, mode=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with _LOCK:
        fd, tmp = tempfile.mkstemp(prefix='.' + path.name, dir=str(path.parent))
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            # mkstemp creates 0600 files; in the robot container (root) that made plans and
            # reviews unreadable for the host user and the gateway. Secrets pass mode=0o600.
            os.chmod(tmp, 0o644 if mode is None else mode)
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)


def read_json(path, default=None):
    path = Path(path)
    if not path.exists():
        return default
    with open(path, encoding='utf-8') as f:
        return json.load(f)


class Store:

    def __init__(self, root=None):
        self.root = Path(root) if root else default_root()
        (self.root / 'plans').mkdir(parents=True, exist_ok=True)
        (self.root / 'reviews').mkdir(parents=True, exist_ok=True)
        self.lock = _LOCK

    # ---- state ------------------------------------------------------------
    def state(self):
        return read_json(self.root / 'state.json', {}) or {}

    def set_state(self, **kw):
        with self.lock:
            s = self.state()
            s.update(kw)
            atomic_write_json(self.root / 'state.json', s)
            return s

    # ---- plans ------------------------------------------------------------
    def plan_dir(self, plan_id):
        if not plan_id or '/' in plan_id or plan_id.startswith('.'):
            raise ValueError('Invalid plan id')
        return self.root / 'plans' / plan_id

    def new_plan_id(self):
        return 'plan-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + \
            uuid.uuid4().hex[:4]

    def list_plan_ids(self):
        d = self.root / 'plans'
        return sorted(p.name for p in d.iterdir() if (p / 'plan.json').exists())

    def load_plan(self, plan_id):
        plan = read_json(self.plan_dir(plan_id) / 'plan.json')
        if plan is None:
            raise KeyError('Plan %s not found' % plan_id)
        return plan

    def save_plan(self, plan):
        with self.lock:
            plan['updated_at'] = now_iso()
            atomic_write_json(self.plan_dir(plan['id']) / 'plan.json', plan)
        return plan

    def save_version(self, plan):
        path = self.plan_dir(plan['id']) / 'versions' / ('v%d.json' % plan['version'])
        if path.exists():
            raise ValueError('Version %d already approved' % plan['version'])
        atomic_write_json(path, plan)

    def load_version(self, plan_id, version):
        v = read_json(self.plan_dir(plan_id) / 'versions' / ('v%d.json' % int(version)))
        if v is None:
            raise KeyError('Approved version %s of %s not found' % (version, plan_id))
        return v

    def list_versions(self, plan_id):
        d = self.plan_dir(plan_id) / 'versions'
        if not d.exists():
            return []
        return sorted(int(p.stem[1:]) for p in d.glob('v*.json'))

    def load_progress(self, plan_id):
        return read_json(self.plan_dir(plan_id) / 'progress.json', None)

    def save_progress(self, plan_id, progress):
        progress['updated_at'] = now_iso()
        atomic_write_json(self.plan_dir(plan_id) / 'progress.json', progress)

    def log_event(self, plan_id, event, **data):
        rec = {'t': now_iso(), 'event': event}
        rec.update(data)
        path = self.plan_dir(plan_id) / 'events.jsonl'
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.lock, open(path, 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')

    def events(self, plan_id, limit=200):
        path = self.plan_dir(plan_id) / 'events.jsonl'
        if not path.exists():
            return []
        lines = path.read_text(encoding='utf-8').splitlines()[-limit:]
        return [json.loads(x) for x in lines if x.strip()]

    def archive_plan(self, plan_id):
        plan = self.load_plan(plan_id)
        plan['status'] = 'archived'
        self.save_plan(plan)
        return plan

    def delete_plan(self, plan_id):
        import shutil
        shutil.rmtree(self.plan_dir(plan_id))

    # ---- reviews ----------------------------------------------------------
    def _review_path(self, dataset_id):
        return self.root / 'reviews' / (dataset_id.replace('/', '__') + '.json')

    def load_reviews(self, dataset_id):
        return read_json(self._review_path(dataset_id), {'dataset': dataset_id,
                                                         'episodes': {}})

    def save_reviews(self, dataset_id, data):
        atomic_write_json(self._review_path(dataset_id), data)

    # ---- uploads ----------------------------------------------------------
    def add_upload(self, record):
        record = dict(record)
        record.setdefault('t', now_iso())
        with self.lock, open(self.root / 'uploads.jsonl', 'a', encoding='utf-8') as f:
            f.write(json.dumps(record, ensure_ascii=False) + '\n')
        return record

    def uploads(self, dataset_id=None, limit=100):
        path = self.root / 'uploads.jsonl'
        if not path.exists():
            return []
        rows = [json.loads(x) for x in path.read_text(encoding='utf-8').splitlines() if x]
        if dataset_id:
            rows = [r for r in rows if r.get('dataset') == dataset_id]
        return rows[-limit:][::-1]

    # ---- secrets ----------------------------------------------------------
    def secret_path(self, name):
        d = self.root / 'secrets'
        d.mkdir(parents=True, exist_ok=True)
        os.chmod(d, 0o700)
        return d / name

    def read_secret(self, name):
        p = self.secret_path(name)
        return p.read_text(encoding='utf-8').strip() if p.exists() else ''

    def write_secret(self, name, value):
        p = self.secret_path(name)
        if not value:
            if p.exists():
                p.unlink()
            return
        fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(value)
