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

"""Plan validation with concrete, machine-applicable corrections.

Every issue is ``{severity, code, message, episode_id?, item_id?, fix?}``.
``severity`` is ``error`` (blocks approval), ``warning`` (approval allowed,
shown prominently) or ``info``.  ``fix`` is ``{label, op, args}`` and can be
applied with :func:`apply_fix`.
"""

import copy
import random
import re

from physical_ai_server.planning import engine
from physical_ai_server.planning import geometry as geo

_REPO_SAFE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$')

PROBLEM_TEXT = {
    'outside_workspace': 'is outside the table workspace',
    'out_of_reach': 'is beyond the robot reach',
    'too_close_to_base': 'is too close to the robot base',
    'in_keepout': 'is inside a keep-out zone',
}


def _issue(severity, code, message, **kw):
    out = {'severity': severity, 'code': code, 'message': message}
    out.update({k: v for k, v in kw.items() if v is not None})
    return out


def validate(plan):
    issues = []
    task = plan.get('task', {})
    strategy = plan.get('strategy', {})
    params = strategy.get('params') or {}
    ws = task.get('workspace') or {}
    items = {it['id']: it for it in task.get('items', [])}
    names = {k: v.get('name', k) for k, v in items.items()}
    eps = plan.get('episodes', [])

    # ---- completeness -----------------------------------------------------
    if not (task.get('name') or '').strip():
        issues.append(_issue('error', 'missing_task_name', 'Task name is empty.'))
    elif not _REPO_SAFE.match(task['name']):
        safe = re.sub(r'[^A-Za-z0-9_.-]+', '_', task['name']).strip('_.-') or 'task'
        issues.append(_issue(
            'error', 'task_name_chars',
            'Task name is used in the dataset folder name; use letters, digits, "_", "-" or ".".',
            fix={'label': 'Rename to "%s"' % safe, 'op': 'set_task_field',
                 'args': {'field': 'name', 'value': safe}}))
    if not (task.get('instruction') or '').strip():
        issues.append(_issue('error', 'missing_instruction',
                             'Task instruction is empty - it is stored with every episode '
                             'and read by language-conditioned policies.'))
    if not (task.get('robot_type') or '').strip():
        issues.append(_issue('error', 'missing_robot_type',
                             'Robot type is not set. Select a robot on Home first.'))
    if not (task.get('user_id') or '').strip():
        issues.append(_issue('error', 'missing_user_id',
                             'Dataset owner (Hugging Face user) is not set; it forms the '
                             'dataset path <owner>/<robot>_<task>.'))
    if not items:
        issues.append(_issue('error', 'no_items', 'Add at least one object or target.'))
    target_count = int(task.get('episode_count') or 0)
    if target_count <= 0:
        issues.append(_issue('error', 'no_episodes', 'Total number of episodes must be >= 1.'))
    if not eps:
        issues.append(_issue('error', 'not_generated', 'Plan has no episodes yet.',
                             fix={'label': 'Generate plan', 'op': 'regenerate', 'args': {}}))
        return _finish(issues)
    if len(eps) != target_count:
        issues.append(_issue(
            'warning', 'episode_count_mismatch',
            'Plan has %d episodes but the task asks for %d.' % (len(eps), target_count),
            fix={'label': 'Set total to %d' % len(eps), 'op': 'set_task_field',
                 'args': {'field': 'episode_count', 'value': len(eps)}}))
    rec = task.get('recording') or {}
    if float(rec.get('episode_s') or 0) <= 0:
        issues.append(_issue('error', 'episode_time', 'Episode time must be > 0 s.',
                             fix={'label': 'Use 20 s', 'op': 'set_recording_field',
                                  'args': {'field': 'episode_s', 'value': 20}}))
    if not 1 <= int(rec.get('fps') or 0) <= 60:
        issues.append(_issue('error', 'fps', 'FPS must be between 1 and 60.',
                             fix={'label': 'Use 30 fps', 'op': 'set_recording_field',
                                  'args': {'field': 'fps', 'value': 30}}))
    if not ws.get('verified'):
        issues.append(_issue('warning', 'workspace_unverified',
                             'Workspace limits are robot defaults and have not been checked '
                             'on your table.',
                             fix={'label': 'Mark workspace as verified',
                                  'op': 'set_workspace_field',
                                  'args': {'field': 'verified', 'value': True}}))

    # ---- per-episode geometry --------------------------------------------
    min_ot = float((params.get('constraints') or {}).get('min_object_target_mm') or 0)
    margin = float(ws.get('margin_mm', 0))
    ids_seen = set()
    for ep in eps:
        if ep['id'] in ids_seen:
            issues.append(_issue('error', 'duplicate_episode_id',
                                 'Duplicate episode id %s.' % ep['id'], episode_id=ep['id']))
        ids_seen.add(ep['id'])
        if not (ep.get('instruction') or '').strip():
            issues.append(_issue('error', 'episode_instruction', 'Episode has no instruction.',
                                 episode_id=ep['id'],
                                 fix={'label': 'Use task instruction', 'op': 'set_episode_field',
                                      'args': {'episode_id': ep['id'], 'field': 'instruction',
                                               'value': task.get('instruction', '')}}))
        placed = []
        for p in ep.get('placements', []):
            item = items.get(p['item_id'])
            if item is None:
                issues.append(_issue('error', 'unknown_item',
                                     'Placement refers to a removed item "%s".' % p['item_id'],
                                     episode_id=ep['id'],
                                     fix={'label': 'Regenerate plan', 'op': 'regenerate',
                                          'args': {}}))
                continue
            r = float(item.get('size_mm') or 0) / 2.0
            problems = geo.point_problems(p['x_mm'], p['y_mm'], ws, r)
            avoid = [(ox, oy, r + float(o.get('size_mm') or 0) / 2.0 + margin)
                     for o, ox, oy in placed]
            if problems:
                fixed = geo.nearest_valid_point(p['x_mm'], p['y_mm'], ws, r, avoid)
                issues.append(_issue(
                    'error', problems[0],
                    '%s at (%d, %d) mm %s.' % (names.get(p['item_id']), p['x_mm'], p['y_mm'],
                                               PROBLEM_TEXT[problems[0]]),
                    episode_id=ep['id'], item_id=p['item_id'],
                    fix=({'label': 'Move to nearest valid point (%d, %d)' % fixed,
                          'op': 'set_placement',
                          'args': {'episode_id': ep['id'], 'item_id': p['item_id'],
                                   'x_mm': fixed[0], 'y_mm': fixed[1]}} if fixed else None)))
            for other, ox, oy in placed:
                d = geo.dist(p['x_mm'], p['y_mm'], ox, oy)
                need = r + float(other.get('size_mm') or 0) / 2.0 + margin
                pair = {item.get('role'), other.get('role')}
                if pair == {'object', 'target'}:
                    need = max(need, min_ot)
                if d < need:
                    fixed = geo.nearest_valid_point(
                        p['x_mm'], p['y_mm'], ws, r,
                        [(ox, oy, need)] + [a for a in avoid if (a[0], a[1]) != (ox, oy)])
                    issues.append(_issue(
                        'error', 'overlap',
                        '%s and %s are %d mm apart; they need at least %d mm.' % (
                            names.get(p['item_id']), other.get('name'), d, need),
                        episode_id=ep['id'], item_id=p['item_id'],
                        fix=({'label': 'Move %s to (%d, %d)' % (
                            (names.get(p['item_id']),) + fixed),
                              'op': 'set_placement',
                              'args': {'episode_id': ep['id'], 'item_id': p['item_id'],
                                       'x_mm': fixed[0], 'y_mm': fixed[1]}} if fixed else None)))
            placed.append((item, p['x_mm'], p['y_mm']))
        missing = set(items) - {p['item_id'] for p in ep.get('placements', [])}
        if missing:
            issues.append(_issue('error', 'missing_placement',
                                 'No position for %s.' % ', '.join(names[m] for m in missing),
                                 episode_id=ep['id'],
                                 fix={'label': 'Regenerate plan (keeps edited episodes)',
                                      'op': 'regenerate', 'args': {'keep_edited': True}}))
        issues.extend(_sequence_issues(ep, items, names))

    # ---- distribution and coverage ----------------------------------------
    stype = strategy.get('type')
    summary = engine.summarize(plan)
    if stype in ('dynamic', 'semi_dynamic', 'randomized', 'scenario') and len(eps) > 1:
        if summary['distinct_setups'] <= 1 and stype != 'scenario':
            positions = {tuple((p['item_id'], round(p['x_mm']), round(p['y_mm']))
                               for p in e['placements']) for e in eps}
            if len(positions) <= 1:
                issues.append(_issue(
                    'warning', 'no_variation',
                    'Planning type is "%s" but every episode has the same setup.' % stype,
                    fix={'label': 'Switch to Static planning', 'op': 'set_strategy_type',
                         'args': {'type': 'static'}}))
    if stype == 'dynamic':
        counts = list(summary['by_region_combo'].values())
        if counts and max(counts) - min(counts) > 1 and not any(e.get('edited') for e in eps):
            issues.append(_issue('warning', 'unbalanced',
                                 'Region combinations are unevenly covered (%d-%d episodes '
                                 'each).' % (min(counts), max(counts)),
                                 fix={'label': 'Regenerate balanced', 'op': 'regenerate',
                                      'args': {}}))
        _, _, n_combos = engine._dynamic_schedule(task, params, len(eps),
                                                  random.Random(0))
        if n_combos > len(eps):
            issues.append(_issue(
                'warning', 'coverage',
                '%d combinations but only %d episodes - some combinations are never '
                'demonstrated.' % (n_combos, len(eps)),
                fix={'label': 'Set total to %d' % n_combos, 'op': 'set_task_field',
                     'args': {'field': 'episode_count', 'value': n_combos}}))
    if stype == 'scenario':
        scen = params.get('scenarios') or []
        total = sum(int(s.get('count') or 0) for s in scen)
        if total != target_count:
            issues.append(_issue(
                'error', 'scenario_counts',
                'Scenario counts add up to %d but the plan needs %d episodes.' % (
                    total, target_count),
                fix={'label': 'Scale scenario counts to %d' % target_count,
                     'op': 'scale_scenarios', 'args': {'total': target_count}}))
        if scen and not any(s.get('kind') == 'success' and int(s.get('count') or 0) > 0
                            for s in scen):
            issues.append(_issue('warning', 'no_success_demos',
                                 'No successful demonstrations - the policy needs normal '
                                 'examples as well as failures/recoveries.'))
    instructions = {e.get('instruction', '') for e in eps}
    if len(instructions) > 1:
        issues.append(_issue('info', 'varied_instructions',
                             '%d different instructions across episodes. Language-conditioned '
                             'policies see each one as a task.' % len(instructions)))
    return _finish(issues, summary)


