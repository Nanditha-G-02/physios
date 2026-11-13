# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

import copy
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from physical_ai_server.planning import engine, geometry as geo, profiles, validation  # noqa


def base_task(robot='s101_dataset', n=30):
    ws = profiles.default_workspace(robot)
    ws['verified'] = True
    return {
        'name': 'red_cube', 'instruction': 'Pick up the {object} and place it in the {target}.',
        'robot_type': robot, 'user_id': 'tester',
        'items': [
            {'id': 'obj1', 'name': 'red cube', 'role': 'object', 'size_mm': 30},
            {'id': 'tgt1', 'name': 'tray', 'role': 'target', 'size_mm': 90},
        ],
        'workspace': ws, 'regions': profiles.default_regions(ws), 'episode_count': n,
        'demo_types': ['standard'],
        'recording': {'fps': 30, 'warmup_s': 3, 'episode_s': 20, 'reset_s': 0},
    }


def make_plan(stype, n=30, **param_overrides):
    task = base_task(n=n)
    params = engine.default_params(stype, task)
    params.update(param_overrides)
    plan = {'task': task, 'strategy': {'type': stype, 'seed': 3, 'params': params},
            'episodes': []}
    plan['episodes'] = engine.generate(plan)
    return plan


def placement(ep, role):
    return next(p for p in ep['placements'] if p['role'] == role)


@pytest.mark.parametrize('stype', engine.STRATEGY_TYPES)
def test_every_strategy_generates_valid_plan(stype):
    plan = make_plan(stype)
    assert len(plan['episodes']) == 30
    assert len({e['id'] for e in plan['episodes']}) == 30
    result = validation.validate(plan)
    errors = [i for i in result['issues'] if i['severity'] == 'error']
    assert result['ok'], errors
    for e in plan['episodes']:
        assert e['instruction'] == 'Pick up the red cube and place it in the tray.'
        for p in e['placements']:
            assert not geo.point_problems(p['x_mm'], p['y_mm'], plan['task']['workspace'])


def test_static_is_identical_every_episode():
    plan = make_plan('static')
    setups = {tuple((p['x_mm'], p['y_mm']) for p in e['placements']) for e in plan['episodes']}
    assert len(setups) == 1


def test_semi_dynamic_object_fixed_target_varies():
    plan = make_plan('semi_dynamic', n=9)
    objs = {(placement(e, 'object')['x_mm'], placement(e, 'object')['y_mm'])
            for e in plan['episodes']}
    tgts = {placement(e, 'target')['region'] for e in plan['episodes']}
    assert len(objs) == 1
    assert tgts == {'L', 'C', 'R'}


def test_dynamic_is_balanced_over_region_combinations():
    plan = make_plan('dynamic', n=27)
    summary = engine.summarize(plan)
    counts = list(summary['by_region_combo'].values())
    assert len(counts) == 9 and max(counts) - min(counts) <= 1
    v = validation.validate(plan)
    assert not [i for i in v['issues'] if i['code'] == 'unbalanced']


def test_dynamic_warns_when_episodes_cannot_cover_combinations():
    plan = make_plan('dynamic', n=5)
    codes = {i['code'] for i in validation.validate(plan)['issues']}
    assert 'coverage' in codes


def test_dynamic_yaw_and_distance_bands():
    task = base_task(n=12)
    params = engine.default_params('dynamic', task)
    params['items']['obj1']['yaw'] = {'mode': 'set', 'values': [0, 90]}
    params['items']['obj1']['regions'] = ['C']
    params['items']['tgt1']['regions'] = ['L', 'R']
    params['distance_bands'] = [{'min_mm': 80, 'max_mm': 400}]
    plan = {'task': task, 'strategy': {'type': 'dynamic', 'seed': 1, 'params': params}}
    plan['episodes'] = engine.generate(plan)
    yaws = {placement(e, 'object')['yaw_deg'] for e in plan['episodes']}
    assert yaws == {0, 90}


def test_randomized_respects_constraints_and_seed():
    plan = make_plan('randomized', n=40)
    for e in plan['episodes']:
        o, t = placement(e, 'object'), placement(e, 'target')
        assert geo.dist(o['x_mm'], o['y_mm'], t['x_mm'], t['y_mm']) >= 80
    again = make_plan('randomized', n=40)
    assert [e['placements'] for e in again['episodes']] == \
        [e['placements'] for e in plan['episodes']]


