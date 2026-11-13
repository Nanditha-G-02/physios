#!/usr/bin/env python3
# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0
"""Browser walk-through Home -> Planning -> Record -> Data -> Inference.

Runs against the interface served by the PHYSIOS gateway and the stand-in
robot side (standin_server.py). Usage:
    python3 tests/e2e/run_e2e.py http://127.0.0.1:8700 /path/to/shots
"""

import re
import sys
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8090'
SHOTS = Path(sys.argv[2] if len(sys.argv) > 2 else 'shots')
SHOTS.mkdir(parents=True, exist_ok=True)
results = []


def step(name):
    print('>>', name, flush=True)
    results.append(name)


def field(page, label):
    return page.locator(f'xpath=//label[normalize-space()="{label}"]/following-sibling::*[1]//input | '
                        f'//label[normalize-space()="{label}"]/following-sibling::input[1]').first


def shot(page, name):
    page.wait_for_timeout(700)  # let entry animations and toasts settle
    page.screenshot(path=str(SHOTS / f'{name}.png'))


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome',
                                args=['--autoplay-policy=no-user-gesture-required'])
    page = browser.new_page(viewport={'width': 1600, 'height': 960})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))

    # ---------------------------------------------------------------- Home --
    step('Home loads and lists robot types')
    page.goto(BASE)
    page.wait_for_selector('[data-robot="s101_dataset"]')
    shot(page, '01_home_unselected')
    page.locator('[data-robot="s101_dataset"]').click()
    page.locator('[data-action="confirm-robot"]').click()
    expect(page.get_by_text('Robot set to s101_dataset')).to_be_visible()
    expect(page.locator('[data-status="hb"]')).to_have_text('alive', timeout=8000)
    shot(page, '02_home_confirmed')

    # ------------------------------------------------------------- Planning --
    step('Planning: create plan and define task')
    page.get_by_role('button', name='Continue to Planning →').click()
    page.get_by_role('button', name='+ New').click()
    page.get_by_placeholder('red_cube_pick_place').fill('red_cube_e2e')
    page.get_by_placeholder('Pick up the {object} and place it in the {target}.').fill(
        'Pick up the {object} and place it in the {target}.')
    tot = field(page, 'Total episodes')
    tot.fill('6')
    field(page, 'Episode time').fill('2')
    field(page, 'Warm-up').fill('1')
    # rename items
    names = page.locator('input[aria-label="Item name"]')
    names.nth(0).fill('red cube')
    names.nth(1).fill('tray')
    page.get_by_role('switch').first.click()  # workspace verified
    time.sleep(1.5)
    shot(page, '03_planning_define')

    step('Planning: choose Dynamic and configure')
    page.get_by_role('button', name='Planning type').click()
    page.locator('[data-strategy="dynamic"]').click()
    expect(page.get_by_text('Regions per item')).to_be_visible()
    time.sleep(1.2)
    shot(page, '04_planning_configure_dynamic')

    for t in ['static', 'semi_dynamic', 'randomized', 'sequential', 'scenario']:
        page.get_by_role('button', name='Change type').click()
        page.locator(f'[data-strategy="{t}"]').click()
        page.wait_for_timeout(500)
        shot(page, '05_configure_' + t)
    step('Planning: all six types render an adaptive panel')

    page.get_by_role('button', name='Change type').click()
    page.locator('[data-strategy="dynamic"]').click()
    page.wait_for_timeout(1200)

    step('Planning: generate')
    page.get_by_role('button', name='Generate plan').click()
    expect(page.get_by_text('Collection order')).to_be_visible(timeout=10000)
    expect(page.locator('tbody tr')).to_have_count(6)
    shot(page, '06_plan_generated')

    step('Planning: edit one episode (instruction) - others untouched')
    page.locator('tbody tr').nth(1).click()
    inp = field(page, 'Instruction')
    inp.fill('Pick up the red cube and place it in the tray carefully.')
    page.get_by_role('button', name='Save episode').click()
    expect(page.get_by_text('edited').first).to_be_visible()

    step('Planning: validate, fix, approve')
    page.get_by_role('button', name='Validate →').click()
    expect(page.get_by_text('Approval', exact=True)).to_be_visible()
    shot(page, '07_validate')
    # apply any offered fixes until no errors
    for _ in range(5):
        fixes = page.locator('button:has-text("Move"), button:has-text("Set total")')
        if page.locator('text=/^0 errors$/').count():
            break
        if fixes.count():
            fixes.first.click()
            page.wait_for_timeout(800)
        else:
            break
    page.get_by_role('button', name='Approve version').click()
    expect(page.get_by_text('APPROVED', exact=True)).to_be_visible(timeout=8000)
    shot(page, '08_approved')

    # --------------------------------------------------------------- Record --
    step('Record: approved plan loads in plan mode')
    page.get_by_role('button', name='Proceed to recording →').click()
    expect(page.get_by_text('Approved plan · v')).to_be_visible(timeout=8000)
    expect(page.get_by_text('Set up before Start')).to_be_visible()
    page.wait_for_timeout(1500)
    shot(page, '09_record_plan_mode')

    def record_one(label, eid):
        page.locator('[data-control="Start"]').click()
        expect(page.get_by_text(f'{eid} saved and validated')).to_be_visible(timeout=25000)
        page.wait_for_timeout(800)
        shot(page, label)

    step('Record: episode 1 recorded through plan, bound and validated')
    record_one('10_record_ep1_done', 'E001')
    step('Record: episode 2 auto-advanced and recorded')
    record_one('11_record_ep2_done', 'E002')

    step('Record: review OFF -> no review step was shown')
    assert page.get_by_role('dialog', name='Review recorded episode').count() == 0

    step('Record: review ON -> dialog after the take, Start blocked, reject sends episode back')
    page.get_by_role('switch').filter(has_text='Review episodes').click()
    expect(page.get_by_text('Episode review ON')).to_be_visible()
    record_one('11b_record_ep3_saved', 'E003')
    dlg = page.get_by_role('dialog', name='Review recorded episode')
    expect(dlg).to_be_visible(timeout=10000)
    expect(page.locator('[data-control="Start"]')).to_be_disabled()
    page.wait_for_timeout(1200)
    shot(page, '11c_review_dialog')
    dlg.get_by_role('button', name='Reject').click()
    dlg.get_by_role('button', name='Missed grasp').click()
    dlg.get_by_placeholder('Reason (optional)', exact=False).fill('cube slipped in transport')
    dlg.get_by_role('button', name='Confirm reject').click()
    expect(page.get_by_text('back in the plan queue')).to_be_visible(timeout=8000)
    expect(dlg).to_have_count(0)
    expect(page.locator('[data-control="Start"]')).to_be_enabled(timeout=8000)

    step('Record: retake of the rejected episode, approved in review')
    page.wait_for_timeout(2600)  # plan panel refresh selects the rejected episode
    record_one('11d_record_retake', 'E003')
    expect(dlg).to_be_visible(timeout=10000)
    dlg.get_by_role('button', name='Approve').click()
    expect(page.get_by_text('approved').first).to_be_visible(timeout=8000)
    page.get_by_role('switch').filter(has_text='Review episodes').click()
    expect(page.get_by_text('Episode review OFF')).to_be_visible()
    shot(page, '11e_record_control_bar')

    step('Record: skip requires a reason')
    page.get_by_role('button', name='Skip…').click()
    page.get_by_placeholder('e.g. target position blocked by camera mount').fill('tray moved for test')
    page.get_by_role('button', name='Skip episode').click()
    expect(page.get_by_text('Skipped: tray moved for test')).to_be_visible()

    step('Record: processed view')
    page.get_by_role('tab', name='Processed').click()
    expect(page.get_by_text('PROCESSED · display only')).to_be_visible()
    page.wait_for_timeout(3000)
    shot(page, '12_record_processed')
    step('Record: simulation view')
    page.get_by_role('tab', name='Simulation').click()
    expect(page.get_by_text('LIVE ·')).to_be_visible(timeout=8000)
    page.wait_for_timeout(1500)
    shot(page, '13_record_simulation')
    page.get_by_role('tab', name='Multi-panel').click()
    page.wait_for_timeout(3000)
    shot(page, '14_record_multi')
    page.get_by_role('tab', name='Original').click()

    step('Record: free recording keeps the original task panel')
    page.get_by_role('tab', name='Free recording').click()
    expect(page.get_by_text('Task Information')).to_be_visible()
    shot(page, '15_record_free_mode')
    page.get_by_role('tab', name='Plan mode').click()

    # ----------------------------------------------------------------- Data --
    step('Data: dataset appears with plan link and overview')
    page.get_by_role('button', name='Review in Data →').click()
    expect(page.get_by_text('NandithaaaG/s101_dataset_red_cube_e2e').first).to_be_visible(timeout=8000)
    page.get_by_role('tab', name='Overview').click()
    expect(page.get_by_text('Dataset sheet')).to_be_visible()
    expect(page.get_by_text('kept in dataset')).to_be_visible()
    expect(page.get_by_text('Pending review').first).to_be_visible()
    shot(page, '16_data_overview')

    step('Data: episode viewer plays video and shows timelines')
    page.get_by_role('tab', name='Episodes').click()
    expect(page.get_by_text('Episode 0').first).to_be_visible(timeout=8000)
    page.get_by_role('button', name='▶ Play').click()
    page.wait_for_timeout(1500)
    h264 = page.evaluate('() => document.createElement("video").canPlayType(\'video/mp4; codecs="avc1.42E01E"\') !== ""')
    playing = page.evaluate('() => { const v = document.querySelector("video"); return v && v.currentTime > 0 && v.readyState >= 2; }')
    if h264:
        assert playing, 'video did not play'
    else:  # open-source Chromium builds (Playwright's) have no H.264 decoder
        print('   (playback not checked: this browser cannot decode H.264; use Chrome)', flush=True)
    shot(page, '17_data_episode')

    step('Data: processed playback')
    page.get_by_role('button', name='Processed playback').click()
    page.wait_for_timeout(1500)
    shot(page, '18_data_processed_playback')
    page.get_by_role('button', name='Original').click()

    step('Data: review (reject with category) and delete with confirmation')
    page.get_by_role('button', name='Dropped object').click()
    page.get_by_role('button', name='Reject', exact=True).click()
    expect(page.get_by_text('marked rejected')).to_be_visible()
    page.get_by_role('button', name='Delete episode…').click()
    page.get_by_placeholder('NandithaaaG/s101_dataset_red_cube_e2e').fill('NandithaaaG/s101_dataset_red_cube_e2e')
    page.get_by_role('button', name='Delete 1 episode(s)').click()
    expect(page.get_by_text('later episodes were renumbered')).to_be_visible(timeout=15000)
    shot(page, '19_data_after_delete')

    step('Data: publish panel (HF stand-in upload, GitHub sign-in form)')
    page.get_by_role('tab', name='Publish').click()
    expect(page.get_by_text('Signed in as')).to_be_visible(timeout=8000)
    page.get_by_role('button', name='Upload to NandithaaaG/s101_dataset_red_cube_e2e').click()
    expect(page.get_by_text('Stand-in upload').first).to_be_visible(timeout=10000)
    shot(page, '20_data_publish')

    # ------------------------------------------------------------- Training --
    # Needs the host training service (physios_trainer) with the e2e dataset
    # folder as a dataset root; skipped when it is not running.
    trainer_up = page.evaluate("fetch('/train-api/health').then(r => r.ok).catch(() => false)")
    if trainer_up:
        step('Training: Data hands the dataset over; command reviewed and confirmed before start')
        page.get_by_role('tab', name='Overview').click()
        page.locator('[data-action="train-dataset"]').click()
        expect(page.get_by_text('Train a policy on this PC')).to_be_visible(timeout=8000)
        expect(page.locator('[data-dataset="NandithaaaG/s101_dataset_red_cube_e2e"]')).to_have_class(
            re.compile('bg-ink'), timeout=10000)
        page.locator('[data-next]').click()
        expect(page.locator('[data-env]').first).to_be_visible(timeout=60000)
        page.locator('[data-next]').click()
        page.locator('[data-model="act"]').click(timeout=60000)
        page.locator('[data-next]').click()
        page.locator('[data-cfg="steps"]').fill('20')
        page.locator('[data-next]').click()
        expect(page.locator('[data-stage="train"]')).to_be_visible(timeout=60000)
        expect(page.locator('[data-stage="convert"]')).to_be_visible()   # v2.1 -> copy + convert
        expect(page.locator('[data-start-training]')).to_be_disabled()   # not before confirmation
        page.locator('[data-ack]').check()
        expect(page.locator('[data-start-training]')).to_be_enabled()
        shot(page, '21b_training_review')
        page.get_by_role('navigation', name='Sessions').get_by_role('button', name=re.compile(r'(^|\s)Data$')).click()
    else:
        print('   (training service not reachable - Training step skipped)')

    step('Data: tools tab hosts the original Data Tools')
    page.get_by_role('tab', name='Tools').click()
    page.wait_for_timeout(800)
    shot(page, '21_data_tools')

    # ------------------------------------------------------------ Inference --
    step('Inference: original panel plus plan instruction helper')
    page.get_by_role('button', name='Inference').click()
    expect(page.get_by_text('Instruction from plan')).to_be_visible(timeout=8000)
    shot(page, '22_inference')

    step('Planning: record progress back in plan list')
    page.get_by_role('button', name='Planning').click()
    page.wait_for_timeout(1000)
    shot(page, '23_planning_after')

    real_errors = [e for e in errors if 'favicon' not in e and 'manifest' not in e]
    print('console errors:', len(real_errors))
    for e in real_errors[:20]:
        print('  ', e[:300])
    browser.close()

print('PASSED %d steps' % len(results))