def _sequence_issues(ep, items, names):
    out = []
    holding = None
    seq = ep.get('sequence') or []
    for k, step in enumerate(seq):
        a = step.get('action')
        if a not in engine.ACTION_TYPES:
            out.append(_issue('error', 'unknown_action', 'Step %d has unknown action "%s".' % (
                k + 1, a), episode_id=ep['id']))
            continue
        if a in ('pick', 'place', 'push', 'rotate') and step.get('item_id') not in items:
            out.append(_issue('error', 'step_item', 'Step %d (%s) has no valid object.' % (
                k + 1, a), episode_id=ep['id']))
        if a == 'pick':
            if holding:
                out.append(_issue('error', 'pick_while_holding',
                                  'Step %d picks %s while still holding %s.' % (
                                      k + 1, names.get(step.get('item_id')), names.get(holding)),
                                  episode_id=ep['id'],
                                  fix={'label': 'Insert "place" before step %d' % (k + 1),
                                       'op': 'insert_step',
                                       'args': {'episode_id': ep['id'], 'index': k,
                                                'step': {'action': 'place',
                                                         'item_id': holding}}}))
            holding = step.get('item_id')
        elif a == 'place':
            if holding is None or step.get('item_id') != holding:
                out.append(_issue('error', 'place_without_pick',
                                  'Step %d places %s that was not picked.' % (
                                      k + 1, names.get(step.get('item_id'), 'an object')),
                                  episode_id=ep['id'],
                                  fix={'label': 'Insert "pick" before step %d' % (k + 1),
                                       'op': 'insert_step',
                                       'args': {'episode_id': ep['id'], 'index': k,
                                                'step': {'action': 'pick',
                                                         'item_id': step.get('item_id')}}}))
            if step.get('target_id') and step['target_id'] not in items:
                out.append(_issue('error', 'step_target', 'Step %d has an unknown target.' % (
                    k + 1), episode_id=ep['id']))
            holding = None
        elif a == 'open_gripper':
            holding = None
    if holding:
        out.append(_issue('warning', 'ends_holding',
                          'Sequence ends while still holding %s.' % names.get(holding),
                          episode_id=ep['id']))
    return out


