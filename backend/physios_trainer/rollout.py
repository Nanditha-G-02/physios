# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Host rollouts: run a checkpoint trained here on the robot (see rollout_worker.py).

Two confirmations, both checked by this service:
  1. start  - the operator reviewed the exact configuration (checkpoint, topics,
              safety limits, speed) -> token; the worker loads the model and
              connects, but publishes nothing ("ready", with a dry-run preview)
  2. run    - the operator presses Run; only then the worker sends commands.
Stop / emergency stop are always accepted. An emergency stop also kills the
worker if it does not exit within 0.5 s (no process = no more commands).
The page must send a heartbeat while the arm moves; without it the worker holds.
"""

import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
import uuid

from physios_trainer.util import atomic_write_json, now_iso, read_json

WORKER = Path(__file__).with_name('rollout_worker.py')
ACTIVE = ('loading', 'connecting', 'waiting_for_data', 'ready', 'running', 'paused',
          'starting')


def token_for(cfg):
    keep = {k: cfg.get(k) for k in ('checkpoint', 'cameras', 'state_topic', 'state_names',
                                    'action_topic', 'action_names', 'fps', 'task',
                                    'rename_map', 'limits', 'speed_factor', 'max_duration_s',
                                    'device', 'rosbridge_url',
                                    'allow_unverified_publishers')}
    return hashlib.sha256(json.dumps(keep, sort_keys=True).encode()).hexdigest()[:24]


def validate_limits(limits, proposal):
    """Operator limits may only be tighter than (or equal to) the data envelope,
    widened by at most 10% of its range."""
    errs = []
    pj = {j['name']: j for j in proposal['joints']}
    if [j['name'] for j in limits.get('joints', [])] != [j['name'] for j in proposal['joints']]:
        return ['Safety limits must list exactly the joints of the model, in order.']
    for j in limits['joints']:
        p = pj[j['name']]
        span = max(p['max'] - p['min'], 1e-6)
        try:
            lo, hi, st, ld = (float(j[k]) for k in ('min', 'max', 'max_step', 'max_lead'))
        except (KeyError, TypeError, ValueError):
            errs.append('%s: limits must be numbers.' % j['name'])
            continue
        if lo >= hi:
            errs.append('%s: minimum must be below maximum.' % j['name'])
        if lo < p['min'] - 0.1 * span or hi > p['max'] + 0.1 * span:
            errs.append('%s: %.3f..%.3f goes beyond what the demonstrations covered '
                        '(%.3f..%.3f, +10%% allowed).' % (j['name'], lo, hi, p['min'],
                                                          p['max']))
        if st <= 0 or st > p['max_step'] * 1.5:
            errs.append('%s: max change per step must be >0 and at most %.4f.' % (
                j['name'], p['max_step'] * 1.5))
        if ld <= 0 or ld > p['max_lead'] * 1.5:
            errs.append('%s: max lead must be >0 and at most %.4f.' % (
                j['name'], p['max_lead'] * 1.5))
    return errs


class Rollouts:

    def __init__(self, data_dir, envs, log=print):
        self.dir = Path(data_dir) / 'rollouts'
        self.dir.mkdir(parents=True, exist_ok=True)
        self.safety_dir = Path(data_dir) / 'safety'
        self.safety_dir.mkdir(exist_ok=True)
        self.envs = envs
        self.log = log
        self.procs = {}
        self.lock = threading.RLock()
        for r in self.list():
            if r.get('status') in ACTIVE and not _alive(r.get('pid')):
                r['status'] = 'interrupted'
                r['error'] = 'The service restarted; the worker is no longer running.'
                self._save(r)

    # ---- records ---------------------------------------------------------------
    def _path(self, rid):
        if not rid or not all(c.isalnum() or c in '-_' for c in rid):
            raise KeyError(rid)
        return self.dir / rid

    def _save(self, r):
        r['updated_at'] = now_iso()
        atomic_write_json(self._path(r['id']) / 'rollout.json', r)

    def load(self, rid):
        r = read_json(self._path(rid) / 'rollout.json')
        if r is None:
            raise KeyError('Rollout %s not found' % rid)
        st = read_json(self._path(rid) / 'status.json') or {}
        r['live'] = st
        if st.get('error') and not r.get('error'):
            r['error'] = st['error']
        if st.get('end_reason') and not r.get('end_reason'):
            r['end_reason'] = st['end_reason']
        if r['status'] in ACTIVE:
            if st.get('phase'):
                r['status'] = st['phase'] if st['phase'] in ACTIVE else st['phase']
            if not _alive(r.get('pid')) and r['status'] in ACTIVE:
                r['status'] = 'failed' if not st.get('end_reason') else 'finished'
                r['error'] = r.get('error') or st.get('error') or 'worker exited'
        return r

    def list(self):
        out = []
        for p in sorted(self.dir.iterdir(), reverse=True):
            r = read_json(p / 'rollout.json')
            if r:
                out.append(r)
        return out

    def active(self):
        for r in self.list():
            if r.get('status') in ACTIVE and _alive(r.get('pid')):
                return r
        return None

    # ---- limits ---------------------------------------------------------------
    def limits_proposal(self, env, dataset_root, refresh=False):
        key = hashlib.sha1(dataset_root.encode()).hexdigest()[:12]
        out = self.safety_dir / ('proposal_%s.json' % key)
        if out.exists() and not refresh:
            return read_json(out)
        py = os.path.join(env['prefix'], 'bin', 'python')
        p = subprocess.run([py, '-I', str(WORKER), 'limits', dataset_root, str(out)],
                           capture_output=True, text=True, timeout=300,
                           env=self.envs.env_vars(env))
        if p.returncode != 0 or not out.exists():
            raise RuntimeError('Could not compute limits from %s: %s' % (
                dataset_root, (p.stderr or p.stdout)[-600:]))
        return read_json(out)

    def saved_limits(self, dataset_id):
        return read_json(self.safety_dir / ('%s.json' % dataset_id.replace('/', '__')))

    def save_limits(self, dataset_id, limits):
        rec = dict(limits, saved_at=now_iso())
        atomic_write_json(self.safety_dir / ('%s.json' % dataset_id.replace('/', '__')), rec)
        return rec

    # ---- lifecycle --------------------------------------------------------------
    def start(self, cfg, env, token):
        with self.lock:
            busy = self.active()
            if busy:
                raise RuntimeError('Rollout %s is still %s.' % (busy['id'], busy['status']))
            if token != token_for(cfg):
                raise ValueError('The rollout configuration changed since you reviewed it.')
            rid = time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:4]
            d = self._path(rid)
            d.mkdir(parents=True)
            wcfg = dict(cfg, status_file=str(d / 'status.json'),
                        control_file=str(d / 'control.json'))
            atomic_write_json(d / 'config.json', wcfg)
            atomic_write_json(d / 'control.json', {'command': 'hold', 'heartbeat': 0})
            r = {'id': rid, 'created_at': now_iso(), 'status': 'starting', 'config': cfg,
                 'env': {'name': env['name'], 'prefix': env['prefix']}, 'pid': None,
                 'events': [{'t': now_iso(), 'event': 'started'}], 'trials': []}
            log = open(d / 'rollout.log', 'ab', buffering=0)
            py = os.path.join(env['prefix'], 'bin', 'python')
            try:
                p = subprocess.Popen([py, '-I', str(WORKER), 'run', str(d / 'config.json')],
                                     stdout=log, stderr=subprocess.STDOUT,
                                     stdin=subprocess.DEVNULL, start_new_session=True,
                                     env=self.envs.env_vars(env), cwd=str(d))
            finally:
                log.close()
            self.procs[rid] = p
            r['pid'] = p.pid
            self._save(r)
            threading.Thread(target=self._reap, args=(rid, p), daemon=True).start()
            return r

    def _reap(self, rid, p):
        code = p.wait()
        with self.lock:
            r = read_json(self._path(rid) / 'rollout.json')
            st = read_json(self._path(rid) / 'status.json') or {}
            r['exit_code'] = code
            r['status'] = st.get('phase') if st.get('phase') in ('finished', 'failed') else (
                'stopped' if r.get('stop_requested') else 'failed')
            r['error'] = st.get('error') or (None if r['status'] in ('finished', 'stopped')
                                             else 'worker exited with code %s' % code)
            r['end_reason'] = st.get('end_reason') or r.get('end_reason')
            r['finished_at'] = now_iso()
            r['pid'] = None
            r['events'].append({'t': now_iso(), 'event': r['status']})
            self._save(r)
            self.procs.pop(rid, None)
        self.log('rollout %s ended: %s' % (rid, r['end_reason'] or r['status']))

    def _control(self, rid, **kw):
        path = self._path(rid) / 'control.json'
        c = read_json(path) or {}
        c.update(kw)
        atomic_write_json(path, c)
        return c

    def command(self, rid, command):
        if command not in ('run', 'pause', 'stop', 'estop'):
            raise ValueError('Unknown command.')
        r = self.load(rid)
        if command == 'run':
            if r['status'] not in ('ready', 'paused'):
                raise ValueError('The robot can only start moving from "ready" or "paused" '
                                 '(now %s).' % r['status'])
            self._control(rid, command='run', heartbeat=time.time())
        else:
            self._control(rid, command=command)
        with self.lock:
            rec = read_json(self._path(rid) / 'rollout.json')
            rec['events'].append({'t': now_iso(), 'event': command})
            if command in ('stop', 'estop'):
                rec['stop_requested'] = True
            self._save(rec)
        if command == 'estop':
            threading.Thread(target=self._kill_later, args=(rid, r.get('pid')),
                             daemon=True).start()
        return self.load(rid)

    def _kill_later(self, rid, pid, wait=0.5):
        time.sleep(wait)
        if pid and _alive(pid):
            try:
                os.killpg(pid, signal.SIGKILL)
                self.log('rollout %s: worker killed after emergency stop' % rid)
            except OSError:
                pass

    def heartbeat(self, rid):
        r = read_json(self._path(rid) / 'rollout.json')
        if not r:
            raise KeyError(rid)
        self._control(rid, heartbeat=time.time())
        return {'ok': True}

    def stop_all(self):
        for r in self.list():
            if r.get('pid') and _alive(r['pid']):
                self._control(r['id'], command='estop')
                self._kill_later(r['id'], r['pid'], wait=0.5)

    def log_tail(self, rid, limit=20000):
        p = self._path(rid) / 'rollout.log'
        try:
            data = p.read_bytes()[-limit:]
        except OSError:
            data = b''
        return {'text': data.decode('utf-8', 'replace')}

    def add_trial(self, rid, trial_id):
        with self.lock:
            rec = read_json(self._path(rid) / 'rollout.json')
            rec.setdefault('trials', []).append(trial_id)
            self._save(rec)


def _alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        with open('/proc/%d/stat' % pid) as f:
            return f.read().split()[2] != 'Z'
    except OSError:
        return True
