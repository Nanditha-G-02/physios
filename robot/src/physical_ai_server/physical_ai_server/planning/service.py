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

"""ROS-independent command handlers for Planning, plan-mode Record and Data.

``PlanningService.handle(command, payload)`` returns a JSON-serialisable dict
or raises ``CommandError`` with a message meant for the operator.  The ROS
glue in ``ros_bridge.py`` only converts the service request/response.
"""

import copy
import json
import math
from pathlib import Path
import threading
import traceback
import uuid

from physical_ai_server.planning import datasets as dsio
from physical_ai_server.planning import engine, phases
from physical_ai_server.planning import github_publisher as gh
from physical_ai_server.planning import profiles
from physical_ai_server.planning import validation
from physical_ai_server.planning.store import now_iso, Store

REVIEW_STATUSES = ['accepted', 'rejected', 'needs_review']
FAILURE_CATEGORIES = [
    'missed_grasp', 'dropped_object', 'wrong_target', 'collision', 'incomplete_task',
    'operator_error', 'camera_issue', 'robot_fault', 'timing', 'setup_mismatch', 'other',
]
EPISODE_STATES = ['pending', 'recording', 'recorded', 'validated', 'failed', 'skipped']


class CommandError(Exception):
    pass


def _slug(text):
    import re
    s = re.sub(r'[^A-Za-z0-9_.-]+', '_', (text or '').strip()).strip('_.-')
    return s[:80] or 'task'


