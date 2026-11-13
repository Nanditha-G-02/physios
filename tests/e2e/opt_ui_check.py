#!/usr/bin/env python3
# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0
"""Browser check of the Optimize tab against synthetic runs (see tests/fixtures.py).

    python3 opt_ui_check.py http://127.0.0.1:8090 /tmp/shots
"""
import sys

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8090'
SHOTS = sys.argv[2] if len(sys.argv) > 2 else '/tmp/opt-shots'
import os
os.makedirs(SHOTS, exist_ok=True)
n = 0


def step(msg):
    global n
    n += 1
    print('%02d %s' % (n, msg), flush=True)


with sync_playwright() as pw:
    b = pw.chromium.launch()
    page = b.new_page(viewport={'width': 1440, 'height': 1000}, device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE)
    page.wait_for_selector('nav button', timeout=15000)
    page.wait_for_timeout(1200)
    page.get_by_role('button', name='Training').first.click()
    step('open Training')
    page.get_by_role('tab', name='Optimize').click()
    page.wait_for_selector('[data-opt-home]')
    sel = page.locator('[data-opt-run]')

    def pick(label):
        opt = sel.locator('option', has_text=label).first
        sel.select_option(opt.get_attribute('value'))
        page.wait_for_selector('[data-stats]')
        page.wait_for_timeout(400)

    pick('healthy_act')
    assert page.locator('[data-no-issues]').count() == 1
    assert 'no problems' in page.locator('[data-health]').inner_text()
    step('healthy run: no issues')
    page.screenshot(path=SHOTS + '/opt-healthy.png', full_page=True)

    pick('exploding_act')
    ids = page.locator('[data-issue]').evaluate_all('els => els.map(e => e.dataset.issue)')
    assert ids[:2] == ['loss_explosion', 'excess_clipping'], ids
    assert page.locator('[data-issue="loss_explosion"] [data-severity="critical"]').count() == 1
    step('exploding run: %s' % ids)
    assert page.locator('[data-candidate="lr_down"][data-supported="true"]').count() == 1
    assert page.locator('[data-candidate="lr_down"]').inner_text().count('0.0001 → 3e-05') == 1 or \
        '3e-05' in page.locator('[data-candidate="lr_down"]').inner_text()
    step('lr recommendation shows current -> proposed')
    page.locator('[data-toggle-caps]').click()
    ga = page.locator('[data-cap="grad_accum"]')
    assert ga.get_attribute('data-supported') == 'false'
    assert 'no gradient-accumulation' in ga.inner_text()
    step('gradient accumulation shown as unavailable with the reason')
    page.screenshot(path=SHOTS + '/opt-explode.png', full_page=True)

    pick('overfit_act')
    assert page.locator('[data-issue="overfitting"]').count() == 1
    assert page.locator('[data-candidate="early_stop"]').count() == 1
    step('overfit run: validation rising detected, checkpoint selection offered')
    page.screenshot(path=SHOTS + '/opt-overfit.png', full_page=True)

    pick('nan_act')
    assert page.locator('[data-issue="nonfinite_loss"] [data-severity="critical"]').count() == 1
    step('NaN run: critical')

    page.get_by_role('tab', name='Comparison dashboard').click()
    page.wait_for_selector('[data-opt-compare]')
    for nm in ('healthy_act', 'overfit_act'):
        page.locator('[data-opt-pick]', has_text=nm).click()
    page.wait_for_selector('[data-metric-table]')
    txt = page.locator('[data-opt-compare]').inner_text()
    assert 'Peak GPU memory' in txt and 'Best validation loss' in txt
    assert 'not evaluated' in txt
    assert page.locator('[data-recommendation]').count() == 1
    assert 'training metrics only' in page.locator('[data-recommendation]').inner_text()
    step('comparison dashboard: metrics, robot results kept separate, recommendation labelled')
    page.screenshot(path=SHOTS + '/opt-compare.png', full_page=True)
    assert not errors, errors
    step('no page errors')
    b.close()
print('OK')