def _finish(issues, summary=None):
    errors = sum(1 for i in issues if i['severity'] == 'error')
    warnings = sum(1 for i in issues if i['severity'] == 'warning')
    # Collapse identical per-episode messages so the panel stays readable.
    return {'ok': errors == 0, 'errors': errors, 'warnings': warnings,
            'issues': issues, 'summary': summary or {}}


# ------------------------------------------------------------- fixes -------

def apply_fix(plan, fix):
    """Return a modified copy of ``plan`` with ``fix`` applied."""
    plan = copy.deepcopy(plan)
    op = fix.get('op')
    a = fix.get('args') or {}
    task = plan['task']
    if op == 'set_task_field':
        task[a['field']] = a['value']
    elif op == 'set_recording_field':
        task.setdefault('recording', {})[a['field']] = a['value']
    elif op == 'set_workspace_field':
        task['workspace'][a['field']] = a['value']
    elif op == 'set_strategy_type':
        plan['strategy']['type'] = a['type']
        plan['strategy']['params'] = engine.default_params(a['type'], task)
    elif op == 'set_placement':
        ep = _episode(plan, a['episode_id'])
        for p in ep['placements']:
            if p['item_id'] == a['item_id']:
                p['x_mm'], p['y_mm'] = float(a['x_mm']), float(a['y_mm'])
                p['region'] = geo.region_of(p['x_mm'], p['y_mm'], task.get('regions'))
        ep['edited'] = True
    elif op == 'set_episode_field':
        ep = _episode(plan, a['episode_id'])
        ep[a['field']] = a['value']
        ep['edited'] = True
    elif op == 'insert_step':
        ep = _episode(plan, a['episode_id'])
        step = dict(a['step'])
        step.setdefault('id', 'fix%d' % len(ep['sequence']))
        ep['sequence'].insert(int(a['index']), step)
        ep['edited'] = True
    elif op == 'scale_scenarios':
        scen = plan['strategy']['params'].get('scenarios') or []
        total = int(a['total'])
        current = sum(int(s.get('count') or 0) for s in scen) or len(scen) or 1
        raw = [int(s.get('count') or 0) or 1 for s in scen] if current == 0 else \
            [int(s.get('count') or 0) for s in scen]
        base = sum(raw) or 1
        scaled = [int(total * r / base) for r in raw]
        k = 0
        while sum(scaled) < total and scen:
            scaled[k % len(scaled)] += 1
            k += 1
        for s, c in zip(scen, scaled):
            s['count'] = c
    elif op == 'regenerate':
        plan['episodes'] = engine.generate(plan, keep_edited=bool(a.get('keep_edited')))
    else:
        raise ValueError('Unknown fix operation: %s' % op)
    return plan


def _episode(plan, episode_id):
    for e in plan['episodes']:
        if e['id'] == episode_id:
            return e
    raise ValueError('Episode %s not found' % episode_id)