class PlanningService:

    def __init__(self, store=None, dataset_root=None, context=None, logger=None):
        self.store = store or Store()
        self.dataset_root = Path(dataset_root) if dataset_root else dsio.default_dataset_root()
        self.ctx = context or {}
        self.log = logger or (lambda *a: None)
        self._jobs = {}
        self._jobs_lock = threading.Lock()
        self._recover_interrupted()

    # ---------------------------------------------------------- plumbing --
    def _ctx(self, name, default=None):
        fn = self.ctx.get(name)
        return fn() if callable(fn) else default

    def handle(self, command, payload):
        name = 'cmd_' + command.replace('.', '_')
        fn = getattr(self, name, None)
        if fn is None:
            raise CommandError('Unknown command "%s"' % command)
        return fn(**(payload or {}))

    def handle_json(self, command, payload_json):
        """(success, message, result_json) - never raises."""
        try:
            payload = json.loads(payload_json) if payload_json else {}
            if not isinstance(payload, dict):
                raise CommandError('Payload must be a JSON object.')
            result = self.handle(command, payload)
            return True, 'ok', json.dumps(result, ensure_ascii=False, default=str)
        except (CommandError, validation.engine.PlanError, dsio.DatasetError,
                gh.GitHubError, KeyError, ValueError, TypeError) as e:
            msg = e.args[0] if getattr(e, 'args', None) else str(e)
            return False, str(msg), '{}'
        except Exception as e:  # pragma: no cover - logged for the operator
            self.log('planning command %s failed: %s\n%s' % (
                command, e, traceback.format_exc()))
            return False, 'Internal error: %s' % e, '{}'

    # ------------------------------------------------------------- jobs ---
    def _start_job(self, kind, fn):
        job_id = uuid.uuid4().hex[:10]
        job = {'id': job_id, 'kind': kind, 'status': 'running', 'progress': 0,
               'total': 0, 'message': 'Starting...', 'result': None,
               'started_at': now_iso()}
        with self._jobs_lock:
            self._jobs[job_id] = job

        def progress(cur, total, message=''):
            job.update(progress=cur, total=total, message=message)

        def run():
            try:
                job['result'] = fn(progress)
                job['status'] = 'done'
                job['message'] = job.get('message') or 'Done'
            except Exception as e:  # noqa: BLE001 - reported to the operator
                job['status'] = 'failed'
                job['message'] = str(e)
                self.log('job %s failed: %s' % (kind, traceback.format_exc()))
            job['finished_at'] = now_iso()

        threading.Thread(target=run, daemon=True, name='pam-%s' % kind).start()
        return job

    def cmd_job_status(self, job_id):
        job = self._jobs.get(job_id)
        if not job:
            raise CommandError('Unknown job %s' % job_id)
        return dict(job)

    # ------------------------------------------------------------ robot ---
    def cmd_robot_profile(self, robot_type=None):
        rt = robot_type or self._ctx('get_robot_type', '') or ''
        prof = profiles.profile_for_robot(rt)
        ws = profiles.default_workspace(rt)
        return {'robot_type': rt, 'profile': prof, 'workspace': ws,
                'regions': profiles.default_regions(ws),
                'params': self._ctx('robot_params', {}) or {}}

    def cmd_meta(self):
        return {'strategy_types': engine.STRATEGY_TYPES,
                'strategy_info': engine.STRATEGY_INFO,
                'action_types': engine.ACTION_TYPES,
                'perturbations': list(engine.PERTURBATIONS),
                'scenario_kinds': engine.SCENARIO_KINDS,
                'review_statuses': REVIEW_STATUSES,
                'failure_categories': FAILURE_CATEGORIES,
                'data_root': str(self.store.root),
                'dataset_root': str(self.dataset_root)}

    # ------------------------------------------------------------ plans ---
    def _new_task(self, robot_type, user_id, name=''):
        ws = profiles.default_workspace(robot_type)
        prof = profiles.profile_for_robot(robot_type)
        return {
            'name': _slug(name) if name else '',
            'description': '',
            'instruction': '',
            'robot_type': robot_type or '',
            'user_id': user_id or '',
            'items': [
                {'id': 'obj1', 'name': 'Object', 'role': 'object', 'size_mm': 30,
                 'color': '#D9534F', 'track_color': '#D9534F'},
                {'id': 'tgt1', 'name': 'Target', 'role': 'target', 'size_mm': 90,
                 'color': '#8A6D3B', 'track_color': '#8A6D3B'},
            ],
            'workspace': ws,
            'regions': profiles.default_regions(ws),
            'episode_count': 30,
            'demo_types': ['standard'],
            'recording': {'fps': prof['default_fps'], 'warmup_s': 3, 'episode_s': 20,
                          'reset_s': 0, 'use_optimized_save': True},
        }

    def _plan_or_404(self, plan_id):
        try:
            return self.store.load_plan(plan_id)
        except KeyError:
            raise CommandError('Plan %s not found.' % plan_id)

    def _summary_row(self, plan):
        prog = self.store.load_progress(plan['id']) or {}
        counts = _progress_counts(prog, None)
        return {'id': plan['id'], 'name': plan['task'].get('name'),
                'instruction': plan['task'].get('instruction'),
                'status': plan.get('status'), 'version': plan.get('version'),
                'approved_version': plan.get('approved_version'),
                'robot_type': plan['task'].get('robot_type'),
                'strategy': plan['strategy'].get('type'),
                'episodes': len(plan.get('episodes', [])),
                'progress': counts, 'updated_at': plan.get('updated_at'),
                'dataset_id': self._dataset_id(plan)}

    def _dataset_id(self, plan):
        t = plan['task']
        if not t.get('user_id') or not t.get('name'):
            return None
        return '%s/%s_%s' % (t['user_id'], t.get('robot_type', ''), t['name'])

    def cmd_plan_list(self, include_archived=False):
        rows = []
        for pid in self.store.list_plan_ids():
            try:
                plan = self.store.load_plan(pid)
            except (KeyError, ValueError):
                continue
            if plan.get('status') == 'archived' and not include_archived:
                continue
            rows.append(self._summary_row(plan))
        rows.sort(key=lambda r: r.get('updated_at') or '', reverse=True)
        state = self.store.state()
        return {'plans': rows, 'active_plan_id': state.get('active_plan_id')}

    def cmd_plan_new(self, robot_type=None, user_id='', name='', strategy_type='static'):
        rt = robot_type or self._ctx('get_robot_type', '') or ''
        task = self._new_task(rt, user_id, name)
        plan = {
            'id': self.store.new_plan_id(), 'version': 1, 'status': 'draft',
            'approved_version': None, 'created_at': now_iso(),
            'task': task,
            'strategy': {'type': strategy_type, 'seed': 7,
                         'params': engine.default_params(strategy_type, task)},
            'episodes': [], 'validation': None, 'allow_skip': True,
        }
        self.store.save_plan(plan)
        self.store.log_event(plan['id'], 'created', robot_type=rt)
        return self._full(plan)

    def cmd_plan_get(self, plan_id, version=None):
        plan = (self.store.load_version(plan_id, version) if version
                else self._plan_or_404(plan_id))
        return self._full(plan)

    def _full(self, plan):
        prog = self.store.load_progress(plan['id'])
        return {'plan': plan, 'summary': engine.summarize(plan),
                'versions': self.store.list_versions(plan['id']),
                'progress': prog, 'events': self.store.events(plan['id'], 30),
                'dataset_id': self._dataset_id(plan)}

    def _editable(self, plan):
        """Approved plans are immutable: editing starts a new draft version."""
        if plan.get('status') == 'archived':
            raise CommandError('Plan is archived. Duplicate it to edit.')
        if plan.get('status') == 'approved':
            plan['version'] = int(plan['version']) + 1
            plan['status'] = 'draft'
            self.store.log_event(plan['id'], 'new_draft_version', version=plan['version'])
        elif plan.get('status') == 'validated':
            plan['status'] = 'draft'
        plan['validation'] = None
        return plan

    def cmd_plan_save(self, plan, regenerate=False):
        if not isinstance(plan, dict) or 'id' not in plan:
            raise CommandError('Malformed plan.')
        current = self._plan_or_404(plan['id'])
        merged = copy.deepcopy(current)
        merged['task'] = plan.get('task', current['task'])
        merged['strategy'] = plan.get('strategy', current['strategy'])
        merged['allow_skip'] = bool(plan.get('allow_skip', current.get('allow_skip', True)))
        if 'episodes' in plan:
            merged['episodes'] = plan['episodes']
        if merged['task'].get('name'):
            merged['task']['name'] = merged['task']['name'].strip()
        if json.dumps(merged, sort_keys=True) == json.dumps(current, sort_keys=True) and \
                not regenerate:
            return self._full(current)
        self._editable(merged)
        if regenerate:
            merged['episodes'] = engine.generate(merged, keep_edited=False)
        self.store.save_plan(merged)
        return self._full(merged)

    def cmd_plan_defaults(self, strategy_type, task):
        return {'params': engine.default_params(strategy_type, task)}

    def cmd_plan_generate(self, plan_id, keep_edited=False):
        plan = self._editable(self._plan_or_404(plan_id))
        plan['episodes'] = engine.generate(plan, keep_edited=keep_edited)
        plan['validation'] = validation.validate(plan)
        self.store.save_plan(plan)
        self.store.log_event(plan_id, 'generated', strategy=plan['strategy']['type'],
                             episodes=len(plan['episodes']), keep_edited=keep_edited)
        return self._full(plan)

    def cmd_plan_validate(self, plan_id):
        plan = self._plan_or_404(plan_id)
        result = validation.validate(plan)
        plan['validation'] = dict(result, ran_at=now_iso())
        if plan['status'] == 'draft' and result['ok']:
            plan['status'] = 'validated'
        self.store.save_plan(plan)
        return self._full(plan)

    def cmd_plan_apply_fix(self, plan_id, fix):
        plan = self._editable(self._plan_or_404(plan_id))
        plan = validation.apply_fix(plan, fix)
        plan['validation'] = dict(validation.validate(plan), ran_at=now_iso())
        self.store.save_plan(plan)
        self.store.log_event(plan_id, 'fix_applied', op=fix.get('op'))
        return self._full(plan)

    def _ep_index(self, plan, episode_id):
        for k, e in enumerate(plan['episodes']):
            if e['id'] == episode_id:
                return k
        raise CommandError('Episode %s not found.' % episode_id)

    def cmd_plan_update_episode(self, plan_id, episode_id, patch):
        plan = self._editable(self._plan_or_404(plan_id))
        k = self._ep_index(plan, episode_id)
        ep = plan['episodes'][k]
        allowed = {'instruction', 'placements', 'sequence', 'scenario', 'demo_type',
                   'operator_notes'}
        for key, value in (patch or {}).items():
            if key not in allowed:
                raise CommandError('Field "%s" cannot be edited.' % key)
            ep[key] = value
        if 'placements' in patch:
            from physical_ai_server.planning import geometry as geo
            for p in ep['placements']:
                p['region'] = geo.region_of(p['x_mm'], p['y_mm'], plan['task'].get('regions'))
        ep['edited'] = True
        plan['validation'] = dict(validation.validate(plan), ran_at=now_iso())
        self.store.save_plan(plan)
        return self._full(plan)

    def cmd_plan_add_episode(self, plan_id, copy_from=None):
        plan = self._editable(self._plan_or_404(plan_id))
        if not plan['episodes']:
            raise CommandError('Generate the plan first.')
        src = plan['episodes'][self._ep_index(plan, copy_from)] if copy_from \
            else plan['episodes'][-1]
        used = {e['id'] for e in plan['episodes']}
        n = len(plan['episodes']) + 1
        while 'E%03d' % n in used:
            n += 1
        ep = copy.deepcopy(src)
        ep.update(id='E%03d' % n, edited=True, index=len(plan['episodes']),
                  order=max(e['order'] for e in plan['episodes']) + 1)
        plan['episodes'].append(ep)
        plan['task']['episode_count'] = len(plan['episodes'])
        plan['validation'] = dict(validation.validate(plan), ran_at=now_iso())
        self.store.save_plan(plan)
        return self._full(plan)

    def cmd_plan_remove_episode(self, plan_id, episode_id):
        plan = self._editable(self._plan_or_404(plan_id))
        prog = self.store.load_progress(plan_id) or {}
        st = (prog.get('episodes') or {}).get(episode_id, {}).get('status')
        if st in ('recorded', 'validated'):
            raise CommandError('Episode %s is already recorded; reject or delete it in Data '
                               'instead of removing it from the plan.' % episode_id)
        plan['episodes'].pop(self._ep_index(plan, episode_id))
        for k, e in enumerate(sorted(plan['episodes'], key=lambda e: e['order'])):
            e['order'] = k + 1
        plan['task']['episode_count'] = len(plan['episodes'])
        plan['validation'] = dict(validation.validate(plan), ran_at=now_iso())
        self.store.save_plan(plan)
        return self._full(plan)

    def cmd_plan_reorder(self, plan_id, order):
        plan = self._editable(self._plan_or_404(plan_id))
        ids = [e['id'] for e in plan['episodes']]
        if sorted(order) != sorted(ids):
            raise CommandError('Order must list every episode exactly once.')
        pos = {eid: k + 1 for k, eid in enumerate(order)}
        for e in plan['episodes']:
            e['order'] = pos[e['id']]
        plan['episodes'].sort(key=lambda e: e['order'])
        self.store.save_plan(plan)
        return self._full(plan)

    def cmd_plan_approve(self, plan_id):
        plan = self._plan_or_404(plan_id)
        if plan.get('status') == 'approved':
            return self._full(plan)
        result = validation.validate(plan)
        plan['validation'] = dict(result, ran_at=now_iso())
        if not result['ok']:
            self.store.save_plan(plan)
            raise CommandError('Plan has %d validation error(s); fix them before approving.'
                               % result['errors'])
        plan['status'] = 'approved'
        plan['approved_version'] = plan['version']
        plan['approved_at'] = now_iso()
        self.store.save_version(plan)
        self.store.save_plan(plan)
        prog = self.store.load_progress(plan_id) or {'plan_id': plan_id, 'episodes': {},
                                                     'active': None}
        prog['version'] = plan['version']
        prog['dataset_id'] = self._dataset_id(plan)
        for e in plan['episodes']:
            prog['episodes'].setdefault(e['id'], {'status': 'pending', 'attempts': []})
        self.store.save_progress(plan_id, prog)
        self.store.set_state(active_plan_id=plan_id)
        self.store.log_event(plan_id, 'approved', version=plan['version'],
                             warnings=result['warnings'])
        return self._full(plan)

    def cmd_plan_duplicate(self, plan_id):
        src = self._plan_or_404(plan_id)
        plan = copy.deepcopy(src)
        plan.update(id=self.store.new_plan_id(), version=1, status='draft',
                    approved_version=None, created_at=now_iso(), validation=None)
        plan['task']['name'] = _slug((plan['task'].get('name') or 'task') + '_copy')
        for e in plan['episodes']:
            e['edited'] = e.get('edited', False)
        self.store.save_plan(plan)
        self.store.log_event(plan['id'], 'duplicated', source=plan_id)
        return self._full(plan)

    def cmd_plan_targeted(self, source_plan_id, points, episodes=10, spread_mm=25.0,
                          object_item_id=None, name='', instruction=None, notes='',
                          seed=None, origin=None):
        """New draft plan that re-collects demonstrations where the policy failed.

        ``points`` are object positions (x_mm, y_mm, optional weight) chosen by the
        operator, usually from evaluation failures. Everything else (task, targets,
        workspace, recording settings) is copied from the source plan. The result is
        a normal draft: validate and approve it in Planning before recording."""
        import random
        from physical_ai_server.planning import geometry as geo
        src = self._plan_or_404(source_plan_id)
        task = copy.deepcopy(src['task'])
        objects = [i for i in task.get('items', []) if i.get('role') == 'object']
        if not objects:
            raise CommandError('The source plan has no object item.')
        obj = next((i for i in objects if i['id'] == object_item_id), objects[0])
        pts = []
        for p in points or []:
            try:
                pts.append((float(p['x_mm']), float(p['y_mm']),
                            max(1, int(p.get('weight') or 1))))
            except (KeyError, TypeError, ValueError):
                raise CommandError('Each point needs x_mm and y_mm.')
        if not pts:
            raise CommandError('Choose at least one position.')
        try:
            n = int(episodes)
            spread = float(spread_mm)
        except (TypeError, ValueError):
            raise CommandError('Episodes and spread must be numbers.')
        if not 1 <= n <= engine.MAX_EPISODES:
            raise CommandError('Episodes must be between 1 and %d.' % engine.MAX_EPISODES)
        if not 0 <= spread <= 200:
            raise CommandError('Spread must be between 0 and 200 mm.')
        ws = task['workspace']
        radius = engine._item_radius(obj)
        rng = random.Random(seed if seed is not None else len(pts) * 7919 + n)
        bag = [p for p in pts for _ in range(p[2])]
        chosen = []
        for i in range(n):
            x, y, _ = bag[i % len(bag)]
            for _ in range(30):
                r = spread * (rng.random() ** 0.5)
                a = rng.random() * 6.283185307
                cx, cy = x + r * math.cos(a), y + r * math.sin(a)
                if not geo.point_problems(cx, cy, ws, radius):
                    break
            else:
                cx, cy = geo.nearest_valid_point(x, y, ws, radius)
            chosen.append({'x_mm': round(cx, 1), 'y_mm': round(cy, 1)})
        stype = 'semi_dynamic'
        params = copy.deepcopy(src['strategy'].get('params') or {}) \
            if src['strategy'].get('type') == stype else engine.default_params(stype, src['task'])
        params.setdefault('items', {})
        spec = copy.deepcopy(params['items'].get(obj['id']) or {})
        spec.update(mode='points', points=chosen)
        params['items'][obj['id']] = spec
        task['episode_count'] = n
        task['name'] = _slug(name or ((task.get('name') or 'task') + '_targeted'))
        if instruction:
            task['instruction'] = str(instruction)[:500]
        plan = {
            'id': self.store.new_plan_id(), 'version': 1, 'status': 'draft',
            'approved_version': None, 'created_at': now_iso(), 'task': task,
            'strategy': {'type': stype, 'seed': src['strategy'].get('seed', 7),
                         'params': params},
            'episodes': [], 'validation': None, 'allow_skip': src.get('allow_skip', True),
            'origin': {'kind': 'targeted', 'source_plan_id': source_plan_id,
                       'points': [{'x_mm': p[0], 'y_mm': p[1], 'weight': p[2]} for p in pts],
                       'spread_mm': spread, 'object_item_id': obj['id'],
                       'evaluation': origin or None, 'created_at': now_iso()},
        }
        try:
            plan['episodes'] = engine.generate(plan)
        except engine.PlanError as e:
            raise CommandError(str(e))
        if notes:
            for e in plan['episodes']:
                e['operator_notes'] = str(notes)[:500]
        plan['validation'] = dict(validation.validate(plan), ran_at=now_iso())
        self.store.save_plan(plan)
        self.store.log_event(plan['id'], 'created_targeted', source=source_plan_id,
                             points=len(pts), episodes=n)
        return self._full(plan)

    def cmd_plan_archive(self, plan_id):
        plan = self.store.archive_plan(plan_id)
        if self.store.state().get('active_plan_id') == plan_id:
            self.store.set_state(active_plan_id=None)
        return self._summary_row(plan)

    def cmd_plan_delete(self, plan_id):
        prog = self.store.load_progress(plan_id) or {}
        if any(e.get('attempts') for e in (prog.get('episodes') or {}).values()):
            raise CommandError('This plan has recordings; archive it instead of deleting.')
        self.store.delete_plan(plan_id)
        if self.store.state().get('active_plan_id') == plan_id:
            self.store.set_state(active_plan_id=None)
        return {'deleted': plan_id}

    def cmd_plan_set_active(self, plan_id):
        plan = self._plan_or_404(plan_id)
        if not plan.get('approved_version'):
            raise CommandError('Only approved plans can be used for recording.')
        self.store.set_state(active_plan_id=plan_id)
        return {'active_plan_id': plan_id}

    # ------------------------------------------------- plan-mode recording --
    def _approved(self, plan_id):
        plan = self._plan_or_404(plan_id)
        if not plan.get('approved_version'):
            raise CommandError('Plan %s has no approved version.' % plan_id)
        return self.store.load_version(plan_id, plan['approved_version']), plan

    def _progress(self, plan_id, approved):
        prog = self.store.load_progress(plan_id) or {'plan_id': plan_id, 'episodes': {},
                                                     'active': None}
        changed = False
        for e in approved['episodes']:
            if e['id'] not in prog['episodes']:
                prog['episodes'][e['id']] = {'status': 'pending', 'attempts': []}
                changed = True
        prog['version'] = approved['version']
        prog['dataset_id'] = self._dataset_id(approved)
        if changed:
            self.store.save_progress(plan_id, prog)
        return prog

    def cmd_record_state(self, plan_id=None):
        plan_id = plan_id or self.store.state().get('active_plan_id')
        if not plan_id:
            return {'plan': None}
        try:
            approved, working = self._approved(plan_id)
        except CommandError as e:
            return {'plan': None, 'message': str(e)}
        prog = self._progress(plan_id, approved)
        ds_id = self._dataset_id(approved)
        ds_path = self.dataset_root / ds_id
        integrity, missing = dsio.folder_integrity(ds_path)
        info = dsio.read_info(ds_path) if integrity == 'complete' else None
        order = sorted(approved['episodes'], key=lambda e: e['order'])
        nxt = next((e['id'] for e in order
                    if prog['episodes'][e['id']]['status'] in ('pending', 'failed')), None)
        return {
            'plan': approved,
            'working_status': working.get('status'),
            'working_version': working.get('version'),
            'progress': prog,
            'counts': _progress_counts(prog, approved),
            'next_episode_id': nxt,
            'dataset': {'id': ds_id, 'path': str(ds_path), 'integrity': integrity,
                        'missing': missing,
                        'codebase_version': (info or {}).get('codebase_version'),
                        'total_episodes': (info or {}).get('total_episodes', 0)},
            'robot_type': self._ctx('get_robot_type', ''),
        }

    def _task_info_for(self, approved, ep):
        t = approved['task']
        rec = t.get('recording') or {}
        return {
            'task_name': t['name'],
            'task_type': 'record',
            'user_id': t['user_id'],
            'task_instruction': [ep['instruction']],
            'policy_path': '',
            'record_inference_mode': False,
            'fps': int(rec.get('fps') or 30),
            'tags': [t.get('robot_type', ''), 'physical-ai-manager',
                     'plan-' + approved['strategy']['type']],
            'warmup_time_s': int(rec.get('warmup_s') or 0),
            'episode_time_s': int(rec.get('episode_s') or 20),
            'reset_time_s': int(rec.get('reset_s') or 0),
            'num_episodes': 1,
            'push_to_hub': False,
            'private_mode': True,
            'use_optimized_save_mode': bool(rec.get('use_optimized_save', True)),
            'record_rosbag2': False,
        }

    def cmd_record_begin(self, plan_id, episode_id, retake=False):
        with self.store.lock:
            approved, _ = self._approved(plan_id)
            prog = self._progress(plan_id, approved)
            if prog.get('active'):
                a = prog['active']
                raise CommandError('Episode %s is already being recorded. Finish or stop it '
                                   'first.' % a['episode_id'])
            if self._ctx('is_recording', False):
                raise CommandError('The server is already recording or running inference.')
            rt = self._ctx('get_robot_type', None)
            if rt is not None and rt != approved['task']['robot_type']:
                raise CommandError('Plan is for robot type "%s" but the server is set to "%s". '
                                   'Select the right robot on Home.' % (
                                       approved['task']['robot_type'], rt or 'none'))
            ep = next((e for e in approved['episodes'] if e['id'] == episode_id), None)
            if ep is None:
                raise CommandError('Episode %s is not in the approved plan.' % episode_id)
            st = prog['episodes'][episode_id]['status']
            if st == 'skipped':
                raise CommandError('Episode %s was skipped. Restore it first.' % episode_id)
            if st in ('recorded', 'validated') and not retake:
                raise CommandError('Episode %s is already recorded. Use "Retake" to record it '
                                   'again (the earlier take stays in the dataset until you '
                                   'reject/delete it in Data).' % episode_id)
            ds_id = self._dataset_id(approved)
            ds_path = self.dataset_root / ds_id
            integrity, missing = dsio.folder_integrity(ds_path)
            if integrity == 'incomplete':
                raise CommandError(
                    'Dataset folder %s exists but is incomplete (missing %s). The recorder '
                    'would delete and recreate it. Move it aside or repair it first.' % (
                        ds_path, ', '.join(missing)))
            base = 0
            if integrity == 'complete':
                info = dsio.read_info(ds_path)
                if not str(info.get('codebase_version', '')).startswith('v2'):
                    raise CommandError('Dataset %s is %s; the recorder appends only to LeRobot '
                                       'v2.1 datasets.' % (ds_id, info.get('codebase_version')))
                base = int(info.get('total_episodes') or 0)
            task_info = self._task_info_for(approved, ep)
            prog['active'] = {'episode_id': episode_id, 'started_at': now_iso(),
                              'base_total_episodes': base, 'task_info': task_info,
                              'plan_version': approved['version'], 'confirmed': False,
                              'saved_index': None}
            prog['episodes'][episode_id]['status'] = 'recording'
            self.store.save_progress(plan_id, prog)
            self.store.set_state(active_plan_id=plan_id, recording_plan_id=plan_id)
            self.store.log_event(plan_id, 'record_begin', episode_id=episode_id,
                                 retake=bool(retake))
            return {'task_info': task_info, 'episode': ep, 'dataset_id': ds_id}

    def cmd_record_cancel(self, plan_id, reason='cancelled'):
        with self.store.lock:
            prog = self.store.load_progress(plan_id) or {}
            a = prog.get('active')
            if not a:
                return {'cancelled': False}
            self._close_attempt(plan_id, prog, result=reason)
            return {'cancelled': True}

    def cmd_record_skip(self, plan_id, episode_id, reason=''):
        approved, working = self._approved(plan_id)
        if not working.get('allow_skip', True):
            raise CommandError('Skipping is disabled for this plan.')
        if not (reason or '').strip():
            raise CommandError('Give a reason for skipping - it is stored in the collection '
                               'metadata.')
        prog = self._progress(plan_id, approved)
        if prog.get('active') and prog['active']['episode_id'] == episode_id:
            raise CommandError('Episode is being recorded.')
        e = prog['episodes'][episode_id]
        if e['status'] in ('recorded', 'validated'):
            raise CommandError('Episode already recorded.')
        e.update(status='skipped', skipped_reason=reason.strip(), updated_at=now_iso())
        self.store.save_progress(plan_id, prog)
        self.store.log_event(plan_id, 'skipped', episode_id=episode_id, reason=reason)
        return self.cmd_record_state(plan_id)

    def cmd_record_restore(self, plan_id, episode_id):
        approved, _ = self._approved(plan_id)
        prog = self._progress(plan_id, approved)
        e = prog['episodes'][episode_id]
        if e['status'] == 'skipped':
            e['status'] = 'pending'
            e.pop('skipped_reason', None)
            self.store.save_progress(plan_id, prog)
            self.store.log_event(plan_id, 'restored', episode_id=episode_id)
        return self.cmd_record_state(plan_id)

    # hooks called from the ROS node ------------------------------------------
    def check_start(self, task_info):
        """Called on START_RECORD. Returns (allowed, message)."""
        state = self.store.state()
        plan_id = state.get('recording_plan_id')
        prog = self.store.load_progress(plan_id) if plan_id else None
        a = (prog or {}).get('active')
        if not a:
            return True, ''
        exp = a['task_info']
        got_instr = [x for x in (task_info.get('task_instruction') or []) if x.strip()]
        mismatch = []
        for key in ('task_name', 'user_id', 'num_episodes', 'push_to_hub', 'fps'):
            if task_info.get(key) != exp.get(key):
                mismatch.append(key)
        if got_instr != exp['task_instruction']:
            mismatch.append('task_instruction')
        if mismatch:
            return False, ('Recording request does not match approved plan episode %s (%s). '
                           'Reload the plan in Record.' % (a['episode_id'], ', '.join(mismatch)))
        a['confirmed'] = True
        a['confirmed_at'] = now_iso()
        self.store.save_progress(plan_id, prog)
        return True, 'Plan episode %s' % a['episode_id']

    def on_episode_saved(self, dataset_path=None):
        """Called when the recorder finished writing one episode."""
        state = self.store.state()
        plan_id = state.get('recording_plan_id')
        self._note_recent_save(dataset_path, plan_id)
        if not plan_id:
            return None
        with self.store.lock:
            prog = self.store.load_progress(plan_id) or {}
            a = prog.get('active')
            if not a or not a.get('confirmed'):
                return None
            ds_id = prog.get('dataset_id')
            path = Path(dataset_path) if dataset_path else self.dataset_root / ds_id
            info = dsio.read_info(path) or {}
            index = int(info.get('total_episodes') or 0) - 1
            if index < a['base_total_episodes']:
                return None
            a['saved_index'] = index
            self.store.save_progress(plan_id, prog)
        threading.Thread(target=self._validate_saved, args=(plan_id, ds_id, index),
                         daemon=True).start()
        return index

    def _validate_saved(self, plan_id, ds_id, index):
        try:
            ds = dsio.Dataset(self.dataset_root, ds_id)
            approved = self.store.load_version(plan_id, self.store.load_progress(plan_id)
                                               ['version'])
            min_s = min(1.0, float(approved['task']['recording'].get('episode_s', 1)) / 4)
            check = ds.check_episode(index, min_duration_s=min_s)
        except Exception as e:  # noqa: BLE001
            check = {'ok': False, 'problems': ['Could not validate: %s' % e], 'warnings': []}
        with self.store.lock:
            prog = self.store.load_progress(plan_id)
            a = prog.get('active')
            if a and a.get('saved_index') == index:
                self._close_attempt(plan_id, prog, result='saved', index=index, check=check)
            else:
                # recording already finished - attach to the matching attempt
                for e in prog['episodes'].values():
                    for att in e.get('attempts', []):
                        if att.get('dataset_episode_index') == index and \
                                att.get('validation') is None:
                            att['validation'] = check
                            e['status'] = 'validated' if check['ok'] else 'failed'
                            e['validation'] = check
                self.store.save_progress(plan_id, prog)

    def on_recording_finished(self):
        state = self.store.state()
        plan_id = state.get('recording_plan_id')
        if not plan_id:
            return
        with self.store.lock:
            prog = self.store.load_progress(plan_id) or {}
            a = prog.get('active')
            if a and a.get('saved_index') is None:
                self._close_attempt(plan_id, prog, result='not_saved')
            elif a:
                # validation thread will close it; mark recorded meanwhile
                pass

    def _close_attempt(self, plan_id, prog, result, index=None, check=None):
        a = prog.get('active') or {}
        eid = a.get('episode_id')
        if not eid:
            return
        e = prog['episodes'].setdefault(eid, {'status': 'pending', 'attempts': []})
        attempt = {'started_at': a.get('started_at'), 'ended_at': now_iso(),
                   'result': result, 'plan_version': a.get('plan_version'),
                   'dataset_episode_index': index, 'validation': check}
        e.setdefault('attempts', []).append(attempt)
        if result == 'saved':
            e['dataset_episode_index'] = index
            e['validation'] = check
            e['status'] = 'validated' if check and check.get('ok') else 'failed'
            if check:
                e['frames'] = check.get('frames')
                e['duration_s'] = check.get('duration_s')
        else:
            prev = [x for x in e['attempts'] if x['result'] == 'saved']
            e['status'] = ('validated' if prev and (prev[-1].get('validation') or {}).get('ok')
                           else 'pending')
        e['updated_at'] = now_iso()
        prog['active'] = None
        self.store.save_progress(plan_id, prog)
        self.store.set_state(recording_plan_id=None)
        self.store.log_event(plan_id, 'record_end', episode_id=eid, result=result,
                             dataset_episode_index=index,
                             ok=(check or {}).get('ok'))

    def _recover_interrupted(self):
        """After a restart, never resume a take automatically."""
        try:
            plan_id = self.store.state().get('recording_plan_id')
            if not plan_id:
                return
            prog = self.store.load_progress(plan_id) or {}
            if prog.get('active'):
                self._close_attempt(plan_id, prog, result='interrupted')
            self.store.set_state(recording_plan_id=None)
        except Exception:  # noqa: BLE001
            pass

    # ------------------------------------------------------------- data ---
    def cmd_data_list_datasets(self):
        rows = dsio.list_datasets(self.dataset_root)
        plans = {}
        for pid in self.store.list_plan_ids():
            try:
                p = self.store.load_plan(pid)
            except (KeyError, ValueError):
                continue
            ds = self._dataset_id(p)
            if ds:
                plans.setdefault(ds, []).append({'id': pid, 'name': p['task']['name'],
                                                 'strategy': p['strategy']['type'],
                                                 'status': p['status']})
        for r in rows:
            r['plans'] = plans.get(r['id'], [])
            rv = self.store.load_reviews(r['id'])['episodes']
            r['review_counts'] = _review_counts(rv, r.get('total_episodes', 0))
        return {'datasets': rows, 'root': str(self.dataset_root)}

    def _bindings(self, dataset_id):
        """dataset episode index -> plan episode info, for every plan writing here."""
        out = {}
        for pid in self.store.list_plan_ids():
            prog = self.store.load_progress(pid)
            if not prog or prog.get('dataset_id') != dataset_id:
                continue
            try:
                ver = self.store.load_version(pid, prog['version'])
            except KeyError:
                continue
            eps = {e['id']: e for e in ver['episodes']}
            for eid, st in prog['episodes'].items():
                for att in st.get('attempts', []):
                    idx = att.get('dataset_episode_index')
                    if idx is None or att.get('result') != 'saved':
                        continue
                    out[int(idx)] = {'plan_id': pid, 'plan_name': ver['task']['name'],
                                     'strategy': ver['strategy']['type'],
                                     'episode_id': eid, 'plan_version': att.get('plan_version'),
                                     'config': eps.get(eid), 'items': ver['task'].get('items'),
                                     'validation': att.get('validation'),
                                     'frames': (att.get('validation') or {}).get('frames'),
                                     'superseded': idx != st.get('dataset_episode_index')}
        return out

    def cmd_data_overview(self, dataset_id):
        ds = dsio.Dataset(self.dataset_root, dataset_id)
        ov = ds.overview()
        reviews = self.store.load_reviews(dataset_id)['episodes']
        binds = self._bindings(dataset_id)
        ov['review_counts'] = _review_counts(reviews, ov['total_episodes'])
        planned = {b['plan_id']: b for b in binds.values()}
        ov['plans'] = [{'plan_id': p['plan_id'], 'name': p['plan_name'],
                        'strategy': p['strategy']} for p in planned.values()]
        ov['planning_type'] = ', '.join(sorted({p['strategy'] for p in planned.values()})) or \
            'not planned'
        ov['validation_failed'] = sum(1 for b in binds.values()
                                      if b.get('validation') and not b['validation'].get('ok'))
        ov['uploads'] = self.store.uploads(dataset_id, limit=10)
        return ov

    def cmd_data_episodes(self, dataset_id):
        ds = dsio.Dataset(self.dataset_root, dataset_id)
        reviews = self.store.load_reviews(dataset_id)['episodes']
        binds = self._bindings(dataset_id)
        rows = []
        for e in ds.episodes():
            idx = e['episode_index']
            b = binds.get(idx)
            stale = bool(b and b.get('frames') and b['frames'] != e['length'])
            rows.append({
                'episode_index': idx, 'length': e['length'], 'duration_s': e['duration_s'],
                'tasks': e['tasks'],
                'review': reviews.get(str(idx)),
                'plan': ({k: b[k] for k in ('plan_id', 'plan_name', 'episode_id', 'strategy',
                                            'plan_version', 'superseded')} if b else None),
                'binding_stale': stale,
                'validation': (b or {}).get('validation'),
                'videos': {k: ds.video(idx, k) for k in ds.video_keys},
            })
        return {'dataset_id': dataset_id, 'episodes': rows, 'video_keys': ds.video_keys,
                'version': ds.version, 'fps': ds.fps}

    def cmd_data_episode(self, dataset_id, episode_index, max_points=600):
        ds = dsio.Dataset(self.dataset_root, dataset_id)
        ts = ds.timeseries(int(episode_index), max_points=int(max_points))
        b = self._bindings(dataset_id).get(int(episode_index))
        ts['plan'] = b
        ts['review'] = self.store.load_reviews(dataset_id)['episodes'].get(str(episode_index))
        ts['videos'] = {k: ds.video(int(episode_index), k) for k in ds.video_keys}
        ts['check'] = ds.check_episode(int(episode_index), min_duration_s=0.5)
        rows = ts['action'] if ts.get('action') else ts.get('state') or []
        names = ts['action_names'] if ts.get('action') else ts.get('state_names')
        try:
            auto = phases.detect(ts.get('timestamp') or [], rows, names or [])
        except Exception as e:  # noqa: BLE001 - markers are optional
            auto = {'markers': [], 'notes': ['Phase detection failed: %s' % e],
                    'gripper_joint': None}
        manual = (ts['review'] or {}).get('markers')
        ts['phases'] = {'auto': auto['markers'], 'notes': auto['notes'],
                        'gripper_joint': auto['gripper_joint'], 'manual': manual,
                        'labels': phases.LABELS, 'order': phases.PHASES}
        return ts

    def cmd_data_set_markers(self, dataset_id, episode_index, markers=None):
        """Save operator-adjusted grasp-phase markers (None = back to automatic)."""
        ds = dsio.Dataset(self.dataset_root, dataset_id)
        ep = ds.episode(int(episode_index))
        duration = float(ep.get('length') or 0) / float(ds.fps or 30)
        try:
            clean = None if markers is None else phases.clean_manual(markers, duration)
        except ValueError as e:
            raise CommandError(str(e))
        with self.store.lock:
            data = self.store.load_reviews(dataset_id)
            rec = data['episodes'].get(str(episode_index), {})
            if clean is None:
                rec.pop('markers', None)
            else:
                rec['markers'] = clean
            rec['markers_updated_at'] = now_iso()
            data['episodes'][str(episode_index)] = rec
            self.store.save_reviews(dataset_id, data)
            self._export_reviews(dataset_id, data)
        return {'markers': clean}

    def cmd_data_review(self, dataset_id, episode_index, status=None, comment=None,
                        failure_categories=None, metadata=None, source='data'):
        dsio.Dataset(self.dataset_root, dataset_id).episode(int(episode_index))
        if status is not None and status not in REVIEW_STATUSES:
            raise CommandError('Status must be one of %s.' % ', '.join(REVIEW_STATUSES))
        bad = [c for c in (failure_categories or []) if c not in FAILURE_CATEGORIES]
        if bad:
            raise CommandError('Unknown failure category: %s' % ', '.join(bad))
        with self.store.lock:
            data = self.store.load_reviews(dataset_id)
            rec = data['episodes'].get(str(episode_index), {})
            if status is not None:
                rec['status'] = status
            if comment is not None:
                rec['comment'] = comment
            if failure_categories is not None:
                rec['failure_categories'] = failure_categories
            if metadata is not None:
                if not isinstance(metadata, dict):
                    raise CommandError('Metadata must be key/value pairs.')
                rec['metadata'] = {str(k): str(v) for k, v in metadata.items()}
            rec['updated_at'] = now_iso()
            rec['source'] = source if source in ('data', 'record') else 'data'
            rec.setdefault('history', []).append({'t': rec['updated_at'],
                                                  'status': rec.get('status'),
                                                  'source': rec['source']})
            rec['history'] = rec['history'][-20:]
            data['episodes'][str(episode_index)] = rec
            self.store.save_reviews(dataset_id, data)
            self._export_reviews(dataset_id, data)
        if status is not None:
            rec['plan_sync'] = self._sync_plan_review(dataset_id, int(episode_index), status)
        return rec

    # ---- episode review (Record) ---------------------------------------------
    REVIEW_FILE = 'episode_reviews.json'

    def _export_reviews(self, dataset_id, data=None):
        """Keep meta/episode_reviews.json in the dataset in sync (best effort)."""
        try:
            path = dsio.resolve(self.dataset_root, dataset_id) / 'meta'
            if not path.is_dir():
                return
            from physical_ai_server.planning.store import atomic_write_json
            atomic_write_json(path / self.REVIEW_FILE, self._reviews_export(dataset_id, data))
        except Exception as e:  # noqa: BLE001 - never block a review on this
            self.log('could not export reviews for %s: %s' % (dataset_id, e))

    def _reviews_export(self, dataset_id, data=None):
        data = data or self.store.load_reviews(dataset_id)
        return {
            'format': 'physical-ai-manager/episode-reviews/v1',
            'dataset': dataset_id,
            'updated_at': now_iso(),
            'episodes': {k: {f: v.get(f) for f in (
                'status', 'comment', 'failure_categories', 'metadata', 'updated_at',
                'source', 'markers')} for k, v in data.get('episodes', {}).items()},
        }

    def _sync_plan_review(self, dataset_id, index, status):
        """A rejected take sends its plan episode back to 'pending' (recollect);
        accepting it again restores 'validated'. Superseded takes do not change
        the plan."""
        changed = None
        with self.store.lock:
            for pid in self.store.list_plan_ids():
                prog = self.store.load_progress(pid)
                if not prog or prog.get('dataset_id') != dataset_id:
                    continue
                for eid, st in prog['episodes'].items():
                    if st.get('dataset_episode_index') != index:
                        continue
                    if status == 'rejected' and st['status'] in ('validated', 'recorded'):
                        st['status'] = 'pending'
                        st['review'] = 'rejected'
                        st['note'] = 'Take %d rejected in review - record again.' % index
                    elif status == 'accepted' and st.get('review') == 'rejected' and \
                            (st.get('validation') or {}).get('ok'):
                        st['status'] = 'validated'
                        st.pop('note', None)
                        st['review'] = 'accepted'
                    else:
                        st['review'] = status
                    st['updated_at'] = now_iso()
                    self.store.save_progress(pid, prog)
                    self.store.log_event(pid, 'take_reviewed', episode_id=eid,
                                         dataset_episode_index=index, status=status)
                    changed = {'plan_id': pid, 'episode_id': eid, 'status': st['status']}
        return changed

    def _note_recent_save(self, dataset_path, plan_id):
        try:
            if not dataset_path:
                return
            path = Path(dataset_path).resolve()
            root = self.dataset_root.resolve()
            if root not in path.parents:
                return
            ds_id = path.relative_to(root).as_posix()
            info = dsio.read_info(path) or {}
            index = int(info.get('total_episodes') or 0) - 1
            if index < 0:
                return
            with self.store.lock:
                state = self.store.state()
                recent = [r for r in state.get('recent_saves', [])
                          if not (r['dataset_id'] == ds_id and r['episode_index'] == index)]
                active = None
                if plan_id:
                    prog = self.store.load_progress(plan_id) or {}
                    active = (prog.get('active') or {}).get('episode_id')
                recent.append({'dataset_id': ds_id, 'episode_index': index, 't': now_iso(),
                               'plan_id': plan_id, 'episode_id': active})
                self.store.set_state(recent_saves=recent[-30:])
        except Exception as e:  # noqa: BLE001
            self.log('could not note saved episode: %s' % e)

    def cmd_settings_get(self):
        s = self.store.state().get('settings') or {}
        return {'record_review_enabled': bool(s.get('record_review_enabled', False)),
                'record_review_enabled_at': s.get('record_review_enabled_at')}

    def cmd_settings_set(self, record_review_enabled=None):
        with self.store.lock:
            s = dict(self.store.state().get('settings') or {})
            if record_review_enabled is not None:
                on = bool(record_review_enabled)
                if on and not s.get('record_review_enabled'):
                    s['record_review_enabled_at'] = now_iso()
                s['record_review_enabled'] = on
            self.store.set_state(settings=s)
        return self.cmd_settings_get()

    def cmd_record_recent(self, limit=10):
        """Recently saved episodes with their review state (newest first).
        'awaiting_review' lists those saved while Record review was ON and not
        yet decided."""
        state = self.store.state()
        settings = self.cmd_settings_get()
        since = settings.get('record_review_enabled_at') or ''
        rows = []
        for r in reversed(state.get('recent_saves', [])):
            reviews = self.store.load_reviews(r['dataset_id'])['episodes']
            rv = reviews.get(str(r['episode_index']))
            try:
                ds = dsio.Dataset(self.dataset_root, r['dataset_id'])
                ep = ds.episode(r['episode_index'])
            except dsio.DatasetError:
                continue  # deleted or renumbered since
            rows.append(dict(r, review=rv, length=ep['length'],
                             duration_s=ep['duration_s'], tasks=ep['tasks']))
        awaiting = [x for x in rows if settings['record_review_enabled'] and
                    x['t'] >= since and not (x['review'] or {}).get('status')]
        return {'settings': settings, 'recent': rows[:int(limit)],
                'awaiting_review': list(reversed(awaiting))}

    def cmd_data_delete_episodes(self, dataset_id, episode_indices, confirm=''):
        ds = dsio.Dataset(self.dataset_root, dataset_id)
        if confirm != dataset_id:
            raise CommandError('Type the dataset id to confirm deletion.')
        if ds.version != 'v2':
            raise CommandError('Episode deletion supports LeRobot v2.1 datasets only.')
        if self._ctx('is_recording', False):
            raise CommandError('Stop recording before deleting episodes.')
        indices = sorted({int(i) for i in episode_indices})
        known = {e['episode_index'] for e in ds.episodes()}
        missing = [i for i in indices if i not in known]
        if missing or not indices:
            raise CommandError('Episodes not in dataset: %s' % (missing or 'none selected'))

        def work(progress):
            from physical_ai_server.data_processing.data_editor import DataEditor
            progress(0, 2, 'Deleting %d episode(s)...' % len(indices))
            res = DataEditor().delete_episodes_batch(str(ds.path), indices)
            if not getattr(res, 'success', True):
                raise RuntimeError('Delete reported failure.')
            progress(1, 2, 'Updating reviews and plan links...')
            self._remap_after_delete(dataset_id, indices)
            progress(2, 2, 'Done')
            return {'deleted': indices}

        return self._start_job('delete_episodes', work)

    def _remap_after_delete(self, dataset_id, deleted):
        deleted = sorted(deleted)

        def new_index(i):
            if i in deleted:
                return None
            return i - sum(1 for d in deleted if d < i)

        with self.store.lock:
            data = self.store.load_reviews(dataset_id)
            remapped = {}
            for k, v in data['episodes'].items():
                n = new_index(int(k))
                if n is not None:
                    remapped[str(n)] = v
            data['episodes'] = remapped
            self.store.save_reviews(dataset_id, data)
            self._export_reviews(dataset_id, data)
            st = self.store.state()
            recent = []
            for r in st.get('recent_saves', []):
                if r['dataset_id'] == dataset_id:
                    n = new_index(int(r['episode_index']))
                    if n is None:
                        continue
                    r = dict(r, episode_index=n)
                recent.append(r)
            self.store.set_state(recent_saves=recent)
            for pid in self.store.list_plan_ids():
                prog = self.store.load_progress(pid)
                if not prog or prog.get('dataset_id') != dataset_id:
                    continue
                for eid, st in prog['episodes'].items():
                    for att in st.get('attempts', []):
                        if att.get('dataset_episode_index') is not None:
                            n = new_index(int(att['dataset_episode_index']))
                            if n is None:
                                att['deleted_from_dataset'] = True
                            att['dataset_episode_index'] = n
                    if st.get('dataset_episode_index') is not None:
                        n = new_index(int(st['dataset_episode_index']))
                        st['dataset_episode_index'] = n
                        if n is None and st['status'] in ('validated', 'recorded', 'failed'):
                            st['status'] = 'pending'
                            st['note'] = 'Take deleted in Data; record again.'
                self.store.save_progress(pid, prog)
                self.store.log_event(pid, 'dataset_episodes_deleted', indices=deleted)

    # collection metadata travels with the dataset when it is published
    def _collection_files(self, dataset_id):
        files = {}
        files['episode_reviews.json'] = self._reviews_export(dataset_id)
        for pid in self.store.list_plan_ids():
            prog = self.store.load_progress(pid)
            if prog and prog.get('dataset_id') == dataset_id:
                files['collection_plan_%s.json' % pid] = {
                    'plan': self.store.load_version(pid, prog['version']),
                    'progress': prog}
        return files

    def cmd_data_hf_account(self):
        try:
            from huggingface_hub import HfApi
            who = HfApi().whoami()
        except Exception as e:  # noqa: BLE001
            raise CommandError('Not signed in to Hugging Face (%s). Register a token below.' % e)
        return {'name': who.get('name'), 'fullname': who.get('fullname'),
                'orgs': [o.get('name') for o in who.get('orgs', [])],
                'avatar_url': who.get('avatarUrl')}

    def cmd_data_hf_repos(self, author):
        from huggingface_hub import HfApi
        try:
            rows = list(HfApi().list_datasets(author=author, limit=200))
        except Exception as e:  # noqa: BLE001
            raise CommandError('Could not list datasets for %s: %s' % (author, e))
        return {'repos': [{'id': r.id, 'private': bool(getattr(r, 'private', False))}
                          for r in rows]}

    def cmd_data_hf_prepare(self, dataset_id, repo_id, private=True, include_metadata=True):
        ds = dsio.Dataset(self.dataset_root, dataset_id)
        if self._ctx('is_recording', False):
            raise CommandError('Stop recording before uploading.')
        if '/' not in (repo_id or ''):
            raise CommandError('Repository must look like "<user or org>/<name>".')
        from huggingface_hub import HfApi
        api = HfApi()
        try:
            url = api.create_repo(repo_id, repo_type='dataset', private=bool(private),
                                  exist_ok=True)
            visibility = None
            try:
                visibility = 'private' if api.repo_info(
                    repo_id, repo_type='dataset').private else 'public'
            except Exception:  # noqa: BLE001
                pass
        except Exception as e:  # noqa: BLE001
            raise CommandError('Hugging Face refused to create %s: %s' % (repo_id, e))
        written = []
        if include_metadata:
            for name, content in self._collection_files(dataset_id).items():
                from physical_ai_server.planning.store import atomic_write_json
                atomic_write_json(ds.path / 'meta' / name, content)
                written.append('meta/' + name)
        self.store.add_upload({'dataset': dataset_id, 'target': 'huggingface',
                               'repo': repo_id, 'status': 'started',
                               'private': bool(private)})
        return {'local_dir': str(ds.path), 'repo_url': str(url), 'visibility': visibility,
                'metadata_files': written,
                'note': ('Repository already existed as %s; its visibility was not changed.' % (
                    visibility) if visibility and visibility != (
                        'private' if private else 'public') else '')}

    def cmd_data_record_upload(self, dataset_id, target, repo, status, message=''):
        return self.store.add_upload({'dataset': dataset_id, 'target': target, 'repo': repo,
                                      'status': status, 'message': message})

    def cmd_data_uploads(self, dataset_id=None):
        return {'uploads': self.store.uploads(dataset_id)}

    # ----------------------------------------------------------- GitHub ---
    def _gh(self):
        return gh.GitHubClient(self.store.read_secret('github_token'))

    def cmd_github_status(self):
        if not self.store.read_secret('github_token'):
            return {'signed_in': False}
        try:
            return {'signed_in': True, 'user': self._gh().user()}
        except gh.GitHubError as e:
            return {'signed_in': False, 'error': str(e)}

    def cmd_github_set_token(self, token):
        token = (token or '').strip()
        if not token:
            raise CommandError('Paste a GitHub personal access token.')
        user = gh.GitHubClient(token).user()
        self.store.write_secret('github_token', token)
        return {'signed_in': True, 'user': user}

    def cmd_github_logout(self):
        self.store.write_secret('github_token', '')
        return {'signed_in': False}

    def cmd_github_repos(self):
        return {'repos': self._gh().repos()}

    def cmd_github_branches(self, repo):
        return {'branches': self._gh().branches(repo)}

    def cmd_github_create_repo(self, name, private=True, description=''):
        return self._gh().create_repo(_slug(name), private, description)

    def _github_files(self, dataset_id, prefix, hf_repo=None):
        ds = dsio.Dataset(self.dataset_root, dataset_id)
        prefix = (prefix or ('datasets/' + dataset_id.split('/')[1])).strip('/')
        files = {}
        for name in ('info.json', 'tasks.jsonl', 'episodes.jsonl', 'tasks.parquet'):
            p = ds.path / 'meta' / name
            if p.exists():
                files['%s/meta/%s' % (prefix, name)] = p.read_bytes()
        for name, content in self._collection_files(dataset_id).items():
            files['%s/collection/%s' % (prefix, name)] = json.dumps(
                content, indent=2, ensure_ascii=False).encode()
        files['%s/README.md' % prefix] = _github_readme(ds.overview(), hf_repo,
                                                        self.store.load_reviews(dataset_id))
        return files

    def cmd_github_preview(self, dataset_id, prefix='', hf_repo=None):
        files = self._github_files(dataset_id, prefix, hf_repo)
        return {'files': [{'path': k, 'bytes': len(v)} for k, v in sorted(files.items())]}

    def cmd_github_publish(self, dataset_id, repo, branch='', prefix='', hf_repo=None,
                           message=''):
        client = self._gh()
        files = self._github_files(dataset_id, prefix, hf_repo)
        msg = message or 'Add collection metadata for %s' % dataset_id

        def work(progress):
            res = client.commit_files(repo, branch, files, msg, progress)
            self.store.add_upload({'dataset': dataset_id, 'target': 'github', 'repo': repo,
                                   'branch': res['branch'], 'status': 'success',
                                   'url': res['html_url']})
            return res

        return self._start_job('github_publish', work)


