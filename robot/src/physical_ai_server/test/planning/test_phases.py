# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Grasp-phase markers and targeted re-collection plans."""

import math
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.dirname(__file__))

from physical_ai_server.planning import phases  # noqa: E402
from physical_ai_server.planning.service import CommandError  # noqa: E402
from test_service import approved_plan, env, record_one  # noqa: E402,F401

NAMES = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper']


def pick_place(n=300, open_v=30.0, closed_v=4.0):
    """Approach 0-1 s, close 1.2-1.6 s, lift+move 1.8-6 s, settle, open at 7.5 s."""
    ts = [i / 30 for i in range(n)]
    rows = []
    for t in ts:
        if t < 0.3:
            a = 0.0
        elif t < 1.1:
            a = (t - 0.3) / 0.8
        elif t < 1.8:
            a = 1.0
        elif t < 6.0:
            a = 1.0 + (t - 1.8) / 4.2 * 2
        else:
            a = 3.0
        if t < 1.2:
            gv = open_v
        elif t < 1.6:
            gv = open_v + (closed_v - open_v) * (t - 1.2) / 0.4
        elif t < 7.5:
            gv = closed_v
        else:
            gv = min(open_v, closed_v + (t - 7.5) * 60)
        rows.append([20 * a, -10 * a + 3 * math.sin(a), 15 * a, 5 * a, 0.0, gv])
    return ts, rows


def test_detects_all_phases_in_order():
    ts, rows = pick_place()
    out = phases.detect(ts, rows, NAMES)
    got = {m['phase']: m['t'] for m in out['markers']}
    assert set(got) == set(phases.PHASES), out
    assert got['approach'] < 0.5
    assert 1.1 < got['grasp_start'] < 1.4
    assert 1.5 < got['gripper_closed'] < 1.9
    assert 1.7 < got['lift'] < 2.2
    assert got['lift'] < got['transport'] < got['place'] <= got['release']
    assert 7.4 < got['release'] < 7.9
    assert out['gripper_joint'] == 'gripper' and not out['notes']


def test_gripper_closing_upwards_and_no_grasp():
    ts, rows = pick_place(open_v=2.0, closed_v=40.0)
    got = {m['phase'] for m in phases.detect(ts, rows, NAMES)['markers']}
    assert {'grasp_start', 'gripper_closed', 'release'} <= got
    for r in rows:
        r[5] = 30.0
    out = phases.detect(ts, rows, NAMES)
    assert [m['phase'] for m in out['markers']] == ['approach']
    assert 'no grasp' in out['notes'][0]


def test_manual_markers_are_validated():
    assert phases.clean_manual([{'phase': 'lift', 't': 2}, {'phase': 'approach', 't': '0.5'}],
                               5)[0]['phase'] == 'approach'
    with pytest.raises(ValueError):
        phases.clean_manual([{'phase': 'dance', 't': 1}], 5)
    with pytest.raises(ValueError):
        phases.clean_manual([{'phase': 'lift', 't': 9}], 5)


def test_episode_has_markers_and_manual_override(env):  # noqa: F811
    svc, _, tmp = env
    plan = approved_plan(svc, n=1)
    record_one(svc, tmp, plan, 'E001')
    ds_id = 'tester/s101_dataset_red_cube'
    ep = svc.handle('data.episode', {'dataset_id': ds_id, 'episode_index': 0})
    assert 'auto' in ep['phases'] and ep['phases']['manual'] is None
    svc.handle('data.set_markers', {'dataset_id': ds_id, 'episode_index': 0,
                                    'markers': [{'phase': 'lift', 't': 1.0}]})
    ep = svc.handle('data.episode', {'dataset_id': ds_id, 'episode_index': 0})
    assert ep['phases']['manual'] == [{'phase': 'lift', 't': 1.0}]
    with pytest.raises(CommandError):
        svc.handle('data.set_markers', {'dataset_id': ds_id, 'episode_index': 0,
                                        'markers': [{'phase': 'lift', 't': 99}]})
    svc.handle('data.set_markers', {'dataset_id': ds_id, 'episode_index': 0, 'markers': None})
    ep = svc.handle('data.episode', {'dataset_id': ds_id, 'episode_index': 0})
    assert ep['phases']['manual'] is None


def test_targeted_plan_places_object_near_failures(env):  # noqa: F811
    svc, _, _ = env
    src = approved_plan(svc, n=4)
    obj = next(i for i in src['task']['items'] if i['role'] == 'object')
    ws = src['task']['workspace']
    px = (ws['x_min_mm'] + ws['x_max_mm']) / 2
    py = (ws['y_min_mm'] + ws['y_max_mm']) / 2
    out = svc.handle('plan.targeted', {'source_plan_id': src['id'], 'episodes': 6,
                                       'spread_mm': 20, 'points': [
                                           {'x_mm': px, 'y_mm': py, 'weight': 2},
                                           {'x_mm': px + 30, 'y_mm': py - 20}],
                                       'notes': 'focus on the left'})
    plan = out['plan']
    assert plan['status'] == 'draft' and plan['origin']['kind'] == 'targeted'
    assert len(plan['episodes']) == 6
    for e in plan['episodes']:
        p = next(x for x in e['placements'] if x['item_id'] == obj['id'])
        d = min(math.hypot(p['x_mm'] - px, p['y_mm'] - py),
                math.hypot(p['x_mm'] - px - 30, p['y_mm'] - py + 20))
        assert d <= 20.5 + 1e-6, (p, d)
        assert e['operator_notes'] == 'focus on the left'
    assert svc.handle('plan.get', {'plan_id': src['id']})['plan']['status'] == 'approved'
    with pytest.raises(CommandError):
        svc.handle('plan.targeted', {'source_plan_id': src['id'], 'points': []})
