# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Grasp-phase markers from the recorded joint trajectories.

Heuristic and explainable: it only looks at how much the arm joints move and
how the gripper joint changes. Operators can move or remove every marker in
the Data session; manual markers are stored with the episode review.

Phases: approach, grasp_start, gripper_closed, lift, transport, place, release.
"""

PHASES = ['approach', 'grasp_start', 'gripper_closed', 'lift', 'transport', 'place', 'release']
LABELS = {'approach': 'Approach', 'grasp_start': 'Grasp starts',
          'gripper_closed': 'Gripper closed',
          'lift': 'Lift', 'transport': 'Move', 'place': 'Place', 'release': 'Release'}


def _gripper_index(names, width):
    for i, n in enumerate(names or []):
        if 'gripper' in str(n).lower():
            return i
    return width - 1 if width else None


def _smooth(v, k=2):
    out = []
    for i in range(len(v)):
        a = max(0, i - k)
        b = min(len(v), i + k + 1)
        out.append(sum(v[a:b]) / (b - a))
    return out


def detect(timestamp, rows, names):
    """rows: list of joint vectors (action preferred). Returns
    {'markers': [{phase, t, index}], 'notes': [...], 'gripper_joint': name}."""
    notes = []
    n = len(rows)
    if n < 8 or not timestamp:
        return {'markers': [], 'notes': ['Episode too short to find phases.'],
                'gripper_joint': None}
    width = max(len(r) for r in rows)
    g = _gripper_index(names, width)
    cols = []
    for j in range(width):
        col = [r[j] if j < len(r) and r[j] is not None else None for r in rows]
        last = next((v for v in col if v is not None), 0.0)
        filled = []
        for v in col:
            last = last if v is None else v
            filled.append(last)
        cols.append(filled)
    rng = [max(c) - min(c) or 1e-6 for c in cols]
    arm = [j for j in range(width) if j != g]
    speed = [0.0]
    for i in range(1, n):
        speed.append(max((abs(cols[j][i] - cols[j][i - 1]) / rng[j] for j in arm), default=0.0))
    speed = _smooth(speed)
    peak = max(speed) or 1e-6
    moving = [s > 0.12 * peak for s in speed]

    def t(i):
        return round(float(timestamp[i] - timestamp[0]), 3)

    marks = {}
    first_move = next((i for i in range(n) if moving[i]), None)
    if first_move is not None:
        marks['approach'] = first_move
    gname = names[g] if names and g is not None and g < len(names) else None
    if g is None:
        return {'markers': [dict(phase=p, t=t(i), index=i) for p, i in marks.items()],
                'notes': ['No gripper joint found.'], 'gripper_joint': None}
    gv = _smooth(cols[g], 1)
    head = sorted(gv[:max(3, n // 10)])
    open_lv = head[len(head) // 2]
    far = max(gv, key=lambda v: abs(v - open_lv))
    span = abs(far - open_lv)
    if span < 0.04 * max(abs(open_lv), abs(far), 1.0):
        notes.append('The gripper hardly moves in this episode - no grasp found.')
        return {'markers': [dict(phase=p, t=t(i), index=i) for p, i in marks.items()],
                'notes': notes, 'gripper_joint': gname}
    sign = 1 if far > open_lv else -1

    def closed_frac(i):
        return sign * (gv[i] - open_lv) / span

    gs = next((i for i in range(n) if closed_frac(i) > 0.15), None)
    if gs is not None:
        marks['grasp_start'] = gs
        grate = [0.0] + [abs(gv[i] - gv[i - 1]) / span for i in range(1, n)]
        gc = next((i for i in range(gs + 1, n) if closed_frac(i) > 0.4 and grate[i] < 0.01),
                  None)
        if gc is not None:
            marks['gripper_closed'] = gc
            rel = next((i for i in range(gc + 1, n) if closed_frac(i) < 0.5 *
                        closed_frac(gc)), None)
            lift = next((i for i in range(gc + 1, rel or n) if moving[i]), None)
            if lift is not None:
                marks['lift'] = lift
                end = rel or n
                if end - lift > 2:
                    marks['transport'] = max(range(lift, end), key=lambda i: speed[i])
            if rel is not None:
                marks['release'] = rel
                # placement: arm settles shortly before the gripper opens
                k = rel
                while k > (marks.get('transport') or gc) + 1 and not moving[k]:
                    k -= 1
                marks['place'] = min(rel, k + 1)
            else:
                notes.append('The gripper never opens again - no release found.')
            if lift is None:
                notes.append('The arm does not move after the gripper closed - object probably '
                             'not lifted.')
        else:
            notes.append('The gripper starts closing but never settles.')
    order = sorted(marks.items(), key=lambda kv: (kv[1], PHASES.index(kv[0])))
    return {'markers': [{'phase': p, 't': t(i), 'index': i} for p, i in order],
            'notes': notes, 'gripper_joint': gname}


def clean_manual(markers, duration):
    out = []
    for m in markers or []:
        if not isinstance(m, dict) or m.get('phase') not in PHASES:
            raise ValueError('Unknown phase %r.' % (m or {}).get('phase'))
        try:
            tv = float(m.get('t'))
        except (TypeError, ValueError):
            raise ValueError('Marker time must be a number.')
        if not 0 <= tv <= duration + 0.05:
            raise ValueError('Marker %s is outside the episode (0-%.1f s).' % (m['phase'],
                                                                               duration))
        out.append({'phase': m['phase'], 't': round(tv, 3)})
    out.sort(key=lambda m: m['t'])
    return out