def _review_counts(reviews, total):
    c = {'accepted': 0, 'rejected': 0, 'needs_review': 0}
    for v in reviews.values():
        if v.get('status') in c:
            c[v['status']] += 1
    c['unreviewed'] = max(0, int(total or 0) - sum(c.values()))
    c['pending'] = c['needs_review'] + c['unreviewed']
    c['total'] = int(total or 0)
    return c


def _progress_counts(prog, approved):
    eps = (prog or {}).get('episodes') or {}
    ids = [e['id'] for e in approved['episodes']] if approved else list(eps)
    c = {s: 0 for s in EPISODE_STATES}
    for eid in ids:
        st = (eps.get(eid) or {}).get('status', 'pending')
        c[st] = c.get(st, 0) + 1
    duration = sum(float((eps.get(eid) or {}).get('duration_s') or 0) for eid in ids)
    c['total'] = len(ids)
    c['done'] = c['validated']
    c['remaining'] = c['pending'] + c['recording'] + c['failed']
    c['recorded_duration_s'] = round(duration, 1)
    return c


def _github_readme(ov, hf_repo, reviews):
    counts = _review_counts(reviews.get('episodes', {}), ov['total_episodes'])
    lines = [
        '# %s' % ov['id'], '',
        'Collection metadata for a LeRobot dataset recorded with Physical AI Manager.', '',
        '| | |', '|---|---|',
        '| Robot type | %s |' % ov.get('robot_type'),
        '| LeRobot format | %s |' % ov.get('codebase_version'),
        '| Episodes | %d |' % ov['total_episodes'],
        '| Frames | %d @ %s fps |' % (ov['total_frames'], ov['fps']),
        '| Cameras | %s |' % ', '.join(c['key'] for c in ov['cameras']),
        '| Reviewed | %d accepted, %d rejected, %d need review, %d unreviewed |' % (
            counts['accepted'], counts['rejected'], counts['needs_review'],
            counts['unreviewed']),
        '',
    ]
    if ov.get('tasks'):
        lines += ['## Task instructions', ''] + ['- %s' % t for t in ov['tasks']] + ['']
    if hf_repo:
        lines += ['## Data', '',
                  'Frames and videos are on the Hugging Face Hub: '
                  'https://huggingface.co/datasets/%s' % hf_repo, '',
                  '```python', 'from lerobot.datasets.lerobot_dataset import LeRobotDataset',
                  'ds = LeRobotDataset("%s")' % hf_repo, '```', '']
    lines += ['Videos and frame data are intentionally not stored in this Git repository.', '']
    return '\n'.join(lines).encode()
