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

"""Collection-plan generation for six planning strategies.

A plan is a plain JSON-serialisable dict::

    {
      "task":     {...what is being demonstrated, items, workspace, regions...},
      "strategy": {"type": <one of STRATEGY_TYPES>, "seed": int, "params": {...}},
      "episodes": [...generated, then operator-editable...]
    }

The engine never assumes pick-and-place.  A task is a set of *items* (things
the robot manipulates, ``role == "object"``, and places/things it acts on,
``role == "target"``), an optional action sequence, and scenarios.  Every
strategy decides, episode by episode, where each item goes and which scenario
and sequence apply.
"""

import copy
import itertools
import math
import random
import re

from physical_ai_server.planning import geometry as geo

STRATEGY_TYPES = ['static', 'semi_dynamic', 'dynamic', 'randomized', 'sequential', 'scenario']

STRATEGY_INFO = {
    'static': 'Every episode uses the same fixed item positions and task.',
    'semi_dynamic': 'Choose which parameters stay fixed and which vary between episodes.',
    'dynamic': 'Balanced coverage of workspace regions, orientations and distances.',
    'randomized': 'Random positions and orientations inside bounds, with constraints.',
    'sequential': 'An ordered multi-step action sequence repeated per episode.',
    'scenario': 'A mix of normal, failure and recovery demonstrations.',
}

ACTION_TYPES = ['pick', 'place', 'move_to', 'push', 'open_gripper', 'close_gripper',
                'rotate', 'wait', 'return_home', 'custom']

PERTURBATIONS = {
    'none': 'Normal demonstration.',
    'off_target_approach': 'Start the approach about {offset_mm} mm off the object, '
                           'then correct onto it before grasping.',
    'object_displacement': 'Object starts {offset_mm} mm away from its planned spot '
                           '(position below already includes the offset).',
    'wrong_orientation': 'Object is rotated {rotate_deg} deg from its usual orientation.',
    'failed_grasp': 'First grasp deliberately misses or slips; release and retry.',
    'drop_and_regrasp': 'Let the object drop after lifting, then pick it up again.',
    'custom': '{notes}',
}

SCENARIO_KINDS = ['success', 'failure', 'recovery']

MAX_EPISODES = 2000


class PlanError(ValueError):
    pass


# ---------------------------------------------------------------- defaults --

def default_sequence(task):
    objects = [i for i in task.get('items', []) if i.get('role') == 'object']
    targets = [i for i in task.get('items', []) if i.get('role') == 'target']
    if not objects:
        return []
    seq = [{'id': 's1', 'action': 'pick', 'item_id': objects[0]['id'], 'notes': ''}]
    if targets:
        seq.append({'id': 's2', 'action': 'place', 'item_id': objects[0]['id'],
                    'target_id': targets[0]['id'], 'notes': ''})
    seq.append({'id': 's%d' % (len(seq) + 1), 'action': 'return_home', 'notes': ''})
    return seq


def default_item_spec(item, regions, index):
    region_ids = [r['id'] for r in regions]
    centre = None
    if region_ids:
        reg = regions[index % len(regions)]
        centre = geo.region_center(reg)
    fixed = {'x_mm': round(centre[0]) if centre else 200,
             'y_mm': round(centre[1]) if centre else 0,
             'yaw_deg': 0}
    return {
        'mode': 'fixed',
        'fixed': fixed,
        'regions': list(region_ids),
        'region_placement': 'centre',
        'points': [],
        'bounds': None,
        'yaw': {'mode': 'fixed', 'value': 0, 'values': [0, 45, 90], 'min': -45, 'max': 45},
    }


