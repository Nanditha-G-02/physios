# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Managed training runs.

* Each stage is started with ``start_new_session=True`` and its stdout/stderr go
  straight to ``runs/<id>/run.log`` (a file, not a pipe), so the training keeps
  running if this service restarts. On restart, a live run is re-attached by
  PID and its log is tailed again.
* Metrics are parsed from the real log (tqdm progress, ``step:… loss:…`` lines,
  checkpoint messages); nothing is estimated or synthesised.
* Stop = SIGINT, then SIGTERM, then SIGKILL to the process group.
  Pause/Resume = SIGSTOP/SIGCONT to the process group.
"""

import json
import os
from pathlib import Path
import re
import shutil
import signal
import threading
import time
import uuid

from physios_trainer.util import atomic_write_json, now_iso, read_json

ACTIVE = ('starting', 'copying', 'converting', 'training', 'paused', 'stopping')
TQDM = re.compile(r'(\d+)/(\d+) \[')
LOGLINE = re.compile(r'\bstep:(\S+)\s+smpl:')
KV = re.compile(r'([A-Za-z_][A-Za-z0-9_/]*):(-?[\d.]+(?:e[-+]?\d+)?[KMBTQ]?|-?nan|-?inf)',
                re.I)
NONFINITE = ('nan', 'inf')
CKPT = re.compile(r'Checkpoint policy after step (\d+)')
EVAL = re.compile(r'step (\d+): eval_loss=(-?nan|-?inf|[\d.eE+-]+)', re.I)
TRAIN_PROCS = ('lerobot-train', 'lerobot_train', 'lerobot.scripts.train', 'lerobot/scripts/train')


def start_step_of(plan):
    """Absolute step a resume stage starts from (0 for fresh training)."""
    for st in plan.get('stages', []):
        for a in st['argv']:
            if a.startswith('--config_path='):
                ck = Path(a.split('=', 1)[1]).parent.parent
                ts = ck / 'training_state' / 'training_step.json'
                return int((read_json(ts) or {}).get('step') or 0)
    return 0


def big(v):
    m = re.match(r'^(-?[\d.]+(?:[eE][-+]?\d+)?)([KMBTQ]?)$', v)
    if not m:
        return None
    mult = {'': 1, 'K': 1e3, 'M': 1e6, 'B': 1e9, 'T': 1e12, 'Q': 1e15}[m.group(2)]
    try:
        return float(m.group(1)) * mult
    except ValueError:
        return None


def pid_alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        with open('/proc/%d/stat' % pid) as f:
            return f.read().split(')')[-1].split()[0] != 'Z'
    except OSError:
        return True


def cmdline(pid):
    try:
        with open('/proc/%d/cmdline' % pid, 'rb') as f:
            return f.read().replace(b'\0', b' ').decode(errors='replace').strip()
    except OSError:
        return ''


def foreign_trainings(own_pgids=()):
    """Training processes on this machine that were not started by this service."""
    out = []
    for d in os.listdir('/proc'):
        if not d.isdigit():
            continue
        pid = int(d)
        cl = cmdline(pid)
        if not cl or not any(k in cl for k in TRAIN_PROCS):
            continue
        if 'physios_trainer' in cl or 'pam_trainer' in cl or ' --help' in cl:
            continue
        try:
            if os.getpgid(pid) in own_pgids:
                continue
        except OSError:
            continue
        out.append({'pid': pid, 'cmd': cl[:400]})
    return out


class LogParser:
    """Incremental parser of a lerobot-train log."""

    def __init__(self, log_freq=None, state=None):
        s = state or {}
        self.log_freq = log_freq
        self.buf = s.get('buf', '')
        self.lines = s.get('lines', 0)
        self.step = s.get('step', 0)
        self.total = s.get('total')
        self.last = s.get('last', {})
        self.checkpoints = s.get('checkpoints', [])
        self.finished = s.get('finished', False)
        self.error_tail = s.get('error_tail', [])
        # tqdm counts steps of *this process*; on resume it starts at 0 while the
        # absolute step continues - the offset is learnt from absolute log values.
        self.step_offset = s.get('step_offset', 0)
        self.tqdm_n = s.get('tqdm_n')
        self.tqdm_total = s.get('tqdm_total')

    def state(self):
        return {'buf': self.buf[-2000:], 'lines': self.lines, 'step': self.step,
                'total': self.total, 'last': self.last, 'checkpoints': self.checkpoints[-200:],
                'finished': self.finished, 'error_tail': self.error_tail[-30:],
                'step_offset': self.step_offset, 'tqdm_n': self.tqdm_n,
                'tqdm_total': self.tqdm_total}

    def _absolute(self, s):
        if self.tqdm_n is not None:
            self.step_offset = max(0, s - self.tqdm_n)
            if self.tqdm_total is not None:
                self.total = self.tqdm_total + self.step_offset

    def feed(self, text):
        """Returns a list of metric records produced by this chunk."""
        records = []
        self.buf += text
        parts = re.split(r'[\r\n]', self.buf)
        self.buf = parts.pop()  # incomplete tail
        for seg in parts:
            if not seg.strip():
                continue
            m = None
            for m in TQDM.finditer(seg):
                pass
            if m and 'Training' in seg:
                self.tqdm_n, self.tqdm_total = int(m.group(1)), int(m.group(2))
                self.step = self.tqdm_n + self.step_offset
                self.total = self.tqdm_total + self.step_offset
            if LOGLINE.search(seg):
                self.lines += 1
                tail = seg[LOGLINE.search(seg).start():]
                kv = {k: v for k, v in KV.findall(tail)}
                rec = {'t': time.time()}
                sv = kv.get('step', '')
                exact = sv.isdigit()
                if exact:
                    rec['step'] = int(sv)
                    self._absolute(rec['step'])
                elif self.log_freq:
                    rec['step'] = self.lines * self.log_freq + self.step_offset
                else:
                    rec['step'] = int(big(sv) or 0)
                rec['step_exact'] = exact or bool(self.log_freq)
                bad = []
                for k, v in kv.items():
                    if k in ('step', 'smpl', 'ep'):
                        continue
                    if v.lower().lstrip('-') in NONFINITE:
                        bad.append(k)  # JSON cannot carry NaN/Inf - flag it instead
                        continue
                    f = big(v)
                    if f is not None:
                        rec[k] = f
                if bad:
                    rec['nonfinite'] = bad
                if not self.step or rec['step'] > self.step:
                    self.step = rec['step']
                self.last = rec
                records.append(rec)
            c = CKPT.search(seg)
            if c:
                self.checkpoints.append({'step': int(c.group(1)), 't': time.time()})
                self._absolute(int(c.group(1)))
                self.step = max(self.step, int(c.group(1)))
            e = EVAL.search(seg)
            if e:
                rec = {'t': time.time(), 'step': int(e.group(1)), 'kind': 'eval'}
                if e.group(2).lower().lstrip('-') in NONFINITE:
                    rec['nonfinite'] = ['eval_loss']
                else:
                    rec['eval_loss'] = float(e.group(2))
                records.append(rec)
            if 'End of training' in seg:
                self.finished = True
            low = seg.lower()
            if 'traceback' in low or 'error' in low or 'out of memory' in low:
                self.error_tail.append(seg.strip()[:400])
                self.error_tail = self.error_tail[-30:]
        return records


class Runs:

    def __init__(self, data_dir, envs, log=print):
        self.dir = Path(data_dir) / 'runs'
        self.dir.mkdir(parents=True, exist_ok=True)
        self.envs = envs
        self.log = log
        self.lock = threading.RLock()
        self.procs = {}  # run id -> Popen
        self.on_finish = None  # callback(run) after a run reaches a final state
        self.resources = {}
        self._cpu_prev = None
        self._recover()
        threading.Thread(target=self._sampler, daemon=True, name='pam-sampler').start()

    # ---- storage -----------------------------------------------------------
    def path(self, rid):
        if not re.match(r'^[A-Za-z0-9_-]+$', rid or ''):
            raise KeyError(rid)
        return self.dir / rid

    def load(self, rid):
        r = read_json(self.path(rid) / 'run.json')
        if r is None:
            raise KeyError('Run %s not found' % rid)
        return r

    def save(self, run):
        run['updated_at'] = now_iso()
        atomic_write_json(self.path(run['id']) / 'run.json', run)

    def list(self):
        out = []
        for p in sorted(self.dir.iterdir(), reverse=True):
            r = read_json(p / 'run.json')
            if r:
                out.append(r)
        out.sort(key=lambda r: r.get('created_at', ''), reverse=True)
        return out

    def active(self):
        for r in self.list():
            if r.get('status') in ACTIVE:
                return r
        return None

    def own_pgids(self):
        return {r.get('pgid') for r in self.list() if r.get('status') in ACTIVE and r.get('pgid')}

    # ---- lifecycle -----------------------------------------------------------
    def create(self, plan, config, env, resume_of=None):
        with self.lock:
            busy = self.active()
            if busy:
                raise RuntimeError('Run %s is still %s. Stop it before starting another.' % (
                    busy['id'], busy['status']))
            others = foreign_trainings(self.own_pgids())
            if others:
                raise RuntimeError('Another training is already running on this machine (PID %s). '
                                   'It was not started here, so it is left alone; wait for it to '
                                   'finish.' % ', '.join(str(o['pid']) for o in others))
            rid = time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:4]
            run = {'id': rid, 'created_at': now_iso(), 'status': 'starting', 'config': config,
                   'plan': plan, 'env': env, 'output_dir': plan['output_dir'],
                   'job_name': plan['job_name'], 'stage_index': 0, 'stage_results': [],
                   'pid': None, 'pgid': None, 'exit_code': None, 'error': None,
                   'resume_of': resume_of, 'log_freq': (config.get('train') or {}).get('log_freq'),
                   'parser': {'step_offset': start_step_of(plan)},
                   'exports': [], 'events': [{'t': now_iso(), 'event': 'created'}]}
            self.path(rid).mkdir(parents=True)
            self.save(run)
        threading.Thread(target=self._drive, args=(rid,), daemon=True,
                         name='pam-run-%s' % rid).start()
        return run

    def _event(self, run, event, **kw):
        run.setdefault('events', []).append(dict({'t': now_iso(), 'event': event}, **kw))
        run['events'] = run['events'][-200:]

    def _drive(self, rid, start_index=None):
        run = self.load(rid)
        stages = run['plan']['stages']
        i = run['stage_index'] if start_index is None else start_index
        while i < len(stages):
            st = stages[i]
            with self.lock:
                run = self.load(rid)
                if run['status'] in ('stopping', 'stopped'):
                    break
                run['stage_index'] = i
                run['status'] = {'copy': 'copying',
                                 'convert': 'converting'}.get(st['kind'], 'training')
                self._event(run, 'stage_start', stage=st['kind'])
                self.save(run)
            ok = self._run_stage(rid, st)
            with self.lock:
                run = self.load(rid)
                run['stage_results'].append({'kind': st['kind'], 'ok': ok, 't': now_iso(),
                                             'exit_code': run.get('exit_code')})
                if not ok:
                    if run['status'] == 'stopping':
                        run['status'] = 'stopped'
                    else:
                        run['status'] = 'failed'
                        run['error'] = run.get('error') or self._error_summary(run)
                    run['finished_at'] = now_iso()
                    self._event(run, run['status'], stage=st['kind'])
                    self.save(run)
                    self._finished(run)
                    return
                if run['status'] == 'stopping':
                    break
                i += 1
                run['stage_index'] = i
                self.save(run)
        self.lock.acquire()
        run = self.load(rid)
        if run['status'] not in ('stopped', 'failed'):
            run['status'] = 'succeeded' if (run.get('parser') or {}).get('finished') else (
                'stopped' if run['status'] == 'stopping' else 'failed')
            if run['status'] == 'failed' and not run.get('error'):
                run['error'] = (self._error_summary(run) or
                                'Training ended without "End of training".')
        run['finished_at'] = now_iso()
        run['pid'] = None
        self._event(run, run['status'])
        self.save(run)
        self.lock.release()
        self._finished(run)

    def _finished(self, run):
        if self.on_finish:
            try:
                self.on_finish(run)
            except Exception as e:  # noqa: BLE001 - a notification must not break a run
                self.log('on_finish: %s' % e)

    def _error_summary(self, run):
        tail = (run.get('parser') or {}).get('error_tail') or []
        if any('out of memory' in t.lower() for t in tail):
            return 'CUDA out of memory - lower the batch size and retry.'
        return tail[-1] if tail else None

    def _run_stage(self, rid, st):
        logf = self.path(rid) / 'run.log'
        with open(logf, 'a', encoding='utf-8') as f:
            f.write('\n$ %s\n' % ' '.join(_q(a) for a in st['argv']))
        if st['kind'] == 'copy':
            return self._copy(rid, st['argv'][1], st['argv'][2])
        run = self.load(rid)
        env = self.envs.get(run['env']['name'])
        import subprocess
        out = open(logf, 'ab', buffering=0)
        try:
            p = subprocess.Popen(st['argv'], stdout=out, stderr=subprocess.STDOUT,
                                 stdin=subprocess.DEVNULL, start_new_session=True,
                                 env=self.envs.env_vars(env), cwd=str(self.path(rid)))
        except OSError as e:
            out.close()
            run['error'] = 'Could not start %s: %s' % (st['argv'][0], e)
            self.save(run)
            return False
        out.close()
        with self.lock:
            self.procs[rid] = p
            run = self.load(rid)
            run['pid'] = p.pid
            run['pgid'] = p.pid
            run['started_at'] = run.get('started_at') or now_iso()
            run['log_offset_stage'] = logf.stat().st_size
            self.save(run)
        self._follow(rid, lambda: p.poll() is None)
        code = p.wait()
        self._follow(rid, lambda: False)  # flush the remainder
        with self.lock:
            self.procs.pop(rid, None)
            run = self.load(rid)
            run['exit_code'] = code
            run['pid'] = None
            self.save(run)
        if st['kind'] == 'convert' and code == 0:
            self._finish_convert(rid, st)
        return code == 0

    def _copy(self, rid, src, dst):
        dst = Path(dst)
        try:
            if dst.exists():
                shutil.rmtree(dst)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(src, str(dst) + '.partial', ignore=shutil.ignore_patterns(
                'images', '.cache'))
            os.replace(str(dst) + '.partial', dst)
            with open(self.path(rid) / 'run.log', 'a') as f:
                f.write('Copied %s -> %s\n' % (src, dst))
            return True
        except OSError as e:
            run = self.load(rid)
            run['error'] = 'Copy failed: %s' % e
            self.save(run)
            return False

    def _finish_convert(self, rid, st):
        root = Path(st['argv'][st['argv'].index('--root') + 1])
        old = root.parent / (root.name + '_old')
        if old.is_dir() and (root / 'meta' / 'info.json').exists():
            shutil.rmtree(old, ignore_errors=True)  # our own pre-conversion copy
        atomic_write_json(root / '.pam_snapshot.json', {'ok': True, 'converted_at': now_iso(),
                                                        'run': rid})

    def _follow(self, rid, alive):
        """Tail the log into the parser until alive() is False."""
        logf = self.path(rid) / 'run.log'
        while True:
            still = alive()
            run = self.load(rid)
            parser = LogParser(run.get('log_freq'), run.get('parser'))
            off = run.get('log_offset', 0)
            try:
                with open(logf, 'rb') as f:
                    f.seek(off)
                    chunk = f.read(1 << 20)
            except OSError:
                chunk = b''
            if chunk:
                recs = parser.feed(chunk.decode('utf-8', errors='replace'))
                with self.lock:
                    run = self.load(rid)
                    run['log_offset'] = off + len(chunk)
                    run['parser'] = parser.state()
                    run['progress'] = {'step': parser.step, 'total': parser.total,
                                       'last': parser.last}
                    self.save(run)
                if recs:
                    with open(self.path(rid) / 'metrics.jsonl', 'a') as f:
                        for r in recs:
                            f.write(json.dumps(r) + '\n')
                if len(chunk) == 1 << 20:
                    continue
            if not still:
                return
            time.sleep(0.7)

    # ---- control ---------------------------------------------------------------
    def _signal(self, run, sig):
        pgid = run.get('pgid')
        if not pgid or not pid_alive(run.get('pid') or pgid):
            raise RuntimeError('No running process for this run.')
        os.killpg(pgid, sig)

    def stop(self, rid):
        with self.lock:
            run = self.load(rid)
            if run['status'] not in ACTIVE:
                raise RuntimeError('Run is %s.' % run['status'])
            prev = run['status']
            run['status'] = 'stopping'
            self._event(run, 'stop_requested')
            self.save(run)
        if prev == 'copying':
            return self.load(rid)  # the copy loop is short; the driver sees "stopping"
        try:
            if prev == 'paused':
                self._signal(run, signal.SIGCONT)
            self._signal(run, signal.SIGINT)
        except RuntimeError:
            return self.load(rid)
        threading.Thread(target=self._escalate, args=(rid, run['pgid']), daemon=True).start()
        return self.load(rid)

    def _escalate(self, rid, pgid):
        for sig, wait in ((signal.SIGTERM, 20), (signal.SIGKILL, 15)):
            t0 = time.time()
            while time.time() - t0 < wait:
                if not pid_alive(pgid):
                    return
                time.sleep(0.5)
            try:
                os.killpg(pgid, sig)
            except OSError:
                return

    def pause(self, rid):
        with self.lock:
            run = self.load(rid)
            if run['status'] != 'training':
                raise RuntimeError('Only a training stage can be paused (run is %s).' %
                                   run['status'])
            self._signal(run, signal.SIGSTOP)
            run['status'] = 'paused'
            self._event(run, 'paused')
            self.save(run)
            return run

    def resume(self, rid):
        with self.lock:
            run = self.load(rid)
            if run['status'] != 'paused':
                raise RuntimeError('Run is not paused.')
            self._signal(run, signal.SIGCONT)
            run['status'] = 'training'
            self._event(run, 'resumed')
            self.save(run)
            return run

    def log_tail(self, rid, offset=0, limit=65536):
        logf = self.path(rid) / 'run.log'
        if not logf.exists():
            return {'offset': 0, 'text': '', 'size': 0}
        size = logf.stat().st_size
        if offset < 0 or offset > size:
            offset = max(0, size - limit)
        with open(logf, 'rb') as f:
            f.seek(offset)
            data = f.read(limit)
        text = data.decode('utf-8', errors='replace')
        return {'offset': offset + len(data), 'text': text, 'size': size}

    def metrics(self, rid, max_points=1500):
        p = self.path(rid) / 'metrics.jsonl'
        rows = []
        if p.exists():
            with open(p) as f:
                for line in f:
                    try:
                        rows.append(json.loads(line))
                    except ValueError:
                        pass
        train = [r for r in rows if r.get('kind') != 'eval']
        if len(train) > max_points:
            step = len(train) / max_points
            train = [train[int(i * step)] for i in range(max_points)] + [train[-1]]
        return {'train': train, 'eval': [r for r in rows if r.get('kind') == 'eval']}

    # ---- recovery and sampling ---------------------------------------------------
    def _recover(self):
        for run in self.list():
            if run.get('status') not in ACTIVE:
                continue
            pid = run.get('pid')
            if pid and pid_alive(pid) and any(k in cmdline(pid) for k in (
                    'lerobot', 'convert_dataset', 'python')):
                self.log('re-attaching run %s (pid %s)' % (run['id'], pid))
                self._event(run, 'reattached', pid=pid)
                self.save(run)
                threading.Thread(target=self._reattach, args=(run['id'], pid),
                                 daemon=True).start()
            else:
                run['status'] = 'interrupted'
                run['error'] = 'The training service restarted and the process was gone.'
                run['finished_at'] = now_iso()
                self._event(run, 'interrupted')
                self.save(run)

    def _reattach(self, rid, pid):
        self._follow(rid, lambda: pid_alive(pid))
        run = self.load(rid)
        i = run.get('stage_index', 0)
        st = run['plan']['stages'][i]
        finished = (run.get('parser') or {}).get('finished')
        ok = finished if st['kind'] == 'train' else True
        run['exit_code'] = None
        run['stage_results'].append({'kind': st['kind'], 'ok': ok, 't': now_iso(),
                                     'exit_code': None, 'reattached': True})
        if run['status'] == 'stopping':
            run['status'] = 'stopped'
        elif not ok:
            run['status'] = 'failed'
            run['error'] = self._error_summary(run) or ('Exit code unknown (service restarted '
                                                        'during the run); no "End of training".')
        self.save(run)
        if run['status'] in ('stopped', 'failed'):
            run['finished_at'] = now_iso()
            self.save(run)
            self._finished(run)
            return
        if st['kind'] == 'convert':
            self._finish_convert(rid, st)
        run['stage_index'] = i + 1
        self.save(run)
        self._drive(rid)

    def _cpu(self):
        try:
            with open('/proc/stat') as f:
                v = [int(x) for x in f.readline().split()[1:]]
        except OSError:
            return None
        idle, total = v[3] + v[4], sum(v)
        prev, self._cpu_prev = self._cpu_prev, (idle, total)
        if not prev or total == prev[1]:
            return None
        return round(100.0 * (1 - (idle - prev[0]) / (total - prev[1])), 1)

    def _sampler(self):
        from physios_trainer.environment import _meminfo, nvidia_smi
        while True:
            try:
                run = self.active()
                if run:
                    mem = _meminfo()
                    gpu = nvidia_smi()
                    sample = {'t': time.time(), 'cpu_pct': self._cpu(),
                              'ram_used': (mem.get('MemTotal', 0) - mem.get('MemAvailable', 0)),
                              'ram_total': mem.get('MemTotal'),
                              'gpu': (gpu.get('gpus') or [None])[0]}
                    self.resources[run['id']] = sample
                    with open(self.path(run['id']) / 'resources.jsonl', 'a') as f:
                        f.write(json.dumps(sample) + '\n')
                else:
                    self._cpu()
            except Exception as e:  # noqa: BLE001
                self.log('sampler: %s' % e)
            time.sleep(3)

    def resource_history(self, rid, max_points=600):
        p = self.path(rid) / 'resources.jsonl'
        rows = []
        if p.exists():
            with open(p) as f:
                for line in f:
                    try:
                        rows.append(json.loads(line))
                    except ValueError:
                        pass
        if len(rows) > max_points:
            step = len(rows) / max_points
            rows = [rows[int(i * step)] for i in range(max_points)]
        return rows


def _q(a):
    return a if re.match(r'^[A-Za-z0-9_./=:@,+-]+$', a) else "'%s'" % a.replace("'", "'\\''")
