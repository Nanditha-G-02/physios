# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Controlled optimisation trials.

A *session* takes one finished or stopped training run, picks a checkpoint from before its
problem began, and runs a few short comparison trainings from that checkpoint:

* a CONTROL trial with the original settings (the only fair baseline), and
* one trial per proposed change (see tuning.py).

Rules that this module enforces (and its tests check):

* The original run is never modified: its output directory, checkpoints and optimiser state
  stay as they are. Optimiser/scheduler state is never carried into a trial - each trial is a
  NEW run that loads weights only (``--policy.path=<checkpoint>/pretrained_model``) and builds
  a fresh optimiser.
* Every trial is an ordinary run: own output directory (never an existing one), own log,
  metrics and checkpoints, built through the normal validated planner.
* One training at a time. A trial is only started when no other training runs on the machine.
* Budgets are hard limits: number of trials, GPU time (sum of trial wall time), maximum time
  per trial, optional performance target, optional early stopping.
* Manual mode starts nothing by itself. Automatic mode starts only the commands the operator
  reviewed when creating the session (a hash of all of them is confirmed).
* The recommendation is based on logged training metrics - or, when Evaluate trials exist,
  on robot results - and says which. A change is only recommended if it beats the control by
  a margin; otherwise the answer is "keep the original settings".