def test_scenario_counts_and_interleaving():
    plan = make_plan('scenario', n=20)
    kinds = [e['scenario']['id'] for e in plan['episodes']]
    assert kinds.count('normal') == 10 and kinds.count('recovery') == 5
    # interleaved: recoveries are not all bunched at the end
    assert 'recovery' in kinds[:8]
    assert all(e['operator_notes'] for e in plan['episodes'] if e['scenario']['id'] != 'normal')


def test_scenario_count_mismatch_has_fix():
    plan = make_plan('scenario', n=20)
    plan['strategy']['params']['scenarios'][0]['count'] = 3
    issue = next(i for i in validation.validate(plan)['issues']
                 if i['code'] == 'scenario_counts')
    fixed = validation.apply_fix(plan, issue['fix'])
    assert sum(s['count'] for s in fixed['strategy']['params']['scenarios']) == 20


def test_out_of_reach_is_detected_and_fixed():
    plan = make_plan('static', n=3)
    ep = plan['episodes'][1]
    o = placement(ep, 'object')
    o['x_mm'], o['y_mm'] = 500, 0
    v = validation.validate(plan)
    issue = next(i for i in v['issues'] if i.get('episode_id') == ep['id'])
    assert issue['severity'] == 'error' and issue['fix']['op'] == 'set_placement'
    fixed = validation.apply_fix(plan, issue['fix'])
    assert validation.validate(fixed)['ok']
    # other episodes untouched
    assert fixed['episodes'][0] == plan['episodes'][0]


def test_overlap_detected():
    plan = make_plan('static', n=2)
    ep = plan['episodes'][0]
    o, t = placement(ep, 'object'), placement(ep, 'target')
    o['x_mm'], o['y_mm'] = t['x_mm'] + 10, t['y_mm']
    v = validation.validate(plan)
    issue = next(i for i in v['issues'] if i['code'] == 'overlap')
    fixed = validation.apply_fix(plan, issue['fix'])
    assert not [i for i in validation.validate(fixed)['issues'] if i['code'] == 'overlap']


def test_sequence_consistency_fix():
    plan = make_plan('sequential', n=2)
    ep = plan['episodes'][0]
    ep['sequence'] = [{'id': 'a', 'action': 'place', 'item_id': 'obj1', 'target_id': 'tgt1'}]
    v = validation.validate(plan)
    issue = next(i for i in v['issues'] if i['code'] == 'place_without_pick')
    fixed = validation.apply_fix(plan, issue['fix'])
    assert [s['action'] for s in fixed['episodes'][0]['sequence']] == ['pick', 'place']
    assert not [i for i in validation.validate(fixed)['issues']
                if i['code'] == 'place_without_pick']


def test_keep_edited_on_regenerate():
    plan = make_plan('dynamic', n=9)
    ep = copy.deepcopy(plan['episodes'][4])
    ep['instruction'] = 'custom'
    ep['edited'] = True
    plan['episodes'][4] = ep
    plan['strategy']['seed'] = 99
    regenerated = engine.generate(plan, keep_edited=True)
    assert regenerated[4]['instruction'] == 'custom'


def test_completeness_errors_and_task_name_fix():
    plan = make_plan('static', n=2)
    plan['task']['name'] = 'red cube!'
    plan['task']['user_id'] = ''
    v = validation.validate(plan)
    codes = {i['code'] for i in v['issues']}
    assert {'task_name_chars', 'missing_user_id'} <= codes
    fix = next(i for i in v['issues'] if i['code'] == 'task_name_chars')['fix']
    assert validation.apply_fix(plan, fix)['task']['name'] == 'red_cube'


def test_non_pick_task_without_target():
    task = base_task(n=4)
    task['items'] = [{'id': 'door', 'name': 'drawer', 'role': 'object', 'size_mm': 60}]
    task['instruction'] = 'Open the {object}.'
    params = engine.default_params('sequential', task)
    params['sequence'] = [{'id': 'a', 'action': 'push', 'item_id': 'door'},
                          {'id': 'b', 'action': 'return_home'}]
    plan = {'task': task, 'strategy': {'type': 'sequential', 'seed': 0, 'params': params}}
    plan['episodes'] = engine.generate(plan)
    assert plan['episodes'][0]['instruction'] == 'Open the drawer.'
    assert validation.validate(plan)['ok']


def test_profiles_match_robot_names():
    assert profiles.profile_key_for_robot('s101_dataset') == 'so101'
    assert profiles.profile_key_for_robot('so101_follower') == 'so101'
    assert profiles.profile_key_for_robot('omx_f') == 'omx'
    assert profiles.profile_key_for_robot('ffw_sg2_rev1') == 'ffw'
    assert profiles.profile_key_for_robot('mystery') == 'generic'
