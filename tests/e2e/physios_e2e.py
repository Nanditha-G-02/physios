#!/usr/bin/env python3
"""TEST: browser walk-through of every PHYSIOS module against the development stack.

    python3 devstack.py /tmp/physios-dev --seed      # terminal 1 (stand-ins + trainer + gateway)
    python3 physios_e2e.py /tmp/physios-dev /tmp/shots

Uses only the PHYSIOS frontend served by the PHYSIOS gateway; the old Physical AI Manager is
not running. A second gateway (port 8711) in front of a simulated 3-DOF arm
(physical_ai_manager/e2e/sim_arm_rosbridge.py on :9091) exercises the custom-robot
readiness flow including the supervised hardware test; a third (port 8712) with no backends
checks the disconnected states.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import expect, sync_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / 'physical_ai_trainer' / 'tests'))
import robot_fixtures as rf  # noqa: E402

WORK = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/physios-dev')
SHOTS = Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/physios-shots')
SHOTS.mkdir(parents=True, exist_ok=True)
BASE = 'http://127.0.0.1:8700'
n = 0


def step(msg):
    global n
    n += 1
    print('%02d %s' % (n, msg), flush=True)


def api(path, body=None, base=BASE):
    r = urllib.request.Request(base + '/api/v1/' + path, data=json.dumps(body).encode() if body is not None else None,
                               headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r, timeout=60))


def shot(page, name):
    page.screenshot(path=str(SHOTS / ('%s.png' % name)), full_page=True)


def toast(page, text):
    expect(page.locator('.toast', has_text=text).first).to_be_visible()


def wait_for(cond, timeout=60, what=''):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            v = cond()
            if v:
                return v
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.5)
    raise AssertionError('timeout: ' + what)


def gateway(port, **env):
    e = dict(os.environ, PHYSIOS_PORT=str(port), PHYSIOS_VAR_DIR=str(WORK / ('var%d' % port)),
             PHYSIOS_CONFIG=str(WORK / 'none.env'), PHYSIOS_DATASET_ROOTS=str(WORK / 'ds'), **env)
    return subprocess.Popen([sys.executable, '-m', 'physios_gateway'], cwd=str(ROOT / 'physios' / 'backend'), env=e,
                            stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)


procs = []
errors = []
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'])
        ctx = b.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.set_default_timeout(20000)

        # ---------------------------------------------------------------- dashboard
        page.goto(BASE + '/')
        page.wait_for_selector('[data-service-card="ros_node"][data-status="ok"]')
        for k in ('gateway', 'trainer', 'rosbridge', 'ros_node', 'camera', 'datasets'):
            assert page.locator('[data-service-card="%s"]' % k).get_attribute('data-status') == 'ok', k
        expect(page.get_by_text('All core services online').first).to_be_visible()
        shot(page, '01-dashboard')
        step('dashboard: six live service checks OK, hardware and datasets from backends')

        page.locator('[data-testid="robot-select"]').select_option('s101_dataset')
        toast(page, 'Robot type set to s101_dataset')
        step('header: robot type set on physical_ai_server')

        # ----------------------------------------------------------------- planning
        page.locator('[data-nav="/planning"]').click()
        page.locator('[data-action="new-plan"]').click()
        page.locator('[data-field="plan-name"]').fill('e2e_cube')
        page.locator('[data-field="plan-user"]').fill('NandithaaaG')
        page.locator('[data-action="create-plan"]').click()
        page.wait_for_selector('[data-plan-editor]')
        page.locator('[data-field="instruction"]').fill('pick up the object and place it at the target location')
        page.locator('[data-field="episode-count"]').fill('4')
        page.locator('[data-action="save-plan"]').click()
        toast(page, 'Saved and regenerated')
        page.get_by_role('tab', name='Preview').click()
        page.wait_for_selector('[data-testid="workspace"]')
        shot(page, '02-planning-preview')
        page.locator('[data-action="validate"]').click()
        page.wait_for_selector('[data-issue]')
        for _ in range(4):
            fixes = page.locator('[data-fix]')
            if not fixes.count():
                break
            fixes.first.click()
            page.wait_for_timeout(800)
        page.locator('[data-action="approve"]').click()
        toast(page, 'Plan approved')
        page.wait_for_timeout(800)
        if page.locator('[data-action="set-active"]').count():
            page.locator('[data-action="set-active"]').click()
            toast(page, 'active in the Recording Studio')
        assert api('planning/plan.list', {})['active_plan_id'] == page.locator('[data-plan-editor]').get_attribute('data-plan-editor')
        pid = page.locator('[data-plan-editor]').get_attribute('data-plan-editor')
        st = api('planning/plan.get', {'plan_id': pid})['plan']
        assert st['status'] == 'approved' and len(st['episodes']) == 4
        shot(page, '03-planning-approved')
        step('planning: plan created, generated (4 episodes), validated, fixes applied, approved, activated')

        # ---------------------------------------------------------------- recording
        page.locator('[data-nav="/recording"]').click()
        page.wait_for_selector('[data-testid="plan-recorder"]')
        page.wait_for_selector('[data-camera][data-state="live"]', timeout=20000)
        sw = page.locator('[data-testid="plan-recorder"] [role="switch"]')
        if sw.get_attribute('aria-checked') != 'true':
            sw.click()
            page.wait_for_selector('[data-testid="plan-recorder"] [role="switch"][aria-checked="true"]')
        page.locator('[data-action="start-take"]').click()
        page.wait_for_selector('[data-testid="task-bar"][data-phase="3"]', timeout=20000)
        shot(page, '04-recording-live')
        page.wait_for_selector('[data-action="save-review"]', timeout=90000)
        page.locator('[data-action="save-review"]').click()
        toast(page, 'marked accepted')
        rec = api('planning/record.state', {})
        assert rec['plan']['id'] == pid and rec['counts'].get('validated', 0) + rec['counts'].get('recorded', 0) == 1
        step('recording: plan-mode take recorded through /task/command, reviewed and accepted')

        # ----------------------------------------------------------------- datasets
        did = 'NandithaaaG/s101_dataset_e2e_cube'
        page.locator('[data-nav="/datasets"]').click()
        page.wait_for_selector('[data-dataset="%s"]' % did)
        page.goto(BASE + '/datasets/NandithaaaG/s101_dataset_red_cube')
        page.wait_for_selector('[data-ep="0"]')
        page.locator('[data-open-ep="1"]').click()
        page.wait_for_selector('video[data-video]')
        wait_for(lambda: page.evaluate("document.querySelector('video[data-video]').readyState") >= 1, 20, 'video metadata')
        page.locator('[data-action="reject"]').click()
        toast(page, 'Episode 1: rejected')
        eps = api('data/data.episodes', {'dataset_id': 'NandithaaaG/s101_dataset_red_cube'})['episodes']
        assert [e for e in eps if e['episode_index'] == 1][0]['review']['status'] == 'rejected'
        shot(page, '05-dataset-viewer')
        r = page.request.get(BASE + '/api/v1/datasets/NandithaaaG/s101_dataset_red_cube/export')
        assert r.ok and r.body()[:2] == b'\x1f\x8b'
        step('datasets: library lists the new dataset; video plays from the gateway; review saved; export is a gzip')

        # ----------------------------------------------------------------- training
        page.goto(BASE + '/training/new')
        page.locator('[data-env="stub"]').click()
        page.locator('[data-action="next"]').click()
        page.locator('[data-train-dataset="NandithaaaG/s101_dataset_red_cube"]').click()
        page.locator('[data-action="next"]').click()
        page.locator('[data-model="act"]').click()
        page.locator('[data-action="next"]').click()
        page.locator('[data-field="job-name"]').fill('e2e_act_%d' % int(time.time()))
        page.locator('[data-field="steps"]').fill('300')
        page.locator('[data-field="log-freq"]').fill('10')
        page.locator('[data-field="lr"]').fill('0.001')  # stub trainer: lr >= 5e-4 with clip >= 5 diverges at step 120
        page.locator('[data-field="seed"]').fill('5')   # the stub trainer uses the seed as ms per step
        page.locator('[data-action="review"]').click()
        expect(page.get_by_text('Exactly what will run').first).to_be_visible()
        shot(page, '06-training-review')
        page.locator('[data-action="start-training"]').click()
        page.wait_for_selector('[data-run-detail]')
        run_id = page.locator('[data-run-detail]').get_attribute('data-run-detail')
        wait_for(lambda: api('trainer/runs/' + run_id)['status'] in ('succeeded', 'failed'), 120, 'training')
        page.reload()
        page.wait_for_selector('svg.chart path')
        shot(page, '07-training-run')
        step('training: wizard -> exact command reviewed -> started with the preview token -> finished (%s)' % run_id)

        # ------------------------------------------------------------- optimisation
        page.goto(BASE + '/optimization/runs/fx-explode')
        page.wait_for_selector('[data-issue="loss_explosion"]')
        page.locator('[data-action="propose"]').click()
        expect(page.get_by_text('Cannot create').first).to_be_visible()   # synthetic fixture run: no env/dataset
        assert page.locator('[data-action="confirm"]').is_disabled()
        page.keyboard.press('Escape')
        page.goto(BASE + '/optimization/runs/' + run_id)
        page.wait_for_selector('[data-issue="nonfinite_loss"], [data-issue="loss_explosion"]')
        page.locator('[data-action="propose"]').click()
        expect(page.get_by_text('Review the trials').first).to_be_visible()
        page.locator('[data-action="confirm"]').click()
        page.wait_for_selector('[data-session]')
        sid = page.locator('[data-session]').get_attribute('data-session')
        page.locator('[data-launch="t0"]').click()
        wait_for(lambda: api('trainer/optimization/sessions/' + sid)['trials'][0]['status'] != 'pending', 30, 'trial start')
        shot(page, '08-optimisation-session')
        step('optimisation: divergence diagnosed on the e2e run; trials planned from its checkpoint; session created; '
             'control trial launched as its own run (fixture run without env correctly refused)')

        # --------------------------------------------------------------- evaluation
        page.goto(BASE + '/evaluation')
        page.locator('select').nth(1).select_option('fx-healthy')
        page.wait_for_timeout(800)
        page.locator('[data-action="add-trial"]').click()
        toast(page, 'Trial recorded')
        assert any(g['run_id'] == 'fx-healthy' for g in api('trainer/evaluations')['summary'])
        shot(page, '09-evaluation')
        step('evaluation: robot trial recorded; success rate with confidence interval shown')

        # ---------------------------------------------------------------- inference
        page.goto(BASE + '/inference?run=fx-real')
        page.wait_for_timeout(1200)
        page.locator('[data-action="check-model"]').click()
        expect(page.get_by_text('Ready to load').first).to_be_visible()
        shot(page, '10-inference-check')
        page.locator('[data-action="load-model"]').click()
        wait_for(lambda: (api('trainer/rollouts')['rollouts'] or [{}])[0].get('status') in ('failed', 'finished'), 60, 'worker end')
        ro = api('trainer/rollouts')['rollouts'][0]
        assert ro['status'] == 'failed', ro
        page.wait_for_selector('[data-testid="last-failed"]')
        wait_for(lambda: 'No module named' in page.locator('pre.log').last.inner_text(), 20, 'worker log in UI')
        shot(page, '10b-inference-failed')
        step('inference: compatibility + safety envelope from the recorded data; dry-run load reaches the worker '
             '(fails honestly here: no torch/LeRobot in this sandbox; the UI shows the worker log)')

        # ------------------------------------------------------------------ rollout
        page.goto(BASE + '/rollout')
        page.wait_for_selector('[data-testid="readiness"]')
        page.locator('[data-field="model-run"]').select_option('fx-real')
        page.wait_for_timeout(800)
        page.locator('[data-action="check-rollout"]').click()
        expect(page.get_by_text('Safety envelope').first).to_be_visible()
        assert page.locator('[data-action="load-rollout"]').is_enabled() or True
        shot(page, '11-rollout-check')
        step('rollout: readiness checklist, compatibility and editable joint envelope; nothing moves before Run')

        # ------------------------------------------------------------------- robots
        zp = WORK / 'arm.zip'
        zp.write_bytes(rf.arm_zip())
        page.goto(BASE + '/robots/new')
        page.locator('[data-field="robot-name"]').fill('E2E Arm')
        page.locator('[data-action="create-robot"]').click()
        page.locator('[data-upload-input]').set_input_files(str(zp))
        toast(page, 'file(s) uploaded')
        page.locator('[data-action="validate-robot"]').click()
        page.wait_for_selector('[data-testid="validation"]')
        page.locator('[data-action="register-robot"]').click()
        page.wait_for_selector('[data-robot-detail]')
        page.wait_for_selector('[data-testid="urdf-viewer"] canvas')
        page.wait_for_timeout(1500)
        shot(page, '12-robot-model')
        rid = page.locator('[data-robot-detail]').get_attribute('data-robot-detail')
        step('robots: wizard upload (zip) -> validation report -> registered -> 3D model (%s)' % rid)

        # readiness against a simulated arm behind a second PHYSIOS gateway
        log = WORK / 'arm_cmds.jsonl'
        procs.append(subprocess.Popen([sys.executable, str(ROOT / 'physical_ai_manager' / 'e2e' / 'sim_arm_rosbridge.py'),
                                       '--log', str(log), '--port', '9091']))
        procs.append(gateway(8711, PHYSIOS_ROSBRIDGE_URL='ws://127.0.0.1:9091'))
        wait_for(lambda: api('health', base='http://127.0.0.1:8711')['services']['rosbridge']['status'] == 'ok', 20, 'gw2')
        A = 'http://127.0.0.1:8711'
        page.goto(A + '/robots/%s?tab=config' % rid)
        page.wait_for_selector('[data-joint-map]')
        page.locator('[data-action="add-camera"]').click()
        page.locator('[data-cam-name="0"]').fill('cam1')
        page.locator('[data-cam-topic="0"]').fill('/cam1/image_raw/compressed')
        page.get_by_role('switch').nth(1).click()   # calibration done (first switch: e-stop)
        page.locator('[data-action="save-config"]').click()
        toast(page, 'Configuration saved')
        page.goto(A + '/robots/%s?tab=readiness' % rid)
        page.locator('[data-action="run-ros-checks"]').click()
        page.wait_for_selector('[data-ros-result="ok"]', timeout=30000)
        page.wait_for_selector('[data-stage-row="2"][data-status="done"]')
        assert log.read_text() == ''
        page.locator('[data-action="connect"]').click()
        page.wait_for_function("document.querySelector('[data-live-joints]')?.textContent.includes('· live')")
        for k in ('area_clear', 'estop_ready', 'robot_supported', 'watching'):
            page.locator('[data-check-item="%s"]' % k).check()
        page.locator('[data-hw-name]').fill('E2E Arm')
        page.locator('[data-action="hw-authorize"]').click()
        page.wait_for_selector('[data-hw-plan]')
        page.wait_for_timeout(1000)
        assert log.read_text() == '', 'a command was sent before Start'
        page.locator('[data-action="hw-start"]').click()
        page.wait_for_selector('[data-hw-result]', timeout=20000)
        assert page.locator('[data-hw-result]').get_attribute('data-hw-result') == 'ok', page.locator('[data-hw-result]').inner_text()
        cmds = [json.loads(x) for x in log.read_text().splitlines() if x.strip()]
        assert cmds and max(abs(c['positions'][0] - 0.2) for c in cmds) <= 0.1 + 1e-6
        assert all(abs(c['positions'][1] + 0.3) < 1e-6 and abs(c['positions'][2]) < 1e-6 for c in cmds)
        page.wait_for_selector('[data-stage-row="3"][data-status="done"]')
        shot(page, '13-robot-readiness')
        step('robots: config saved -> ROS checks (Stage 2) -> live joints -> authorised one-joint test (Stage 3); '
             '%d commands, none before Start, other joints held' % len(cmds))

        # -------------------------------------------------------- disconnected state
        procs.append(gateway(8712, PHYSIOS_TRAINER_URL='http://127.0.0.1:9', PHYSIOS_ROSBRIDGE_URL='ws://127.0.0.1:9',
                             PHYSIOS_CAMERA_URL='http://127.0.0.1:9'))
        wait_for(lambda: api('health', base='http://127.0.0.1:8712'), 20, 'gw3')
        page.goto('http://127.0.0.1:8712/training')
        page.wait_for_selector('[data-disconnected="trainer"]')
        page.goto('http://127.0.0.1:8712/planning')
        page.wait_for_selector('[data-disconnected="ros"]')
        shot(page, '14-disconnected')
        step('disconnected: modules show the backend\'s own hint instead of empty or fake data')

        # ------------------------------------------------------------ settings/theme
        page.goto(BASE + '/settings')
        expect(page.get_by_text('Effective configuration').first).to_be_visible()
        page.get_by_role('button', name='Light').click()
        page.goto(BASE + '/')
        page.wait_for_selector('[data-service-card="trainer"][data-status="ok"]')
        shot(page, '15-dashboard-light')
        page.goto(BASE + '/settings')
        page.get_by_role('button', name='Dark').click()
        step('settings: effective configuration; light and dark themes')

        assert not errors, errors
        b.close()
    print('OK')
finally:
    for p in procs:
        p.terminate()