def default_params(strategy_type, task):
    items = task.get('items', [])
    regions = task.get('regions', [])
    specs = {it['id']: default_item_spec(it, regions, n) for n, it in enumerate(items)}
    params = {'items': specs, 'order': 'shuffled', 'sequence': default_sequence(task)}
    if strategy_type == 'static':
        pass
    elif strategy_type == 'semi_dynamic':
        # Typical: object fixed, target cycles through regions.
        for it in items:
            if it.get('role') == 'target':
                specs[it['id']]['mode'] = 'regions'
    elif strategy_type == 'dynamic':
        for it in items:
            specs[it['id']]['mode'] = 'regions'
            specs[it['id']]['region_placement'] = 'random_in_region'
        params['distance_bands'] = []
        params['vary_yaw_for'] = [it['id'] for it in items if it.get('role') == 'object']
    elif strategy_type == 'randomized':
        ws = task['workspace']
        for it in items:
            specs[it['id']]['mode'] = 'random'
            specs[it['id']]['bounds'] = {
                'x_min_mm': max(ws['x_min_mm'], ws['reach_min_mm']),
                'x_max_mm': min(ws['x_max_mm'], ws['reach_max_mm']),
                'y_min_mm': ws['y_min_mm'], 'y_max_mm': ws['y_max_mm']}
            specs[it['id']]['yaw'] = {'mode': 'range', 'value': 0, 'values': [0],
                                      'min': -45, 'max': 45}
        params['constraints'] = {'min_object_target_mm': 80, 'max_object_target_mm': None,
                                 'max_attempts': 400}
    elif strategy_type == 'sequential':
        pass
    elif strategy_type == 'scenario':
        for it in items:
            specs[it['id']]['mode'] = 'regions'
        params['scenarios'] = [
            {'id': 'normal', 'name': 'Normal', 'kind': 'success', 'count': 0,
             'perturbation': 'none', 'offset_mm': 0, 'rotate_deg': 0,
             'instruction': '', 'notes': ''},
            {'id': 'recovery', 'name': 'Off-target and correct', 'kind': 'recovery',
             'count': 0, 'perturbation': 'off_target_approach', 'offset_mm': 30,
             'rotate_deg': 0, 'instruction': '', 'notes': ''},
            {'id': 'failed_grasp', 'name': 'Failed grasp and retry', 'kind': 'recovery',
             'count': 0, 'perturbation': 'failed_grasp', 'offset_mm': 0, 'rotate_deg': 0,
             'instruction': '', 'notes': ''},
        ]
        n = int(task.get('episode_count', 0) or 0)
        split = [n - 2 * (n // 4), n // 4, n // 4]
        for sc, c in zip(params['scenarios'], split):
            sc['count'] = c
        params['scenario_order'] = 'interleaved'
    else:
        raise PlanError('Unknown planning type: %s' % strategy_type)
    if strategy_type == 'static':
        for it in items:
            specs[it['id']]['mode'] = 'fixed'
    return params


# ----------------------------------------------------------- generation ----

def _item_radius(item):
    return float(item.get('size_mm') or 0) / 2.0


def _yaw_choices(spec, i, rng):
    yaw = spec.get('yaw') or {}
    mode = yaw.get('mode', 'fixed')
    if mode == 'set':
        values = yaw.get('values') or [0]
        return values[i % len(values)]
    if mode == 'range':
        return round(rng.uniform(float(yaw.get('min', 0)), float(yaw.get('max', 0))))
    return yaw.get('value', spec.get('fixed', {}).get('yaw_deg', 0)) or 0


def _sample_in_rect(rect, rng):
    return (rng.uniform(rect['x_min_mm'], rect['x_max_mm']),
            rng.uniform(rect['y_min_mm'], rect['y_max_mm']))


class _Placer:
    """Places all items of one episode, honouring separation constraints."""

    def __init__(self, task, params, rng):
        self.task = task
        self.ws = task['workspace']
        self.regions = {r['id']: r for r in task.get('regions', [])}
        self.items = task.get('items', [])
        self.params = params
        self.rng = rng
        cons = params.get('constraints') or {}
        self.min_ot = float(cons.get('min_object_target_mm') or 0)
        mx = cons.get('max_object_target_mm')
        self.max_ot = float(mx) if mx not in (None, '', 0) else None
        self.max_attempts = int(cons.get('max_attempts') or 300)

    def _separation(self, a, b):
        margin = float(self.ws.get('margin_mm', 0))
        need = _item_radius(a) + _item_radius(b) + margin
        if {a.get('role'), b.get('role')} == {'object', 'target'}:
            need = max(need, self.min_ot)
        return need

    def _fits(self, item, x, y, placed, band=None):
        if geo.point_problems(x, y, self.ws, _item_radius(item)):
            return False
        for other, ox, oy in placed:
            d = geo.dist(x, y, ox, oy)
            if d < self._separation(item, other):
                return False
            pair = {item.get('role'), other.get('role')}
            if pair == {'object', 'target'}:
                if self.max_ot and d > self.max_ot:
                    return False
                if band and not (band['min_mm'] <= d <= band['max_mm']):
                    return False
        return True

    def place(self, i, choice=None, band=None):
        """choice maps item_id -> region id for this episode (dynamic schedule)."""
        choice = choice or {}
        placed = []
        out = []
        for n, item in enumerate(self.items):
            spec = self.params['items'].get(item['id']) or default_item_spec(
                item, list(self.regions.values()), n)
            mode = spec.get('mode', 'fixed')
            region_id = None
            x = y = None
            if mode == 'fixed':
                f = spec.get('fixed') or {}
                x, y = float(f.get('x_mm', 0)), float(f.get('y_mm', 0))
            elif mode == 'points':
                pts = spec.get('points') or [spec.get('fixed') or {'x_mm': 0, 'y_mm': 0}]
                p = pts[i % len(pts)]
                x, y = float(p['x_mm']), float(p['y_mm'])
            elif mode in ('regions', 'random'):
                if mode == 'regions':
                    ids = [r for r in (spec.get('regions') or []) if r in self.regions]
                    if not ids:
                        raise PlanError('Item "%s" varies by region but no regions are '
                                        'selected.' % item.get('name', item['id']))
                    region_id = choice.get(item['id']) or ids[i % len(ids)]
                    rect = self.regions[region_id]
                    random_inside = spec.get('region_placement') == 'random_in_region'
                else:
                    rect = spec.get('bounds') or self.ws
                    random_inside = True
                if random_inside:
                    best = None
                    for _ in range(self.max_attempts):
                        px, py = _sample_in_rect(rect, self.rng)
                        if self._fits(item, px, py, placed, band):
                            best = (px, py)
                            break
                    if best is None:
                        cx, cy = geo.region_center(rect)
                        best = (cx, cy)
                    x, y = best
                else:
                    x, y = geo.region_center(rect)
                    if not self._fits(item, x, y, placed, band):
                        # nudge inside the region so centre-placed items do not collide
                        for _ in range(self.max_attempts):
                            px, py = _sample_in_rect(rect, self.rng)
                            if self._fits(item, px, py, placed, band):
                                x, y = px, py
                                break
            else:
                raise PlanError('Unknown placement mode "%s"' % mode)
            yaw = _yaw_choices(spec, i, self.rng)
            if choice.get('__yaw__') is not None and item['id'] in (
                    self.params.get('vary_yaw_for') or []):
                yaw = choice['__yaw__']
            if region_id is None:
                region_id = geo.region_of(x, y, list(self.regions.values()))
            placed.append((item, x, y))
            out.append({'item_id': item['id'], 'role': item.get('role', 'object'),
                        'x_mm': round(x, 1), 'y_mm': round(y, 1),
                        'yaw_deg': round(float(yaw), 1), 'region': region_id})
        return out


def _dynamic_schedule(task, params, n, rng):
    """Balanced assignment of region / yaw / distance-band combinations."""
    items = task.get('items', [])
    regions = {r['id'] for r in task.get('regions', [])}
    dims = []
    keys = []
    for it in items:
        spec = params['items'].get(it['id'], {})
        if spec.get('mode') == 'regions':
            ids = [r for r in spec.get('regions', []) if r in regions]
            if ids:
                dims.append(ids)
                keys.append(it['id'])
    vary_yaw = params.get('vary_yaw_for') or []
    yaw_values = None
    for it in items:
        if it['id'] in vary_yaw:
            y = params['items'].get(it['id'], {}).get('yaw', {})
            if y.get('mode') == 'set' and y.get('values'):
                yaw_values = list(y['values'])
    if yaw_values:
        dims.append(yaw_values)
        keys.append('__yaw__')
    bands = [b for b in (params.get('distance_bands') or [])
             if b.get('max_mm', 0) > b.get('min_mm', 0)]
    if bands:
        dims.append(list(range(len(bands))))
        keys.append('__band__')
    combos = [dict(zip(keys, c)) for c in itertools.product(*dims)] if dims else [{}]
    reps = [combos[k % len(combos)] for k in range(n)]
    if params.get('order', 'shuffled') == 'shuffled':
        rng.shuffle(reps)
    return reps, bands, len(combos)


def _scenario_assignment(params, n, rng):
    scenarios = [s for s in params.get('scenarios', []) if int(s.get('count') or 0) > 0]
    seq = []
    for s in scenarios:
        seq.extend([s] * int(s['count']))
    seq = seq[:n]
    while len(seq) < n:
        seq.append(scenarios[0] if scenarios else None)
    if params.get('scenario_order', 'interleaved') == 'interleaved' and scenarios:
        # Even spread: sort by (k / count) fractional position of each copy.
        counts = {}
        keyed = []
        for s in seq:
            if s is None:
                keyed.append((1.0, '', s))
                continue
            counts[s['id']] = counts.get(s['id'], 0) + 1
            keyed.append(((counts[s['id']] - 0.5) / max(1, int(s['count'])), s['id'], s))
        keyed.sort(key=lambda t: (t[0], t[1]))
        seq = [s for _, _, s in keyed]
    elif params.get('scenario_order') == 'random':
        rng.shuffle(seq)
    return seq


def _names(task):
    return {it['id']: it.get('name', it['id']) for it in task.get('items', [])}


_TOKEN = re.compile(r'\{(object|target|object_region|target_region)\}')


def render_instruction(template, task, placements):
    names = _names(task)
    regions = {r['id']: r.get('name', r['id']) for r in task.get('regions', [])}
    first = {}
    for p in placements:
        first.setdefault(p['role'], p)
    values = {
        'object': names.get(first.get('object', {}).get('item_id'), 'object'),
        'target': names.get(first.get('target', {}).get('item_id'), 'target'),
        'object_region': regions.get(first.get('object', {}).get('region'), 'workspace'),
        'target_region': regions.get(first.get('target', {}).get('region'), 'workspace'),
    }
    return _TOKEN.sub(lambda m: str(values[m.group(1)]).lower()
                      if m.group(1).endswith('region') else str(values[m.group(1)]),
                      template or '').strip()


def _apply_perturbation(scn, placements, task, rng):
    if not scn:
        return placements, PERTURBATIONS['none']
    kind = scn.get('perturbation', 'none')
    offset = float(scn.get('offset_mm') or 0)
    rotate = float(scn.get('rotate_deg') or 0)
    placements = copy.deepcopy(placements)
    if kind == 'object_displacement' and offset:
        for p in placements:
            if p['role'] == 'object':
                a = rng.uniform(0, 2 * math.pi)
                nx, ny = p['x_mm'] + offset * math.cos(a), p['y_mm'] + offset * math.sin(a)
                fixed = geo.nearest_valid_point(nx, ny, task['workspace'])
                if fixed:
                    p['x_mm'], p['y_mm'] = fixed
                p['displaced'] = True
                break
    if kind == 'wrong_orientation' and rotate:
        for p in placements:
            if p['role'] == 'object':
                p['yaw_deg'] = round(p['yaw_deg'] + rotate, 1)
                break
    note = PERTURBATIONS.get(kind, '').format(offset_mm=int(offset), rotate_deg=int(rotate),
                                              notes=scn.get('notes', ''))
    if scn.get('notes') and kind != 'custom':
        note = (note + ' ' + scn['notes']).strip()
    return placements, note


def generate(plan, keep_edited=False):
    """Return a new list of episodes for ``plan`` (does not mutate it)."""
    task = plan['task']
    strategy = plan['strategy']
    stype = strategy.get('type')
    if stype not in STRATEGY_TYPES:
        raise PlanError('Unknown planning type: %s' % stype)
    params = strategy.get('params') or default_params(stype, task)
    n = int(task.get('episode_count') or 0)
    if n <= 0:
        raise PlanError('Total number of episodes must be at least 1.')
    if n > MAX_EPISODES:
        raise PlanError('At most %d episodes per plan.' % MAX_EPISODES)
    if not task.get('items'):
        raise PlanError('Add at least one object or target before generating.')
    rng = random.Random(int(strategy.get('seed') or 0))
    placer = _Placer(task, params, rng)

    schedule = [None] * n
    bands = []
    if stype == 'dynamic':
        schedule, bands, _ = _dynamic_schedule(task, params, n, rng)
    scenarios = _scenario_assignment(params, n, rng) if stype == 'scenario' else [None] * n
    seq_template = params.get('sequence')
    if seq_template is None:
        seq_template = default_sequence(task)

    previous = {e['id']: e for e in plan.get('episodes', [])} if keep_edited else {}
    demo_types = task.get('demo_types') or ['standard']
    episodes = []
    for i in range(n):
        eid = 'E%03d' % (i + 1)
        if eid in previous and previous[eid].get('edited'):
            ep = copy.deepcopy(previous[eid])
            ep['index'] = i
            episodes.append(ep)
            continue
        choice = schedule[i] or {}
        band = bands[choice['__band__']] if bands and '__band__' in choice else None
        placements = placer.place(i, choice, band)
        scn = scenarios[i]
        placements, note = _apply_perturbation(scn, placements, task, rng)
        template = (scn or {}).get('instruction') or task.get('instruction', '')
        if scn and scn.get('kind') == 'success' or not scn:
            demo_type = demo_types[i % len(demo_types)] if stype != 'scenario' else 'standard'
        else:
            demo_type = scn.get('kind')
        episodes.append({
            'id': eid,
            'index': i,
            'order': i + 1,
            'instruction': render_instruction(template, task, placements),
            'placements': placements,
            'sequence': copy.deepcopy(seq_template) if (
                stype in ('sequential', 'static', 'scenario') or seq_template) else [],
            'scenario': ({'id': scn['id'], 'name': scn.get('name', scn['id']),
                          'kind': scn.get('kind', 'success'),
                          'perturbation': scn.get('perturbation', 'none')}
                         if scn else {'id': 'normal', 'name': 'Normal', 'kind': 'success',
                                      'perturbation': 'none'}),
            'demo_type': demo_type,
            'distance_band': band,
            'operator_notes': note if scn else '',
            'edited': False,
        })
    episodes.sort(key=lambda e: e['order'])
    return episodes


def summarize(plan):
    """Statistics shown under the plan (distribution and coverage)."""
    eps = plan.get('episodes', [])
    by_region = {}
    by_scenario = {}
    by_yaw = {}
    for e in eps:
        key = tuple((p['item_id'], p.get('region')) for p in e.get('placements', []))
        label = ' / '.join('%s:%s' % (k, r or '-') for k, r in key)
        by_region[label] = by_region.get(label, 0) + 1
        s = e.get('scenario', {}).get('name', 'Normal')
        by_scenario[s] = by_scenario.get(s, 0) + 1
        for p in e.get('placements', []):
            if p['role'] == 'object':
                by_yaw[str(p.get('yaw_deg'))] = by_yaw.get(str(p.get('yaw_deg')), 0) + 1
                break
    distances = []
    for e in eps:
        obj = next((p for p in e.get('placements', []) if p['role'] == 'object'), None)
        tgt = next((p for p in e.get('placements', []) if p['role'] == 'target'), None)
        if obj and tgt:
            distances.append(geo.dist(obj['x_mm'], obj['y_mm'], tgt['x_mm'], tgt['y_mm']))
    return {
        'episodes': len(eps),
        'edited': sum(1 for e in eps if e.get('edited')),
        'by_region_combo': by_region,
        'by_scenario': by_scenario,
        'by_object_yaw': by_yaw,
        'distinct_setups': len(by_region),
        'object_target_distance_mm': ({
            'min': round(min(distances)), 'max': round(max(distances)),
            'mean': round(sum(distances) / len(distances))} if distances else None),
    }
