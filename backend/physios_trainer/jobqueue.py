# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Training queue and notifications.

A queued job is a configuration the operator reviewed, together with the
confirmation token of the commands they saw. When it is its turn the plan is
built again; if the commands are no longer identical (dataset changed, LeRobot
updated, output folder taken...) the job is NOT started - it waits as
"needs review" until the operator confirms the new commands.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
import uuid

from physios_trainer.util import atomic_write_json, now_iso, read_json

QUEUED, STARTED, REVIEW, CANCELLED, START_FAILED = (
    'queued', 'started', 'needs_review', 'cancelled', 'start_failed')


class Notifier:
    """Events for the browser (polled) plus a desktop notification via notify-send
    when the service runs inside a desktop session."""

    def __init__(self, data_dir, log=print):
        self.path = Path(data_dir) / 'events.jsonl'
        self.lock = threading.Lock()
        self.log = log
        self.seq = 0
        for line in self._lines():
            try:
                self.seq = max(self.seq, json.loads(line)['seq'])
            except (ValueError, KeyError):
                pass

    def _lines(self):
        try:
            return self.path.read_text(encoding='utf-8').splitlines()
        except OSError:
            return []

    def notify(self, title, body, level='info', run_id=None):
        with self.lock:
            self.seq += 1
            ev = {'seq': self.seq, 't': now_iso(), 'title': title, 'body': body,
                  'level': level, 'run_id': run_id}
            with open(self.path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(ev) + '\n')
        self.log('%s: %s' % (title, body))
        exe = shutil.which('notify-send')
        if exe and (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')
                    or os.environ.get('DBUS_SESSION_BUS_ADDRESS')):
            try:
                subprocess.Popen([exe, '-a', 'PHYSIOS',
                                  '-u', 'critical' if level == 'error' else 'normal',
                                  title, body], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True)
            except OSError:
                pass
        return ev

    def since(self, after=0, limit=50):
        out = []
        for line in self._lines():
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get('seq', 0) > after:
                out.append(ev)
        return {'events': out[-limit:], 'seq': self.seq}


class JobQueue:

    def __init__(self, data_dir, plan_fn, start_fn, runs, foreign_fn, notifier, log=print,
                 interval=4.0):
        self.path = Path(data_dir) / 'queue.json'
        self.plan_fn = plan_fn      # cfg -> plan (raises on error)
        self.start_fn = start_fn    # (plan, cfg) -> run
        self.runs = runs
        self.foreign_fn = foreign_fn
        self.notifier = notifier
        self.log = log
        self.lock = threading.RLock()
        self.interval = interval
        self._stop = False
        threading.Thread(target=self._loop, daemon=True, name='pam-queue').start()

    # ---- persistence ----------------------------------------------------------
    def _load(self):
        return read_json(self.path) or {'items': []}

    def _save(self, data):
        atomic_write_json(self.path, data)

    def list(self):
        return self._load()['items']

    def _find(self, data, qid):
        for it in data['items']:
            if it['id'] == qid:
                return it
        raise KeyError('Queue item %s not found' % qid)

    def dataset_roots(self):
        return {(it.get('plan_summary') or {}).get('dataset_root') for it in self.list()
                if it['status'] in (QUEUED, REVIEW)}

    # ---- operations -----------------------------------------------------------
    def add(self, cfg, token, plan):
        with self.lock:
            data = self._load()
            for it in data['items']:
                if it['status'] in (QUEUED, REVIEW) and it['job_name'] == plan['job_name']:
                    raise ValueError('A queued job is already named "%s".' % plan['job_name'])
            it = {'id': time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:4],
                  'created_at': now_iso(), 'status': QUEUED, 'config': cfg, 'token': token,
                  'job_name': plan['job_name'], 'policy': plan['policy'],
                  'dataset': (plan.get('dataset') or {}).get('id'),
                  'plan_summary': {'dataset_root': plan.get('dataset_root'),
                                   'output_dir': plan['output_dir'],
                                   'stages': [s['kind'] for s in plan['stages']]},
                  'run_id': None, 'error': None}
            data['items'].append(it)
            self._save(data)
        self.kick()
        return it

    def cancel(self, qid):
        with self.lock:
            data = self._load()
            it = self._find(data, qid)
            if it['status'] not in (QUEUED, REVIEW, START_FAILED):
                raise ValueError('Only waiting jobs can be cancelled (this one is %s).' %
                                 it['status'])
            it['status'] = CANCELLED
            it['cancelled_at'] = now_iso()
            self._save(data)
            return it

    def confirm(self, qid, token):
        """Re-queue a job after the operator reviewed its (new) commands."""
        with self.lock:
            data = self._load()
            it = self._find(data, qid)
            if it['status'] not in (REVIEW, START_FAILED, CANCELLED):
                raise ValueError('Job is %s.' % it['status'])
            plan = self.plan_fn(it['config'])
            if not plan['ok']:
                raise ValueError(' '.join(plan['errors']))
            if token != plan['token']:
                raise ValueError('The command changed again; review it once more.')
            it.update(status=QUEUED, token=token, error=None, job_name=plan['job_name'])
            self._save(data)
        self.kick()
        return it

    def move(self, qid, delta):
        with self.lock:
            data = self._load()
            items = data['items']
            it = self._find(data, qid)
            i = items.index(it)
            j = max(0, min(len(items) - 1, i + int(delta)))
            items.insert(j, items.pop(i))
            self._save(data)
            return items

    def clear_finished(self):
        with self.lock:
            data = self._load()
            data['items'] = [it for it in data['items'] if it['status'] in (QUEUED, REVIEW)]
            self._save(data)
            return data['items']

    # ---- dispatcher -------------------------------------------------------------
    def kick(self):
        threading.Thread(target=self.tick, daemon=True).start()

    def _loop(self):
        while not self._stop:
            time.sleep(self.interval)
            try:
                self.tick()
            except Exception as e:  # noqa: BLE001 - keep the dispatcher alive
                self.log('queue: %s' % e)

    def tick(self):
        with self.lock:
            if self.runs.active() or self.foreign_fn():
                return None
            data = self._load()
            it = next((x for x in data['items'] if x['status'] == QUEUED), None)
            if not it:
                return None
            try:
                plan = self.plan_fn(it['config'])
            except Exception as e:  # noqa: BLE001
                it.update(status=REVIEW, error=str(e))
                self._save(data)
                self.notifier.notify('Queued training needs attention',
                                     '%s: %s' % (it['job_name'], e), 'warn')
                return None
            if not plan['ok'] or plan['token'] != it['token']:
                it.update(status=REVIEW, error=' '.join(plan['errors']) if not plan['ok'] else
                          'The command differs from the one you confirmed; review it again.')
                self._save(data)
                self.notifier.notify('Queued training needs review', it['job_name'], 'warn')
                return None
            try:
                run = self.start_fn(plan, it['config'])
            except Exception as e:  # noqa: BLE001
                it.update(status=START_FAILED, error=str(e))
                self._save(data)
                self.notifier.notify('Queued training could not start',
                                     '%s: %s' % (it['job_name'], e), 'error')
                return None
            it.update(status=STARTED, run_id=run['id'], started_at=now_iso())
            self._save(data)
            self.notifier.notify('Training started', '%s (from the queue)' % it['job_name'],
                                 run_id=run['id'])
            return run