Sessions are JSON files on disk, so they survive a restart of the service.
"""

import hashlib
import json
from pathlib import Path
import re
import threading
import time
import uuid

from physios_trainer import diagnostics as diag, tuning
from physios_trainer.runner import ACTIVE, foreign_trainings
from physios_trainer.util import atomic_write_json, now_iso, read_json

DEFAULTS = {
    'max_trials': 3,          # alternatives, not counting the control
    'gpu_budget_s': 3600,     # total trial wall-clock time
    'max_trial_s': 1800,      # per trial
    'trial_steps': None,      # None = 10 % of the original run, between 200 and 2000
    'target': None,           # {'metric': 'eval_loss'|'loss', 'value': float}
    'patience': 0,            # stop a trial after this many log points without improvement (0=off)
    'stop_on_divergence': True,
    'auto_restart': False,    # resume a trial that was killed (never after divergence/OOM)
    'min_gain_pct': 5.0,      # a change must beat the control by this much to be recommended
}
LIMITS = {'max_trials': (1, 8), 'gpu_budget_s': (60, 14 * 86400), 'max_trial_s': (30, 7 * 86400),
          'trial_steps': (10, 500000), 'patience': (0, 10000), 'min_gain_pct': (0, 100)}

TERMINAL_TRIAL = ('finished', 'failed', 'stopped', 'diverged', 'skipped')
ARCH_FREE = ('optimizer_', 'scheduler_')
ARCH_FREE_EXACT = ('use_amp', 'dtype')


class OptError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def clean_settings(raw):
    s = dict(DEFAULTS)
    for k, v in (raw or {}).items():
        if k not in DEFAULTS:
            continue
        s[k] = v
    for k, (lo, hi) in LIMITS.items():
        v = s.get(k)
        if v is None:
            continue
        try:
            v = float(v) if k in ('min_gain_pct',) else int(v)
        except (TypeError, ValueError):
            raise OptError('%s must be a number.' % k.replace('_', ' '))
        if not lo <= v <= hi:
            raise OptError('%s must be between %s and %s.' % (k.replace('_', ' '), lo, hi))
        s[k] = v
    t = s.get('target')
    if t:
        if not isinstance(t, dict) or t.get('metric') not in ('eval_loss', 'loss'):
            raise OptError('Target needs a metric (loss or eval_loss) and a value.')
        try:
            t = {'metric': t['metric'], 'value': float(t['value'])}
        except (KeyError, TypeError, ValueError):
            raise OptError('Target value must be a number.')
        s['target'] = t
    s['stop_on_divergence'] = bool(s['stop_on_divergence'])
    s['auto_restart'] = bool(s['auto_restart'])
    return s


def usable_checkpoint(c):
    """A checkpoint is usable if its weights and configs exist and are non-empty."""
    pm = Path(c['path'])
    for name in ('model.safetensors', 'config.json'):
        f = pm / name
        if not f.is_file() or f.stat().st_size == 0:
            return False
    return c.get('step', 0) > 0


def choose_checkpoint(checkpoints, issues, wanted_step=None):
    """Latest usable checkpoint written BEFORE the problem began (or the one asked for)."""
    ok = [c for c in checkpoints if usable_checkpoint(c)]
    if wanted_step is not None:
        for c in ok:
            if c['step'] == int(wanted_step):
                return c, 'the checkpoint you chose'
        raise OptError('Step %s is not a usable checkpoint of this run.' % wanted_step)
    onset = None
    for i in issues:
        ev = i.get('evidence') or {}
        for key in ('first_step', 'onset_step'):
            if ev.get(key) is not None:
                onset = ev[key] if onset is None else min(onset, ev[key])
    pool = [c for c in ok if onset is None or c['step'] < onset]
    if pool:
        c = pool[-1]
        why = ('the latest checkpoint before the problem began (step %s)' % onset
               if onset is not None else 'the latest usable checkpoint')
        return c, why
    return None, ('no usable checkpoint exists before step %s' % onset if onset is not None
                  else 'the run wrote no usable checkpoint')


def _arch_filtered(pp):
    return {k: v for k, v in (pp or {}).items()
            if k.startswith(ARCH_FREE) or k in ARCH_FREE_EXACT}


def build_trial_config(base, patch, ckpt_path, job, steps):
    cfg = tuning.apply_patch(base, patch or {})
    cfg['job_name'] = job
    cfg['output_dir'] = None
    train = dict(cfg.get('train') or {})
    train['steps'] = steps
    train['save_freq'] = max(1, steps // 2)  # a mid-way checkpoint lets a killed trial resume
    train['log_freq'] = max(1, min(int(train.get('log_freq') or 200), max(1, steps // 50)))
    cfg['train'] = train
    if ckpt_path:
        cfg['source'] = {'mode': 'path', 'path': ckpt_path}
        # the checkpoint defines the architecture; only optimiser/scheduler/precision overrides
        # make sense on top of it
        cfg['policy_params'] = _arch_filtered(cfg.get('policy_params'))
    val = cfg.get('validation')
    if val and val.get('enabled'):
        val = dict(val)
        val['eval_steps'] = max(5, steps // 5)
        cfg['validation'] = val
    return cfg


def session_token(trials, settings):
    blob = json.dumps({'t': [x['token'] for x in trials], 's': settings}, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()[:24]


class Sessions:

    def __init__(self, svc, data_dir, log=print, interval=3.0, autostart=True):
        self.svc = svc
        self.dir = Path(data_dir) / 'optimization'
        (self.dir / 'sessions').mkdir(parents=True, exist_ok=True)
        self.log = log
        self.lock = threading.RLock()
        self.interval = interval
        self._stop = False
        self._watch_at = 0
        if autostart:
            threading.Thread(target=self._loop, daemon=True, name='pam-optimizer').start()

    # ---- persistence ------------------------------------------------------------
    def _path(self, sid):
        if not re.match(r'^[A-Za-z0-9_-]+$', sid or ''):
            raise OptError('Session %s not found.' % sid, 404)
        return self.dir / 'sessions' / ('%s.json' % sid)

    def load(self, sid):
        s = read_json(self._path(sid))
        if not s:
            raise OptError('Session %s not found.' % sid, 404)
        return s

    def save(self, s):
        s['updated_at'] = now_iso()
        atomic_write_json(self._path(s['id']), s)

    def list(self):
        out = []
        for f in sorted((self.dir / 'sessions').glob('*.json'), reverse=True):
            s = read_json(f)
            if s:
                out.append(self._summary(s))
        return out

    @staticmethod
    def _summary(s):
        return {k: s.get(k) for k in ('id', 'created_at', 'updated_at', 'name', 'source_run_id',
                                       'mode', 'status', 'status_note', 'settings')} | {
            'trials': [{k: t.get(k) for k in ('id', 'role', 'title', 'status', 'run_id')}
                       for t in s.get('trials', [])],
            'budget': s.get('budget'),
            'recommendation': (s.get('recommendation') or {}).get('headline')}

    def _event(self, s, msg, level='info'):
        s.setdefault('events', []).append({'t': now_iso(), 'msg': msg, 'level': level})
        s['events'] = s['events'][-200:]

    # ---- proposal -------------------------------------------------------------------
    def propose(self, req):
        """Validate and plan everything; nothing is written or started."""
        svc = self.svc
        rid = req.get('run_id')
        if not rid:
            raise OptError('Choose the run to optimise.')
        try:
            run = svc.runs.load(rid)
        except KeyError:
            raise OptError('Run %s not found.' % rid, 404)
        if run['status'] in ACTIVE:
            raise OptError('Run %s is still %s. Stop it first (it keeps its checkpoints), or let '
                           'the monitor stop it for you.' % (run['job_name'], run['status']), 409)
        settings = clean_settings(req.get('settings'))
        mode = req.get('mode', 'manual')
        if mode not in ('manual', 'auto'):
            raise OptError('Mode must be manual or auto.')
        d = svc.diagnostics(rid)
        by = {c['id']: c for c in d['candidates']}
        ids = req.get('candidate_ids') or d['trial_set']
        if not ids:
            raise OptError('No supported change is proposed for this run, so there is nothing to '
                           'trial. %s' % ' '.join(d['notes'][:1]))
        chosen = []
        for cid in ids:
            c = by.get(cid)
            if not c:
                raise OptError('"%s" is not a recommendation for this run.' % cid)
            if not c['supported'] or c['kind'] != 'config' or not c['patch']:
                raise OptError('"%s" cannot be trialled: %s' % (
                    c['title'], c.get('unsupported_reason') or 'it changes no setting'))
            chosen.append(c)
        chosen = chosen[:settings['max_trials']]
        cks = svc.checkpoints(rid)['checkpoints']
        ck, why = choose_checkpoint(cks, d['issues'], req.get('checkpoint_step'))
        base = run.get('config') or {}
        orig_steps = int((base.get('train') or {}).get('steps') or 0)
        steps = settings['trial_steps'] or max(200, min(2000, orig_steps // 10 or 500))
        idx = len(self.list()) + 1
        stem = re.sub(r'[^A-Za-z0-9_.-]+', '_', run['job_name'])[:40]
        trials = []
        notes = []
        if not ck:
            notes.append('No usable checkpoint (%s): the trials start again from the original '
                         'starting weights instead of continuing the run.' % why)
        for n, (role, c) in enumerate([('control', None)] + [('trial', x) for x in chosen]):
            tid = 't%d' % n
            cid = 'control' if c is None else c['id']
            job = '%s_opt%02d_%s' % (stem, idx, cid)
            cfg = build_trial_config(base, (c or {}).get('patch'), ck['path'] if ck else None,
                                     job, steps)
            try:
                plan = svc.plan(cfg)
                errors, warns, token = plan['errors'], plan['warnings'], plan['token']
                argv = next((s_['argv'] for s_ in plan['stages'] if s_['kind'] == 'train'), [])
                stages = [s_['kind'] for s_ in plan['stages']]
            except Exception as e:  # noqa: BLE001 - ApiError carries the operator message
                errors, warns, token, argv, stages = [str(e)], [], 'invalid', [], []
            trials.append({'id': tid, 'role': role, 'candidate_id': cid, 'run_id': None,
                           'title': 'Control: original settings' if c is None else c['title'],
                           'patch': (c or {}).get('patch') or {}, 'config': cfg,
                           'job_name': job, 'token': token, 'errors': errors,
                           'warnings': warns, 'argv': argv, 'stages': stages,
                           'status': 'pending'})
        step_s = d['summary'].get('step_time_s')
        est = (len(trials) * steps * step_s) if step_s else None
        if est and est > settings['gpu_budget_s']:
            notes.append('Estimated %.0f s for all trials is above the %d s GPU budget; the last '
                         'trials would be skipped.' % (est, settings['gpu_budget_s']))
        errs = [e for t in trials for e in t['errors']]
        return {'run_id': rid, 'run_name': run['job_name'], 'mode': mode, 'settings': settings,
                'checkpoint': ({'step': ck['step'], 'path': ck['path'], 'reason': why} if ck
                               else None),
                'init': 'checkpoint' if ck else 'fresh', 'trial_steps': steps, 'trials': trials,
                'estimate_s': est, 'notes': notes, 'errors': errs, 'ok': not errs,
                'issues': [i['id'] for i in d['issues']],
                'token': session_token(trials, settings)}

    # ---- creation ----------------------------------------------------------------------
    def create(self, req, token):
        draft = self.propose(req)
        if not draft['ok']:
            raise OptError('The trials have errors: %s' % ' '.join(draft['errors']))
        if token != draft['token']:
            raise OptError('The planned commands changed since you reviewed them. Review the new '
                           'ones and confirm again.', 409)
        sid = time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:4]
        s = {'id': sid, 'created_at': now_iso(), 'name': req.get('name') or
             'Optimise %s' % draft['run_name'], 'source_run_id': draft['run_id'],
             'mode': draft['mode'], 'settings': draft['settings'],
             'checkpoint': draft['checkpoint'], 'init': draft['init'],
             'trial_steps': draft['trial_steps'], 'issues': draft['issues'], 'notes': draft['notes'],
             'trials': draft['trials'], 'budget': {'used_s': 0.0, 'limit_s': draft['settings'][
                 'gpu_budget_s']}, 'status': 'running' if draft['mode'] == 'auto' else 'ready',
             'status_note': '', 'token': draft['token'], 'events': [], 'recommendation': None,
             'restarts': {}}
        self._event(s, 'Session created (%s mode, %d trials incl. control, %s).' % (
            draft['mode'], len(draft['trials']), 'from checkpoint step %s' % draft['checkpoint'][
                'step'] if draft['checkpoint'] else 'from the original starting weights'))
        with self.lock:
            self.save(s)
        self.svc.notifier.notify('Optimisation session created', s['name'], 'info',
                                 draft['run_id'])
        if draft['mode'] == 'auto':
            threading.Thread(target=self.tick, daemon=True).start()
        return s

    # ---- budgets / limits ------------------------------------------------------------------
    def _elapsed(self, run):
        from datetime import datetime
        try:
            a = datetime.fromisoformat(run.get('started_at') or run['created_at'])
            b = datetime.fromisoformat(run['finished_at']) if run.get('finished_at') else \
                datetime.now(a.tzinfo)
            # run timestamps have 1 s resolution: round a finished run up so the budget is
            # never under-counted
            return max(0.0, (b - a).total_seconds()) + (1.0 if run.get('finished_at') else 0.0)
        except (TypeError, ValueError, KeyError):
            return 0.0

    def _used(self, s):
        """Wall time of finished trials plus the live one."""
        total = 0.0
        for t in s['trials']:
            for rid in ([t['run_id']] if t.get('run_id') else []) + t.get('prior_runs', []):
                try:
                    total += self._elapsed(self.svc.runs.load(rid))
                except KeyError:
                    pass
        return total

    def _busy(self):
        return self.svc.runs.active() or foreign_trainings(self.svc.runs.own_pgids())

    # ---- launching ---------------------------------------------------------------------------
    def launch_trial(self, sid, tid, token=None, automatic=False):
        with self.lock:
            s = self.load(sid)
            t = next((x for x in s['trials'] if x['id'] == tid), None)
            if not t:
                raise OptError('Trial %s not found.' % tid, 404)
            if t['status'] != 'pending':
                raise OptError('Trial is %s.' % t['status'], 409)
            if s['status'] in ('completed', 'stopped', 'budget_exhausted', 'target_reached'):
                raise OptError('This session is %s.' % s['status'], 409)
            if any(x['status'] == 'running' for x in s['trials']):
                raise OptError('Another trial of this session is still running.', 409)
            if self._busy():
                raise OptError('A training is already running; wait for it to finish.', 409)
            used = self._used(s)
            if used >= s['settings']['gpu_budget_s']:
                self._skip_rest(s, 'GPU time budget used up (%.0f s)' % used)
                s['status'] = 'budget_exhausted'
                self.save(s)
                raise OptError('The GPU time budget is used up.', 409)
            if not automatic and token != t['token']:
                raise OptError('Send the token of the command you reviewed.', 409)
            try:
                run = self.svc.start(t['config'], t['token'])
            except Exception as e:  # noqa: BLE001
                status = getattr(e, 'status', 400)
                if status == 409:
                    raise OptError(str(e), 409)
                t['status'] = 'failed'
                t['error'] = str(e)
                self._event(s, 'Trial %s could not start: %s' % (t['title'], e), 'error')
                self.save(s)
                raise OptError(str(e))
            t.update(status='running', run_id=run['id'], started_at=now_iso())
            self._event(s, 'Started trial "%s" (run %s).' % (t['title'], run['id']))
            self.save(s)
            return s

    def _skip_rest(self, s, why):
        for t in s['trials']:
            if t['status'] == 'pending':
                t['status'] = 'skipped'
                t['error'] = why
        self._event(s, 'Remaining trials skipped: %s.' % why, 'warn')

    # ---- controller ------------------------------------------------------------------------------
    def _loop(self):
        while not self._stop:
            time.sleep(self.interval)
            try:
                self.tick()
            except Exception as e:  # noqa: BLE001 - keep the controller alive
                self.log('optimizer: %s' % e)

    def tick(self):
        with self.lock:
            for f in sorted((self.dir / 'sessions').glob('*.json')):
                s = read_json(f)
                if not s or s['status'] not in ('running', 'ready'):
                    continue
                try:
                    self._tick_session(s)
                except Exception as e:  # noqa: BLE001
                    self.log('optimizer session %s: %s' % (s['id'], e))
            self._watch_tick()

    def _live_metrics(self, run_id):
        m = self.svc.runs.metrics(run_id, max_points=20000)
        return m['train'], m['eval']

    def _tick_session(self, s):
        settings = s['settings']
        running = next((t for t in s['trials'] if t['status'] == 'running'), None)
        changed = False
        if running:
            changed |= self._tick_running(s, running)
            running = next((t for t in s['trials'] if t['status'] == 'running'), None)
        if s['status'] == 'running' and not running:
            nxt = next((t for t in s['trials'] if t['status'] == 'pending'), None)
            if nxt:
                if self._used(s) >= settings['gpu_budget_s']:
                    self._skip_rest(s, 'GPU time budget used up')
                    s['status'] = 'budget_exhausted'
                    changed = True
                elif not self._busy():
                    self.save(s)
                    try:
                        self.launch_trial(s['id'], nxt['id'], automatic=True)
                    except OptError as e:
                        if e.status != 409:
                            self.log('optimizer: %s' % e)
                    s = self.load(s['id'])
                    changed = False
        if not any(t['status'] in ('pending', 'running') for t in s['trials']) and \
                s['status'] in ('running', 'ready'):
            self._conclude(s)
            changed = True
        if changed:
            self.save(s)

    def _tick_running(self, s, t):
        """Update the live trial; returns True if the session record changed."""
        settings = s['settings']
        try:
            run = self.svc.runs.load(t['run_id'])
        except KeyError:
            t['status'] = 'failed'
            t['error'] = 'run record missing'
            return True
        elapsed = self._elapsed(run)
        train, evals = self._live_metrics(t['run_id'])
        if run['status'] in ACTIVE:
            if run['status'] == 'stopping':
                return False
            reason = None
            used = self._used(s)
            if elapsed > settings['max_trial_s']:
                reason = ('time', 'longer than the %d s limit per trial' % settings['max_trial_s'])
            elif used >= settings['gpu_budget_s']:
                reason = ('budget', 'the GPU time budget (%d s) is used up' %
                          settings['gpu_budget_s'])
            elif settings['stop_on_divergence']:
                issues = diag.detect(train, evals, [], t['config'], status='training')
                bad = next((i for i in issues if i['id'] in ('nonfinite_loss', 'loss_explosion')),
                           None)
                if bad:
                    reason = ('diverged', bad['title'])
            if not reason and settings['patience'] and self._plateau(train, settings['patience']):
                reason = ('early', 'no improvement for %d log points' % settings['patience'])
            tgt = settings.get('target')
            if not reason and tgt and self._target_hit(train, evals, tgt):
                reason = ('target', 'target %s <= %g reached' % (tgt['metric'], tgt['value']))
            if reason:
                try:
                    self.svc.runs.stop(t['run_id'])
                except RuntimeError:
                    return False
                t['stop_reason'] = reason[1]
                t['stop_kind'] = reason[0]
                self._event(s, 'Stopping trial "%s": %s.' % (t['title'], reason[1]), 'warn')
                return True
            return False
        # finished
        stop_kind = t.get('stop_kind')
        t['finished_at'] = now_iso()
        t['gpu_s'] = round(elapsed, 1)
        t['result'] = self._result(t['run_id'], train, evals)
        bad = [i['id'] for i in diag.detect(train, evals, [], t['config'], status='failed')
               if i['id'] in ('nonfinite_loss', 'loss_explosion')]
        if bad and stop_kind != 'diverged':
            stop_kind = t['stop_kind'] = 'diverged'  # it ended (or was cut) in a diverged state
            t['stop_reason'] = t.get('stop_reason') or 'loss diverged (%s)' % ', '.join(bad)
        if stop_kind == 'diverged':
            t['status'] = 'diverged'
        elif run['status'] == 'succeeded':
            t['status'] = 'finished'
        elif run['status'] == 'stopped':
            # stopped because the target or the patience rule fired: a valid, shorter result;
            # stopped for time, budget or by the operator: kept, but not compared
            t['status'] = 'finished' if stop_kind in ('target', 'early') and \
                t['result'].get('steps') else 'stopped'
        else:
            t['status'] = 'failed'
            t['error'] = (run.get('error') or '')[:300]
            if settings['auto_restart'] and self._can_restart(s, t, run):
                return True
        s['budget']['used_s'] = round(self._used(s), 1)
        self._event(s, 'Trial "%s" %s after %.0f s.' % (t['title'], t['status'], elapsed))
        tgt = settings.get('target')
        if stop_kind == 'target' or (tgt and self._target_hit(train, evals, tgt)):
            s['status_note'] = 'Target reached by "%s".' % t['title']
            self._skip_rest(s, 'the performance target was reached')
            s['target_hit'] = True
        return True

    def _can_restart(self, s, t, run):
        """Auto-restart permission: resume a killed trial once. Never after OOM or divergence."""
        tail = ' '.join((run.get('parser') or {}).get('error_tail') or []).lower()
        if 'out of memory' in tail or s['restarts'].get(t['id'], 0) >= 1:
            return False
        try:
            pv = self.svc.retry(run['id'], 'resume')['preview']
            new = self.svc.retry(run['id'], 'resume', pv['token'])
        except Exception as e:  # noqa: BLE001
            self._event(s, 'Could not restart "%s": %s' % (t['title'], e), 'warn')
            return False
        s['restarts'][t['id']] = s['restarts'].get(t['id'], 0) + 1
        t.setdefault('prior_runs', []).append(t['run_id'])
        t.update(status='running', run_id=new['id'], error=None)
        self._event(s, 'Restarted trial "%s" from its last checkpoint (allowed by the session '
                       'settings).' % t['title'], 'warn')
        return True

    @staticmethod
    def _plateau(train, patience):
        loss = [r['loss'] for r in train if diag.is_num(r.get('loss'))]
        if len(loss) < patience * 2:
            return False
        best_before = min(loss[:-patience])
        return min(loss[-patience:]) >= best_before * 0.999

    @staticmethod
    def _target_hit(train, evals, tgt):
        if tgt['metric'] == 'eval_loss':
            v = [e['eval_loss'] for e in evals if diag.is_num(e.get('eval_loss'))]
        else:
            v = [r['loss'] for r in train[-5:] if diag.is_num(r.get('loss'))]
        return bool(v) and (min(v) if tgt['metric'] == 'eval_loss' else sum(v) / len(v)) <= \
            tgt['value']

    def _result(self, rid, train, evals):
        tr = [r['loss'] for r in train if diag.is_num(r.get('loss'))]
        ev = [e['eval_loss'] for e in evals if diag.is_num(e.get('eval_loss'))]
        summ = diag.summarize(train, evals, self.svc.runs.resource_history(rid, 3000))
        tail = tr[-5:]
        return {'final_loss': sum(tail) / len(tail) if tail else None,
                'min_loss': min(tr) if tr else None, 'eval_best': min(ev) if ev else None,
                'eval_last': ev[-1] if ev else None, 'steps': train[-1]['step'] if train else 0,
                'nonfinite': any('loss' in (r.get('nonfinite') or []) for r in train),
                'gpu_peak_mb': summ['gpu_peak_mb'], 'step_time_s': summ['step_time_s'],
                'stability': summ['stability']['label']}

    # ---- control from the operator ----------------------------------------------------------------
    def stop(self, sid):
        with self.lock:
            s = self.load(sid)
            if s['status'] in ('completed', 'stopped', 'budget_exhausted', 'target_reached'):
                raise OptError('Session is already %s.' % s['status'], 409)
            running = next((t for t in s['trials'] if t['status'] == 'running'), None)
            if running:
                try:
                    self.svc.runs.stop(running['run_id'])
                except RuntimeError:
                    pass
                running['stop_kind'] = 'operator'
                running['stop_reason'] = 'stopped by the operator'
            self._skip_rest(s, 'the session was stopped')
            s['status'] = 'stopped'
            s['status_note'] = 'Stopped by the operator.'
            self._event(s, 'Session stopped by the operator.', 'warn')
            self.save(s)
            return s

    def conclude(self, sid):
        """Manual mode: finish now with whatever has been run."""
        with self.lock:
            s = self.load(sid)
            if any(t['status'] == 'running' for t in s['trials']):
                raise OptError('A trial is still running; stop it first.', 409)
            self._skip_rest(s, 'concluded early by the operator')
            self._conclude(s)
            self.save(s)
            return s

    # ---- recommendation --------------------------------------------------------------------------------
    def _conclude(self, s):
        for t in s['trials']:
            if t['status'] in ('finished', 'stopped', 'diverged') and not t.get('result'):
                train, evals = self._live_metrics(t['run_id']) if t.get('run_id') else ([], [])
                t['result'] = self._result(t['run_id'], train, evals)
        s['recommendation'] = self.recommend(s)
        if s['status'] in ('running', 'ready'):
            if s.get('target_hit'):
                s['status'] = 'target_reached'
            elif any(t['status'] == 'skipped' and 'budget' in (t.get('error') or '') for t in
                     s['trials']):
                s['status'] = 'budget_exhausted'
            else:
                s['status'] = 'completed'
        self._event(s, 'Session %s. %s' % (s['status'].replace('_', ' '),
                                            s['recommendation']['headline']))
        self.svc.notifier.notify('Optimisation finished', '%s - %s' % (
            s['name'], s['recommendation']['headline']), 'ok', s['source_run_id'])

    def recommend(self, s):
        trials = [t for t in s['trials'] if t.get('result') and t['status'] == 'finished']
        control = next((t for t in trials if t['role'] == 'control'), None)
        robot = [(max((g['rate'] for g in self.svc.evaluations.summary()
                       if g['run_id'] == t['run_id'] and g['n'] >= 3), default=None), t)
                 for t in trials]
        robot = [(r, t) for r, t in robot if r is not None]
        use_val = bool(trials) and all(t['result'].get('eval_best') is not None for t in trials)
        metric = 'eval_best' if use_val else 'final_loss'
        label = 'held-out validation loss' if use_val else 'final training loss'
        rank = sorted(({'trial_id': t['id'], 'title': t['title'], 'status': t['status'],
                        'value': t['result'].get(metric), 'stability': t['result']['stability'],
                        'gpu_s': t.get('gpu_s'), 'run_id': t['run_id'],
                        'robot_rate': next((r for r, x in robot if x is t), None)}
                       for t in trials if t['result'].get(metric) is not None),
                      key=lambda x: x['value'])
        rec = {'metric': label, 'ranking': rank, 'robot_based': False, 'winner': None,
               'noise_note': 'Each trial is one short run with one random seed; small differences '
                             'can be noise. Confirm the choice on the robot.'}
        diverged = [t['title'] for t in s['trials'] if t['status'] == 'diverged']
        if diverged:
            rec['diverged'] = diverged
        if robot and control and any(x is control for _, x in robot) and len(robot) >= 2:
            rate, best = max(robot, key=lambda p: p[0])
            ctl_rate = next(r for r, x in robot if x is control)
            if best is not control and rate > ctl_rate:
                rec.update(robot_based=True, winner=best['id'], headline=(
                    '"%s" had the best robot success rate (%.0f%% vs %.0f%% for the original '
                    'settings).' % (best['title'], rate * 100, ctl_rate * 100)))
            else:
                rec.update(robot_based=True, winner=control['id'], headline=(
                    'Keep the original settings: no change beat them on the robot.'))
            return self._finish_rec(s, rec)
        ctl_trial = next((t for t in s['trials'] if t['role'] == 'control'), None)
        stable = [x for x in rank if x['stability'] != 'unstable']
        if ctl_trial and ctl_trial['status'] == 'diverged' and stable:
            best = stable[0]
            rec.update(winner=best['trial_id'], headline=(
                'The original settings diverged again from the same checkpoint; "%s" trained '
                'without diverging (%s %.4g). This is a training-metric result, not a robot '
                'result.' % (best['title'], label, best['value'])))
            return self._finish_rec(s, rec)
        if not control or control['result'].get(metric) is None or len(rank) < 2:
            rec['headline'] = ('Not enough finished trials to recommend a change - the original '
                               'settings stay as they are.')
            rec['winner'] = control['id'] if control else None
            return self._finish_rec(s, rec)
        ctl = control['result'][metric]
        cand = [x for x in rank if x['trial_id'] != control['id'] and x['stability'] != 'unstable'
                and x['status'] == 'finished']
        best = cand[0] if cand else None
        gain = (ctl - best['value']) / abs(ctl) * 100 if best and ctl else None
        need = s['settings']['min_gain_pct']
        rec['control_value'] = ctl
        if best and gain is not None and gain >= need:
            rec.update(winner=best['trial_id'], gain_pct=round(gain, 2), headline=(
                '"%s" lowered the %s by %.1f%% compared with the original settings (%.4g vs '
                '%.4g). This is a training-metric result, not a robot result.' % (
                    best['title'], label, gain, best['value'], ctl)))
        else:
            rec.update(winner=control['id'], headline=(
                'Keep the original settings: no alternative lowered the %s by at least %.0f%% '
                '(best change: %s).' % (label, need,
                                        '%.1f%%' % gain if gain is not None else 'none usable')))
        return self._finish_rec(s, rec)

    def _finish_rec(self, s, rec):
        win = next((t for t in s['trials'] if t['id'] == rec.get('winner')), None)
        if win:
            rec['patch'] = win['patch']
            rec['config'] = win['config']
            rec['run_id'] = win.get('run_id')
            rec['checkpoint_step'] = (win.get('result') or {}).get('steps')
        rec.setdefault('headline', '')
        return rec

    # ---- next run ---------------------------------------------------------------------------------------
    def next_run_plan(self, sid, steps=None, init='winner'):
        """Plan (not start) a full-length run with the recommended settings."""
        s = self.load(sid)
        rec = s.get('recommendation')
        if not rec or not rec.get('winner'):
            raise OptError('This session has no recommendation yet.')
        src_run = self.svc.runs.load(s['source_run_id'])
        base = src_run.get('config') or {}
        win = next(t for t in s['trials'] if t['id'] == rec['winner'])
        if init == 'winner' and win.get('run_id'):
            ck = self.svc.checkpoints(win['run_id'])['checkpoints']
            ck = [c for c in ck if usable_checkpoint(c)]
            if not ck:
                raise OptError('The winning trial left no usable checkpoint.')
            ckpt = ck[-1]['path']
            start = ck[-1]['step']
        else:
            ckpt, start = (s['checkpoint'] or {}).get('path'), (s['checkpoint'] or {}).get('step')
        orig_steps = int((base.get('train') or {}).get('steps') or 0)
        # finish what the original run still owed, but never less than one trial's worth
        remaining = max(s['trial_steps'], orig_steps - int(start or 0))
        steps = int(steps or remaining)
        stem = re.sub(r'[^A-Za-z0-9_.-]+', '_', src_run['job_name'])[:40]
        cfg = build_trial_config(base, win['patch'], ckpt, '%s_opt%s_next' % (stem, s['id'][-4:]),
                                 steps)
        orig_save = int((base.get('train') or {}).get('save_freq') or 0)
        cfg['train']['save_freq'] = max(1, min(orig_save or steps, steps))
        cfg['train']['log_freq'] = int((base.get('train') or {}).get('log_freq') or 200)
        if (base.get('validation') or {}).get('enabled'):
            cfg['validation'] = dict(base['validation'])
        plan = self.svc.plan(cfg)
        return {'config': cfg, 'plan': plan, 'from_checkpoint': ckpt, 'start_step': start,
                'steps': steps, 'patch': win['patch']}

    # ---- monitoring of a live run ---------------------------------------------------------------------
    def _watch_path(self):
        return self.dir / 'watches.json'

    def watches(self):
        return (read_json(self._watch_path()) or {}).get('watches', {})

    def set_watch(self, rid, mode, session_settings=None, ack=False):
        if mode not in ('off', 'flag', 'stop', 'auto'):
            raise OptError('Mode must be off, flag, stop or auto.')
        try:
            run = self.svc.runs.load(rid)
        except KeyError:
            raise OptError('Run %s not found.' % rid, 404)
        if mode in ('stop', 'auto') and not ack:
            raise OptError('Stopping a run automatically needs your explicit permission '
                           '(tick the confirmation).')
        settings = clean_settings(session_settings) if mode == 'auto' else None
        with self.lock:
            data = read_json(self._watch_path()) or {'watches': {}}
            if mode == 'off':
                data['watches'].pop(rid, None)
            else:
                data['watches'][rid] = {'mode': mode, 'since': now_iso(), 'settings': settings,
                                        'seen': {}, 'notified': [], 'acted': False,
                                        'job_name': run['job_name']}
            atomic_write_json(self._watch_path(), data)
        return {'run_id': rid, 'mode': mode}

    def _watch_tick(self):
        if time.time() - self._watch_at < max(10, self.interval * 4):
            return
        self._watch_at = time.time()
        data = read_json(self._watch_path())
        if not data or not data.get('watches'):
            return
        dirty = False
        for rid, w in list(data['watches'].items()):
            try:
                run = self.svc.runs.load(rid)
            except KeyError:
                data['watches'].pop(rid)
                dirty = True
                continue
            if run['status'] in ACTIVE and not w.get('acted'):
                try:
                    d = self.svc.diagnostics(rid)
                except Exception as e:  # noqa: BLE001
                    self.log('watch %s: %s' % (rid, e))
                    continue
                crit = {i['id'] for i in d['issues'] if i['severity'] == 'critical'}
                for iid in list(w['seen']):
                    if iid not in crit:
                        w['seen'].pop(iid)
                for iid in crit:
                    w['seen'][iid] = w['seen'].get(iid, 0) + 1
                dirty = True
                persistent = [i for i in crit if w['seen'][i] >= 2]
                for iid in persistent:
                    issue = next(i for i in d['issues'] if i['id'] == iid)
                    if iid not in w['notified']:
                        w['notified'].append(iid)
                        self.svc.notifier.notify('Training problem: %s' % issue['title'],
                                                 '%s - %s' % (run['job_name'], issue['detail']),
                                                 'error', rid)
                    if w['mode'] in ('stop', 'auto') and not w['acted']:
                        try:
                            self.svc.runs.stop(rid)
                            w['acted'] = True
                            self.svc.notifier.notify(
                                'Run stopped by the monitor',
                                '%s was stopped (%s). Its checkpoints are kept.' % (
                                    run['job_name'], issue['title']), 'warn', rid)
                        except RuntimeError:
                            pass
            elif w.get('acted') and w['mode'] == 'auto' and not w.get('session') and \
                    run['status'] not in ACTIVE:
                w['session'] = 'pending'
                dirty = True
                try:
                    req = {'run_id': rid, 'mode': 'auto', 'settings': w['settings'],
                           'name': 'Automatic: %s' % run['job_name']}
                    draft = self.propose(req)
                    if draft['ok']:
                        sess = self.create(req, draft['token'])
                        w['session'] = sess['id']
                    else:
                        w['session'] = 'failed'
                        self.svc.notifier.notify('Automatic optimisation could not start',
                                                 ' '.join(draft['errors'])[:200], 'error', rid)
                except OptError as e:
                    w['session'] = 'failed'
                    self.svc.notifier.notify('Automatic optimisation could not start', str(e),
                                             'error', rid)
        if dirty:
            atomic_write_json(self._watch_path(), data)
