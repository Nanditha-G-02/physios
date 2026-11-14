# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Operations behind the HTTP API (see server.py)."""

import hashlib
import os
from pathlib import Path
import re
import subprocess
import tarfile
import threading
import time

from physios_trainer import catalog, datasets as dsets, diagnostics as diag, planner, tuning
from physios_trainer import storage as stor
from physios_trainer.environment import Environments, system_info
from physios_trainer.evaluations import Evaluations, OUTCOMES
from physios_trainer.introspect import Introspector
from physios_trainer.jobqueue import JobQueue, Notifier
from physios_trainer import rollout as ro
from physios_trainer.optimizer import Sessions
from physios_trainer.robots.store import RobotStore
from physios_trainer.runner import foreign_trainings, Runs
from physios_trainer.util import atomic_write_json, dir_size, now_iso, read_json, version_tuple

HEALTH_PROBE = Path(__file__).with_name('health_probe.py')

# The PHYSIOS data folder (PHYSIOS_DATA_DIR, default <physios>/data) is shared with the PHYSIOS
# robot container (docker/docker-compose.yml): the whole folder at /physios/data, and its
# huggingface/ sub-folder at /root/.cache/huggingface, where LeRobot keeps datasets.
CONTAINER_DATA = os.environ.get('PHYSIOS_CONTAINER_DATA', '/physios/data')
CONTAINER_HF = '/root/.cache/huggingface'
# LeRobot version installed in the PHYSIOS robot image (docker/robot/Dockerfile)
ROBOT_LEROBOT_LOCK = Path(__file__).resolve().parents[2] / 'robot' / 'lerobot.lock'


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class Service:

    def __init__(self, data_root, data_dir, dataset_roots, extra_envs=None, review_store=None,
                 log=print, autostart_optimizer=True):
        # data_root: the PHYSIOS data folder shared with the robot container
        self.repo = Path(data_root).resolve()
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.dataset_roots = [Path(os.path.expanduser(str(r))) for r in dataset_roots]
        # dataset folders the operator added from the Training page (persisted)
        self._roots_file = self.data_dir / 'dataset_roots.json'
        for extra in (read_json(self._roots_file) or {}).get('roots', []):
            pe = Path(extra)
            if pe.is_dir() and pe.resolve() not in [r.resolve() for r in self.dataset_roots]:
                self.dataset_roots.append(pe)
        self.review_store = review_store
        self.envs = Environments(extra_envs)
        self.intro = Introspector(self.envs, self.data_dir / 'cli-cache')
        self.runs = Runs(self.data_dir, self.envs, log=log)
        self.output_root = self.repo / 'outputs' / 'train'
        self.log = log
        self.evaluations = Evaluations(self.data_dir)
        self.notifier = Notifier(self.data_dir, log=log)
        self.queue = JobQueue(self.data_dir, plan_fn=self.plan,
                              start_fn=lambda plan, cfg: self.runs.create(plan, cfg, plan['env']),
                              runs=self.runs,
                              foreign_fn=lambda: foreign_trainings(self.runs.own_pgids()),
                              notifier=self.notifier, log=log)
        self.storage = stor.Storage(self.data_dir, self.runs, self.evaluations,
                                    queued_roots=self.queue.dataset_roots, log=log)
        self.runs.on_finish = self._run_finished
        self.health_jobs = {}
        self.health_lock = threading.Lock()
        self.rollouts = ro.Rollouts(self.data_dir, self.envs, log=log)
        self.robots = RobotStore(self.data_dir)
        self.opt = Sessions(self, self.data_dir, log=log, autostart=autostart_optimizer)

    def _run_finished(self, run):
        prog = run.get('progress') or {}
        loss = (prog.get('last') or {}).get('loss')
        if run['status'] == 'succeeded':
            self.notifier.notify('Training finished', '%s - %s steps%s' % (
                run['job_name'], prog.get('step'), ', loss %s' % loss if loss is not None else ''),
                'ok', run['id'])
        elif run['status'] == 'stopped':
            self.notifier.notify('Training stopped', run['job_name'], 'info', run['id'])
        else:
            self.notifier.notify('Training failed', '%s: %s' % (
                run['job_name'], (run.get('error') or '')[:160]), 'error', run['id'])
        self.queue.kick()

    # ---- discovery ------------------------------------------------------------
    def system(self):
        paths = [p for p in (self.data_dir, self.output_root.parent, *self.dataset_roots)
                 if p.exists()]
        info = system_info(paths)
        info['data_root'] = str(self.repo)
        info['data_dir'] = str(self.data_dir)
        info['output_root'] = str(self.output_root)
        info['dataset_roots'] = [str(r) for r in self.dataset_roots]
        info['container_lerobot'] = self.container_lerobot()
        info['foreign_trainings'] = foreign_trainings(self.runs.own_pgids())
        return info

    def environments(self, refresh=False):
        out = []
        for e in self.envs.list():
            p = self.envs.probe(e['name'], refresh=refresh)
            out.append(p)
        # environments that can train first, then by name
        out.sort(key=lambda p: (not p.get('lerobot_train'), p['name'] != 'lerobot', p['name']))
        return out

    def environment(self, name, refresh=False):
        try:
            probe = self.envs.probe(name, refresh=refresh)
        except KeyError as e:
            raise ApiError(str(e), 404)
        checks = self._env_checks(probe)
        cli = None
        if probe.get('lerobot_train'):
            try:
                data = self.intro.base(name, refresh=refresh)
                cli = {'policy_types': data['base']['policy_types'],
                       'flag_count': len(data['base']['flags']),
                       'logging': [k for k in ('wandb.enable', 'trackio.enable')
                                   if k in data['base']['flags']],
                       'episode_selection': [k for k in ('dataset.episodes',
                                                         'dataset.exclude_episodes')
                                             if k in data['base']['flags']]}
            except RuntimeError as e:
                checks.append({'level': 'error', 'text': str(e)})
        return {'probe': probe, 'checks': checks, 'cli': cli}

    def _env_checks(self, p):
        c = []
        pk = p.get('packages') or {}
        if not p.get('ok'):
            c.append({'level': 'error', 'text': 'Python in this environment did not run: %s' %
                      p.get('error')})
            return c
        if not pk.get('lerobot'):
            c.append({'level': 'error', 'text': 'LeRobot is not installed here.',
                      'fix': 'conda activate %s && pip install lerobot' % p['name']})
        elif not p.get('lerobot_train'):
            c.append({'level': 'error', 'text': 'lerobot-train command missing in this '
                      'environment.', 'fix': 'conda activate %s && pip install -e '
                      '"<your lerobot checkout>[training]"' % p['name']})
        if not pk.get('torch'):
            c.append({'level': 'error', 'text': 'PyTorch is not installed.'})
        elif not p.get('cuda_available'):
            c.append({'level': 'warn', 'text': 'PyTorch here cannot use a CUDA GPU (build: %s). '
                      'Training would run on the CPU.' % (p.get('torch_cuda_build') or 'CPU-only'),
                      'fix': 'Check `nvidia-smi`, then install a CUDA build of torch matching '
                      'the driver (https://pytorch.org/get-started/locally/).'})
        if pk.get('lerobot') and not (pk.get('torchcodec') or pk.get('av')):
            c.append({'level': 'error', 'text': 'No video decoder (torchcodec or av) - LeRobot '
                      'cannot read dataset videos.', 'fix': 'conda activate %s && pip install '
                      '"lerobot[av-dep]"' % p['name']})
        if pk.get('lerobot') and not pk.get('datasets'):
            c.append({'level': 'error', 'text': 'The "datasets" package is missing.',
                      'fix': 'conda activate %s && pip install "lerobot[dataset]"' % p['name']})
        return c

    def datasets(self):
        return dsets.scan(self.dataset_roots, self.review_store)

    # ---- browsing for datasets on this PC (read-only: folder names only)
    @staticmethod
    def _is_dataset(p):
        return (p / 'meta' / 'info.json').is_file()

    def browse(self, path=None):
        """List the sub-folders of `path` (default: the home folder), marking LeRobot datasets."""
        base = Path(os.path.expanduser(path or '~')).resolve()
        if not base.is_dir():
            raise ApiError('%s is not a folder on this PC.' % base, 404)
        entries = []
        try:
            children = sorted(base.iterdir(), key=lambda c: (c.name.startswith('.'), c.name.lower()))
        except OSError as e:
            raise ApiError('Cannot read %s: %s' % (base, e.strerror or e), 403)
        for c in children:
            try:
                if not c.is_dir():
                    continue
                entries.append({'name': c.name, 'path': str(c), 'hidden': c.name.startswith('.'),
                                'dataset': self._is_dataset(c)})
            except OSError:
                continue
            if len(entries) >= 500:
                break
        known = [str(r.resolve()) for r in self.dataset_roots]
        return {'path': str(base), 'parent': str(base.parent) if base.parent != base else None,
                'home': str(Path.home()), 'dataset': self._is_dataset(base),
                'is_root': str(base) in known, 'entries': entries}

    def add_dataset_root(self, path):
        """Make a dataset (or a folder of <owner>/<dataset> folders) available for training.

        A dataset folder adds its grandparent, because datasets are found as
        <folder>/<owner>/<name>. Existing folders are kept; nothing is copied or changed."""
        p = Path(os.path.expanduser(str(path or ''))).resolve()
        if not p.is_dir():
            raise ApiError('%s is not a folder on this PC.' % p, 404)
        root, picked = (p.parent.parent, p) if self._is_dataset(p) else (p, None)
        if picked is None and not any(self._is_dataset(d) for o in root.iterdir() if o.is_dir()
                                      for d in o.iterdir() if d.is_dir()):
            raise ApiError('No LeRobot dataset found in %s. Pick a dataset folder (it contains '
                           'meta/info.json) or a folder of <owner>/<dataset> folders.' % p, 400)
        if root not in [r.resolve() for r in self.dataset_roots]:
            self.dataset_roots.append(root)
            saved = (read_json(self._roots_file) or {}).get('roots', [])
            if str(root) not in saved:
                saved.append(str(root))
            atomic_write_json(self._roots_file, {'roots': saved})
        return {'root': str(root), 'dataset': str(picked) if picked else None,
                'roots': [str(r) for r in self.dataset_roots]}

    def dataset(self, path):
        path = Path(path).resolve()
        for root in self.dataset_roots:
            r = root.resolve()
            if r in path.parents and len(path.relative_to(r).parts) == 2:
                d = dsets.describe(r, path.parent.name, path.name, self.review_store)
                if d:
                    return d
        raise ApiError('Dataset %s is not under a known dataset folder.' % path, 404)

    def models(self, env_name, dataset_path=None):
        env = self.environment(env_name)
        probe = env['probe']
        types = (env['cli'] or {}).get('policy_types') or []
        ds = self.dataset(dataset_path) if dataset_path else None
        out = []
        for key in catalog.ORDER:
            meta = catalog.CATALOG[key]
            chk = catalog.check(key, ds, probe, types)
            out.append({'id': key, 'name': meta['name'], 'summary': meta['summary'],
                        'robots': meta['robots'], 'language': meta['language'],
                        'packages': meta['packages'], 'min_vram_mb': meta['min_vram_mb'],
                        'est_vram_mb': meta['est_vram_mb'], 'notes': meta['notes'],
                        'source': meta['source'], **chk,
                        'defaults': catalog.defaults_for(key, ds, probe) if key in types and
                        not meta.get('blocked') else None})
        others = [t for t in types if t not in catalog.CATALOG]
        return {'models': out, 'other_types': others}

    def policy_flags(self, env_name, policy):
        flags = self.intro.policy(env_name, policy)
        return sorted(f for f in flags if f.startswith('policy.') or f.startswith('dataset.') or
                      f in ('rename_map', 'save_checkpoint', 'eval_steps', 'cudnn_deterministic'))

    # ---- planning -------------------------------------------------------------
    def plan(self, cfg, existing_output_ok=False):
        env_name = cfg.get('env')
        if not env_name:
            raise ApiError('Choose a Python environment.')
        try:
            probe = self.envs.probe(env_name)
        except KeyError as e:
            raise ApiError(str(e), 404)
        if not probe.get('lerobot_train'):
            raise ApiError('Environment "%s" cannot train (no lerobot-train).' % env_name)
        ds = self.dataset(cfg.get('dataset_path') or '')
        policy = cfg.get('policy')
        try:
            flags = self.intro.policy(env_name, policy)
        except (ValueError, RuntimeError) as e:
            raise ApiError(str(e))
        types = self.intro.base(env_name)['base']['policy_types']
        chk = catalog.check(policy, ds, probe, types)
        cfg = dict(cfg)
        cfg['_accepted_indices'] = ds.get('accepted_indices')
        try:
            plan = planner.build(cfg, dataset=ds, probe=probe, flags=flags,
                                 data_dir=self.data_dir, default_output_root=self.output_root,
                                 existing_output_ok=existing_output_ok)
        except planner.PlanError as e:
            raise ApiError(str(e))
        if chk['status'] == 'blocked':
            plan['errors'] = chk['reasons'] + plan['errors']
            plan['ok'] = False
        elif chk['status'] == 'warn':
            plan['warnings'] = chk['reasons'] + plan['warnings']
        plan['dataset'] = {k: ds[k] for k in ('id', 'path', 'codebase_version', 'total_episodes',
                                              'robot_type', 'size_bytes')}
        try:
            est = stor.estimate(plan, cfg.get('train') or {}, self.runs.list())
            plan['storage'] = est
            plan['errors'] = plan['errors'] + est['errors']
            plan['warnings'] = plan['warnings'] + est['warnings']
            plan['ok'] = not plan['errors']
        except (OSError, ValueError, TypeError) as e:
            plan['storage'] = None
            plan['warnings'].append('Could not estimate disk usage: %s' % e)
        plan['busy'] = self.runs.active()
        plan['foreign_trainings'] = foreign_trainings(self.runs.own_pgids())
        plan['compat'] = self.compat_preview(probe)
        return plan

    def start(self, cfg, token):
        plan = self.plan(cfg)
        if not plan['ok']:
            raise ApiError('The configuration has errors: %s' % ' '.join(plan['errors']))
        if token != plan['token']:
            raise ApiError('The command changed since you reviewed it. Review the new command '
                           'and confirm again.', 409)
        try:
            return self.runs.create(plan, cfg, plan['env'])
        except RuntimeError as e:
            raise ApiError(str(e), 409)

    def retry(self, rid, mode='resume', token=None, extra_steps=None):
        old = self.runs.load(rid)
        if old['status'] in ('starting', 'copying', 'converting', 'training', 'paused',
                             'stopping'):
            raise ApiError('Run is still active.')
        probe = self.envs.probe(old['env']['name'])
        flags = self.intro.policy(old['env']['name'], old['plan']['policy'])
        if mode == 'resume':
            try:
                st = planner.resume_stage(probe, flags, old['output_dir'], extra_steps)
            except planner.PlanError as e:
                raise ApiError(str(e))
            plan = dict(old['plan'], stages=[st], token=planner.token_for([st]))
        else:
            cfg = dict(old['config'])
            cfg['job_name'] = (old['job_name'] + '_retry')
            cfg['output_dir'] = None
            plan = self.plan(cfg)
            if not plan['ok']:
                raise ApiError(' '.join(plan['errors']))
        if token is None:
            return {'preview': plan}
        if token != plan['token']:
            raise ApiError('The command changed since you reviewed it.', 409)
        try:
            return self.runs.create(plan, old['config'], old['env'], resume_of=rid)
        except RuntimeError as e:
            raise ApiError(str(e), 409)

    # ---- outputs ---------------------------------------------------------------
    def checkpoints(self, rid):
        run = self.runs.load(rid)
        out = Path(run['output_dir'])
        ck = out / 'checkpoints'
        rows = []
        last = None
        if (ck / 'last').exists():
            try:
                last = os.path.realpath(ck / 'last')
            except OSError:
                pass
        if ck.is_dir():
            for d in sorted(ck.iterdir()):
                if not d.is_dir() or not re.match(r'^\d+$', d.name):
                    continue
                pm = d / 'pretrained_model'
                cfg = read_json(pm / 'config.json') or {}
                rows.append({'step': int(d.name), 'path': str(pm), 'size_bytes': dir_size(d),
                             'model_bytes': dir_size(pm), 'policy_type': cfg.get('type'),
                             'is_last': last == os.path.realpath(d),
                             'keep': int(d.name) in set(run.get('keep_steps') or []),
                             'has_processors': (pm / 'policy_preprocessor.json').exists(),
                             'container_path': self.container_path(pm)})
        tc = None
        if rows:
            tc = read_json(Path(rows[-1]['path']) / 'train_config.json')
        summary = None
        if tc:
            summary = {'policy': (tc.get('policy') or {}).get('type'),
                       'dataset': (tc.get('dataset') or {}).get('repo_id'),
                       'dataset_root': (tc.get('dataset') or {}).get('root'),
                       'steps': tc.get('steps'), 'batch_size': tc.get('batch_size'),
                       'seed': tc.get('seed'),
                       'lr': (tc.get('optimizer') or {}).get('lr')}
        meta = read_json(out / 'pam_model.json')
        ev = {g['step']: g for g in self.evaluations.summary(self.evaluations.list(run_id=rid))}
        for r_ in rows:
            g = ev.get(r_['step'])
            r_['evaluation'] = {'n': g['n'], 'success': g['success'], 'rate': g['rate'],
                                'ci': g['ci']} if g else None
        return {'run_id': rid, 'output_dir': str(out), 'checkpoints': rows,
                'train_config': summary, 'metadata': meta,
                'compat': self.compat(run, rows[-1] if rows else None)}

    def container_lerobot(self):
        """LeRobot version of the robot container (Inference, In-container training)."""
        env = os.environ.get('PHYSIOS_ROBOT_LEROBOT_VERSION')
        if env:
            return env
        for pp in (self.repo / 'lerobot' / 'pyproject.toml', ROBOT_LEROBOT_LOCK):
            try:
                m = re.search(r'^version\s*=\s*"([^"]+)"', pp.read_text(), re.M)
                if m:
                    return m.group(1)
            except OSError:
                continue
        return None

    def container_path(self, p):
        p = Path(p).resolve()
        hf = (self.repo / 'huggingface').resolve()
        if hf in p.parents:
            return CONTAINER_HF + '/' + str(p.relative_to(hf))
        if self.repo in p.parents:
            return CONTAINER_DATA + '/' + str(p.relative_to(self.repo))
        return None

    def compat_preview(self, probe):
        cv = self.container_lerobot()
        tv = (probe.get('packages') or {}).get('lerobot')
        same = version_tuple(cv)[:2] == version_tuple(tv)[:2] if cv and tv else None
        return {'container_lerobot': cv, 'training_lerobot': tv, 'same_minor': same}

    def compat(self, run, ckpt):
        cv = self.container_lerobot()
        tv = (run.get('env') or {}).get('lerobot')
        reasons = []
        ok = True
        if not ckpt:
            return {'inference_ok': False, 'reasons': ['No checkpoint yet.'],
                    'container_lerobot': cv, 'training_lerobot': tv}
        if not ckpt.get('container_path'):
            ok = False
            reasons.append('Checkpoint is outside the folders shared with the Inference '
                           'container.')
        if cv and tv and version_tuple(cv)[:2] != version_tuple(tv)[:2]:
            ok = False
            reasons.append('Trained with LeRobot %s; the Inference session runs LeRobot %s inside '
                           'the physical_ai_server container, which cannot load this format%s.' % (
                               tv, cv, ' (its normalisation lives in separate processor files)'
                               if ckpt.get('has_processors') else ''))
        return {'inference_ok': ok, 'reasons': reasons, 'container_lerobot': cv,
                'training_lerobot': tv}

    def save_metadata(self, rid, notes='', name=''):
        info = self.checkpoints(rid)
        run = self.runs.load(rid)
        prog = run.get('progress') or {}
        meta = {'name': name or run['job_name'], 'notes': notes, 'saved_at': now_iso(),
                'run_id': rid, 'policy': run['plan']['policy'],
                'dataset': run['plan']['dataset'], 'env': run['env'],
                'status': run['status'], 'steps_completed': prog.get('step'),
                'final_metrics': prog.get('last'), 'train_config': info['train_config'],
                'checkpoints': [c['step'] for c in info['checkpoints']],
                'command': [s['argv'] for s in run['plan']['stages']]}
        atomic_write_json(Path(run['output_dir']) / 'pam_model.json', meta)
        return meta

    def export(self, rid, step):
        info = self.checkpoints(rid)
        ck = next((c for c in info['checkpoints'] if c['step'] == int(step)), None)
        if not ck:
            raise ApiError('Checkpoint %s not found.' % step, 404)
        run = self.runs.load(rid)
        dest = self.data_dir / 'exports' / ('%s_step%06d.tar.gz' % (run['job_name'], ck['step']))
        dest.parent.mkdir(parents=True, exist_ok=True)
        rec = {'step': ck['step'], 'path': str(dest), 'status': 'running', 't': now_iso()}
        run.setdefault('exports', []).append(rec)
        self.runs.save(run)

        def work():
            status, err = 'done', None
            try:
                tmp = str(dest) + '.partial'
                with tarfile.open(tmp, 'w:gz') as tar:
                    tar.add(ck['path'], arcname='%s_step%06d' % (run['job_name'], ck['step']))
                    pm = Path(run['output_dir']) / 'pam_model.json'
                    if pm.exists():
                        tar.add(str(pm), arcname='%s_step%06d/pam_model.json' % (
                            run['job_name'], ck['step']))
                os.replace(tmp, dest)
            except OSError as e:
                status, err = 'failed', str(e)
            r = self.runs.load(rid)
            for x in r.get('exports', []):
                if x['path'] == str(dest) and x['status'] == 'running':
                    x.update(status=status, error=err, size_bytes=dest.stat().st_size
                             if dest.exists() else None)
            self.runs.save(r)

        threading.Thread(target=work, daemon=True).start()
        return rec

    # ---- queue -------------------------------------------------------------------
    def enqueue(self, cfg, token):
        plan = self.plan(cfg)
        if not plan['ok']:
            raise ApiError('The configuration has errors: %s' % ' '.join(plan['errors']))
        if token != plan['token']:
            raise ApiError('The command changed since you reviewed it. Review the new command '
                           'and confirm again.', 409)
        try:
            return self.queue.add(cfg, token, plan)
        except ValueError as e:
            raise ApiError(str(e), 409)

    def queue_preview(self, qid):
        it = next((x for x in self.queue.list() if x['id'] == qid), None)
        if not it:
            raise ApiError('Queue item %s not found.' % qid, 404)
        return {'item': it, 'preview': self.plan(it['config'])}

    # ---- evaluations ---------------------------------------------------------------
    def _checkpoint(self, rid, step):
        try:
            info = self.checkpoints(rid)
        except KeyError:
            return None
        return next((c for c in info['checkpoints'] if c['step'] == step), None)

    def add_trial(self, rec):
        try:
            return self.evaluations.add(rec, self._checkpoint)
        except ValueError as e:
            raise ApiError(str(e))

    def evaluation_overview(self, run_id=None):
        trials = self.evaluations.list(run_id=run_id)
        names = {r['id']: r['job_name'] for r in self.runs.list()}
        summary = self.evaluations.summary(trials)
        for g in summary:
            g['job_name'] = names.get(g['run_id'], g['run_id'])
        for t in trials:
            t['job_name'] = names.get(t['run_id'], t['run_id'])
        return {'trials': trials, 'summary': summary, 'outcomes': OUTCOMES}

    # ---- training optimisation (Phase 1) -----------------------------------------------
    def run_config_clip(self, cfg):
        pp = cfg.get('policy_params') or {}
        adv = cfg.get('advanced') or {}
        v = pp.get('optimizer_grad_clip_norm', adv.get('policy.optimizer_grad_clip_norm'))
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    def diagnostics(self, rid):
        """Metrics summary, detected problems and capability-aware recommendations for a run.

        Pure read: it never changes the run, its checkpoints or its optimiser state.
        """
        try:
            run = self.runs.load(rid)
        except KeyError:
            raise ApiError('Run %s not found.' % rid, 404)
        cfg = run.get('config') or {}
        m = self.runs.metrics(rid, max_points=20000)
        rows, evals = m['train'], m['eval']
        res = self.runs.resource_history(rid, max_points=5000)
        parser = run.get('parser') or {}
        issues = diag.detect(rows, evals, res, cfg, status=run.get('status'),
                             error_tail=parser.get('error_tail'),
                             clip_norm=self.run_config_clip(cfg))
        summary = diag.summarize(rows, evals, res)
        policy = (run.get('plan') or {}).get('policy')
        flags, flag_error = set(), None
        try:
            flags = self.intro.policy((run.get('env') or {}).get('name'), policy)
        except (ValueError, RuntimeError, KeyError) as e:
            flag_error = str(e)
        best = None
        ev = [e for e in evals if e.get('eval_loss') is not None]
        if ev:
            best = min(ev, key=lambda e: e['eval_loss'])['step']
        recs = tuning.recommend(issues, cfg, flags, best_eval_step=best)
        if flag_error:
            recs['notes'].append('Could not inspect this run\'s lerobot-train (%s); every lever '
                                 'is shown as unsupported until the environment is reachable.' %
                                 flag_error)
        st = diag.step_times([r for r in rows if r.get('kind') != 'eval'])
        gpu = diag.gpu_series(res, rows)
        step = max(1, len(rows) // 600)

        def thin(seq):
            return seq[::max(1, len(seq) // 600)]
        series = {
            'loss': [{'x': r['step'], 'y': r['loss']} for r in rows[::step] if 'loss' in r],
            'eval_loss': [{'x': e['step'], 'y': e['eval_loss']} for e in ev],
            'lr': [{'x': r['step'], 'y': r['lr']} for r in rows[::step] if 'lr' in r],
            'grad_norm': [{'x': r['step'], 'y': r['grdn']} for r in rows[::step] if 'grdn' in r],
            'step_time': [{'x': x['step'], 'y': x['s']} for x in thin(st)],
            'gpu_mb': [{'x': g['step'], 'y': g['mb']} for g in thin(gpu)],
        }
        val_on = any('dataset.eval_split' in a for stg in (run.get('plan') or {}).get('stages', [])
                     for a in stg['argv'])
        evals_robot = [g for g in self.evaluations.summary() if g['run_id'] == rid]
        return {
            'run': {'id': rid, 'job_name': run['job_name'], 'status': run['status'],
                    'policy': policy, 'progress': run.get('progress'), 'config': cfg},
            'summary': summary, 'issues': issues, 'series': series,
            'clip_norm': self.run_config_clip(cfg) or diag.DEFAULT_CLIP,
            'clip_norm_assumed': self.run_config_clip(cfg) is None,
            'validation': {'enabled': val_on, 'supported': 'dataset.eval_split' in flags and
                           'eval_steps' in flags, 'points': len(ev)},
            'robot_evaluations': evals_robot,
            **recs,
            'caveats': [
                'Loss and validation loss measure how well the model copies the recorded '
                'demonstrations. They do not measure grasping or placing on the real robot.',
                'Gradient norm is shown before clipping. GPU memory is the whole GPU, '
                'including other programs.']}

    # ---- comparison ------------------------------------------------------------------
    def compare(self, ids):
        ids = [i for i in ids if i][:6]
        if len(ids) < 2:
            raise ApiError('Choose at least two runs.')
        evals = self.evaluations.summary()
        out = []
        for rid in ids:
            try:
                r = self.runs.load(rid)
            except KeyError:
                raise ApiError('Run %s not found.' % rid, 404)
            m = self.runs.metrics(rid)
            train = [x for x in m.get('train', []) if x.get('loss') is not None]
            if len(train) > 400:
                k = len(train) / 400.0
                train = [train[int(i * k)] for i in range(400)] + [train[-1]]
            cfg = r.get('config') or {}
            started = r.get('started_at') or r.get('created_at')
            dur = None
            try:
                from datetime import datetime
                a = datetime.fromisoformat(started)
                b = datetime.fromisoformat(r['finished_at']) if r.get('finished_at') else \
                    datetime.now(a.tzinfo)
                dur = (b - a).total_seconds()
            except (TypeError, ValueError):
                pass
            try:
                ck = self.checkpoints(rid)['checkpoints']
            except KeyError:
                ck = []
            ev = [g for g in evals if g['run_id'] == rid]
            tail = [x['loss'] for x in train[-5:]]
            res = self.runs.resource_history(rid, max_points=3000)
            gpu_peak = max((x['gpu']['memory_used_mb'] for x in res
                            if x.get('gpu') and x['gpu'].get('memory_used_mb') is not None),
                           default=None)
            stm = diag.summarize(m.get('train', []), m.get('eval', []), [])
            ev_l = [x['eval_loss'] for x in m.get('eval', []) if x.get('eval_loss') is not None]
            out.append({
                'id': rid, 'job_name': r['job_name'], 'status': r['status'],
                'policy': (r.get('plan') or {}).get('policy'),
                'dataset': ((r.get('plan') or {}).get('dataset') or {}).get('id'),
                'episodes': cfg.get('episodes'), 'env': (r.get('env') or {}).get('name'),
                'lerobot': (r.get('env') or {}).get('lerobot'),
                'train': cfg.get('train') or {}, 'policy_params': cfg.get('policy_params') or {},
                'advanced': cfg.get('advanced') or {}, 'duration_s': dur,
                'steps_done': (r.get('progress') or {}).get('step'),
                'gpu_peak_mb': gpu_peak, 'step_time_s': stm['step_time_s'],
                'eval_best': min(ev_l) if ev_l else None, 'eval_last': ev_l[-1] if ev_l else None,
                'stability': stm['stability']['label'],
                'final_loss': sum(tail) / len(tail) if tail else None,
                'min_loss': min((x['loss'] for x in train), default=None),
                'loss': [{'x': x['step'], 'y': x['loss']} for x in train],
                'eval_loss': [{'x': x['step'], 'y': x['eval_loss']} for x in m.get('eval', [])],
                'checkpoints': [{'step': c['step'], 'path': c['path'], 'is_last': c['is_last'],
                                 'size_bytes': c['size_bytes']} for c in ck],
                'evaluations': ev})
        cands = [(g['rate'], g['n'], r['id'], g['step']) for r in out for g in r['evaluations']
                 if g['n'] >= 3]
        best = None
        if cands:
            rate, n, rid, step = max(cands)
            best = {'run_id': rid, 'step': step, 'basis': 'robot success rate %.0f%% over %d '
                    'trials' % (rate * 100, n)}
        elif all(r['eval_best'] is not None for r in out) and out:
            loss, rid = min((r['eval_best'], r['id']) for r in out)
            last = next(r for r in out if r['id'] == rid)['checkpoints']
            best = {'run_id': rid, 'step': last[-1]['step'] if last else None,
                    'basis': 'lowest held-out validation loss (%.4g). Validation loss measures '
                             'copying of held-out demonstrations, not grasp success - confirm '
                             'with robot trials in Evaluate.' % loss}
        else:
            fin = [(r['final_loss'], r['id']) for r in out if r['final_loss'] is not None and
                   r['checkpoints']]
            if fin:
                loss, rid = min(fin)
                last = next(r for r in out if r['id'] == rid)['checkpoints'][-1]['step']
                best = {'run_id': rid, 'step': last, 'basis': 'lowest final training loss '
                        '(no robot evaluations with 3+ trials yet - loss alone does not '
                        'predict grasp success)'}
        keys = sorted({k for r in out for k in list(r['train']) + list(r['policy_params'])})
        diff = []
        for k in keys:
            vals = [r['train'].get(k, r['policy_params'].get(k)) for r in out]
            diff.append({'key': k, 'values': vals, 'differs': len({str(v) for v in vals}) > 1})
        return {'runs': out, 'best': best, 'config_diff': diff}

    # ---- dataset health -------------------------------------------------------------
    def _health_key(self, path, video):
        ds = self.dataset(path)
        raw = '%s|%s|%s|%s' % (ds['path'], ds['modified'], ds['total_frames'], bool(video))
        h = hashlib.sha1(raw.encode()).hexdigest()[:16]
        return ds, h

    def health(self, path, env_name=None, video=True, start=False, refresh=False):
        ds, key = self._health_key(path, video)
        d = self.data_dir / 'health'
        d.mkdir(exist_ok=True)
        res = d / ('%s.json' % key)
        with self.health_lock:
            job = self.health_jobs.get(key)
            if res.exists() and not refresh and not (job and job['state'] == 'running'):
                return {'state': 'done', 'progress': 100, 'result': read_json(res),
                        'dataset': ds['id']}
            if job and (job['state'] == 'running' or not start):
                return {k: v for k, v in job.items() if k != 'proc'}
            if not start:
                return {'state': 'none', 'dataset': ds['id']}
            if not env_name:
                env_name = next((e['name'] for e in self.environments()
                                 if (e.get('packages') or {}).get('lerobot')), None)
            if not env_name:
                raise ApiError('No Python environment with LeRobot to run the analysis.')
            env = self.envs.get(env_name)
            py = os.path.join(env['prefix'], 'bin', 'python')
            argv = [py, '-I', str(HEALTH_PROBE), ds['path'], str(res)] + (
                [] if video else ['--no-video'])
            job = {'state': 'running', 'progress': 0, 'text': 'starting', 'dataset': ds['id'],
                   'env': env_name, 'started': now_iso(), 'video': bool(video)}
            self.health_jobs[key] = job
        threading.Thread(target=self._health_worker, args=(key, argv, env, res),
                         daemon=True).start()
        return dict(job)

    def _health_worker(self, key, argv, env, res):
        job = self.health_jobs[key]
        log = []
        try:
            p = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, env=self.envs.env_vars(env), cwd=str(self.data_dir),
                                 start_new_session=True)
            for line in p.stdout:
                line = line.rstrip()
                log.append(line)
                if line.startswith('PROGRESS '):
                    parts = line.split(' ', 2)
                    job['progress'] = int(parts[1])
                    job['text'] = parts[2] if len(parts) > 2 else ''
            code = p.wait(timeout=60)
            if code == 0 and res.exists():
                job.update(state='done', progress=100)
            else:
                err = next((x for x in reversed(log) if x.startswith('ERROR')), None)
                job.update(state='failed', error=(err or '\n'.join(log[-5:]))[:600])
        except (OSError, subprocess.SubprocessError) as e:
            job.update(state='failed', error=str(e))
        job['finished'] = now_iso()
        time.sleep(0)

    def keep_checkpoint(self, rid, step, keep=True):
        with self.runs.lock:
            run = self.runs.load(rid)
            ks = set(run.get('keep_steps') or [])
            try:
                step = int(step)
            except (TypeError, ValueError):
                raise ApiError('step must be a number.')
            (ks.add if keep else ks.discard)(step)
            run['keep_steps'] = sorted(ks)
            self.runs.save(run)
        return {'keep_steps': run['keep_steps']}

    # ---- host rollout ------------------------------------------------------------
    def rollout_prepare(self, req):
        """Build the worker configuration from the operator's request. Everything
        that decides what the robot does is derived here, never taken from the page."""
        errors, warnings = [], []
        rid = req.get('run_id')
        try:
            step = int(req.get('step'))
        except (TypeError, ValueError):
            raise ApiError('Choose a checkpoint.')
        run = self.runs.load(rid)
        ck = self._checkpoint(rid, step)
        if not ck:
            raise ApiError('Checkpoint %s of run %s not found.' % (step, rid), 404)
        tc = read_json(Path(ck['path']) / 'train_config.json') or {}
        ds_root = (tc.get('dataset') or {}).get('root')
        info = read_json(Path(ds_root or '/nonexistent') / 'meta' / 'info.json')
        if not info:
            raise ApiError('The training dataset (%s) is no longer readable; it is needed for '
                           'joint names and safety limits.' % ds_root)
        feats = info.get('features') or {}

        def names_of(key):
            n = (feats.get(key) or {}).get('names') or []
            return list(next(iter(n.values()))) if isinstance(n, dict) else list(n)
        action_names = names_of('action')
        state_names = names_of('observation.state') or action_names
        if not action_names:
            errors.append('The dataset does not name its action joints.')
        env_name = (run.get('env') or {}).get('name')
        try:
            env = self.envs.get(env_name)
        except KeyError:
            raise ApiError('Environment %s of this run no longer exists.' % env_name)
        # robot configuration (from physical_ai_server, sent by the page)
        rp = req.get('robot') or {}
        cams_cfg = {}
        for e in rp.get('camera_topic_list') or []:
            if ':' in e:
                k, t = e.split(':', 1)
                cams_cfg[k.strip()] = t.strip()
        joints_cfg = {}
        for e in rp.get('joint_topic_list') or []:
            if ':' in e:
                k, t = e.split(':', 1)
                joints_cfg[k.strip()] = t.strip()
        cams = {}
        for key in [k for k, v in feats.items() if (v or {}).get('dtype') == 'video']:
            name = key.split('.')[-1]
            if name in cams_cfg:
                cams[key] = cams_cfg[name]
            else:
                errors.append('No camera "%s" in the robot configuration (camera_topic_list).' %
                              name)
        state_topic = joints_cfg.get('follower')
        leader = next((k for k in joints_cfg if k.startswith('leader')), None)
        action_topic = joints_cfg.get(leader) if leader else None
        if not state_topic:
            errors.append('No follower joint topic in the robot configuration.')
        if not action_topic:
            errors.append('No leader (command) topic in the robot configuration.')
        order = (rp.get('joint_order') or {}).get(leader or 'leader')
        if order and list(order) != action_names:
            errors.append('Joint order mismatch: the model outputs %s, the robot configuration '
                          'commands %s.' % (', '.join(action_names), ', '.join(order)))
        if info.get('robot_type') and rp.get('robot_type') and \
                info['robot_type'] != rp['robot_type']:
            errors.append('The model was trained on robot type %s; the active robot is %s.' % (
                info['robot_type'], rp['robot_type']))
        # safety limits
        try:
            proposal = self.rollouts.limits_proposal(env, ds_root, refresh=bool(
                req.get('refresh_limits')))
        except (RuntimeError, subprocess.SubprocessError) as e:
            raise ApiError(str(e))
        ds_id = (tc.get('dataset') or {}).get('repo_id') or 'dataset'
        limits = req.get('limits') or self.rollouts.saved_limits(ds_id) or proposal
        lim_err = ro.validate_limits(limits, proposal)
        errors += lim_err
        try:
            speed = float(req.get('speed_factor', 0.3))
            max_dur = float(req.get('max_duration_s', 45))
        except (TypeError, ValueError):
            raise ApiError('Speed and duration must be numbers.')
        if not 0.05 <= speed <= 1.0:
            errors.append('Speed must be between 5% and 100% of the demonstrated speed.')
        if not 5 <= max_dur <= 600:
            errors.append('Maximum duration must be 5-600 s.')
        device = req.get('device') or ('cuda' if self.envs.probe(env_name).get('cuda_available')
                                       else 'cpu')
        busy = self.runs.active()
        if busy and device == 'cuda':
            errors.append('Training run %s is using the GPU; wait for it or stop it.' %
                          busy['job_name'])
        host = req.get('rosbridge_host') or '127.0.0.1'
        if host not in ('127.0.0.1', 'localhost'):
            warnings.append('rosbridge is on %s (not this PC).' % host)
        cfg = {
            'checkpoint': ck['path'], 'cameras': cams, 'state_topic': state_topic,
            'state_names': state_names, 'action_topic': action_topic,
            'action_names': action_names, 'fps': info.get('fps') or 30,
            'task': (req.get('task') or '').strip()[:300], 'rename_map': tc.get('rename_map')
            or {}, 'limits': {'joints': limits['joints']}, 'speed_factor': speed,
            'max_duration_s': max_dur, 'device': device,
            'rosbridge_url': 'ws://%s:9090' % host,
            'allow_unverified_publishers': bool(req.get('allow_unverified_publishers')),
            'robot_type': info.get('robot_type'),
            'policy': ck.get('policy_type'), 'run_id': rid, 'step': step,
            'dataset_id': ds_id, 'env': env_name,
        }
        if (tc.get('policy') or {}).get('type') == 'smolvla' and not cfg['task']:
            errors.append('SmolVLA needs the task instruction.')
        return {'ok': not errors, 'errors': errors, 'warnings': warnings, 'config': cfg,
                'token': ro.token_for(cfg), 'proposal': proposal,
                'limits_source': _limits_source(limits, proposal,
                                                self.rollouts.saved_limits(ds_id)),
                'busy': self.rollouts.active()}

    def rollout_start(self, req, token):
        prep = self.rollout_prepare(req)
        if not prep['ok']:
            raise ApiError(' '.join(prep['errors']))
        if token != prep['token']:
            raise ApiError('The rollout configuration changed since you reviewed it; review it '
                           'again.', 409)
        env = self.envs.get(prep['config']['env'])
        try:
            return self.rollouts.start(prep['config'], env, token)
        except (RuntimeError, ValueError) as e:
            raise ApiError(str(e), 409)


def _limits_source(limits, proposal, saved):
    keys = ('name', 'min', 'max', 'max_step', 'max_lead')

    def norm(lim):
        return [tuple(round(float(j.get(k)), 4) if k != 'name' else j.get(k) for k in keys)
                for j in (lim or {}).get('joints', [])]
    try:
        if norm(limits) == norm(proposal):
            return 'training data'
        if saved and norm(limits) == norm(saved):
            return 'saved defaults'
    except (TypeError, ValueError):
        pass
    return 'edited'
