#!/usr/bin/env python3
"""TEST / DEVELOPMENT STACK - not part of the product.

Runs PHYSIOS against stand-ins of the robot side so the whole application can be exercised
on a machine without ROS or a GPU:

* tests/e2e/standin_server.py - rosbridge protocol on :9090 whose
  /planning/command and /data/command run the REAL PlanningService, a simulated recorder
  that writes LeRobot episodes (ffmpeg test videos), MJPEG on :8080, synthetic JointState;
* the REAL physios_trainer on :8766 with a stub lerobot environment (backend/trainer_tests/stub_train.py
  produces loss curves and checkpoints) and fixture runs;
* the REAL PHYSIOS gateway on :8700.

    python3 devstack.py <workdir> [--seed]      # Ctrl+C stops everything

``--seed`` records three episodes through the gateway API (plan -> approve -> record), which
is also an end-to-end test of the ROS adapter.
"""

import argparse
import json
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]                               # the PHYSIOS repository
sys.path.insert(0, str(ROOT / 'backend' / 'trainer_tests'))
GW = 'http://127.0.0.1:8700/api/v1/'


def api(path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(GW + path, data=data, headers={'Content-Type':
                                                                 'application/json'})
    try:
        return json.load(urllib.request.urlopen(req, timeout=timeout))
    except urllib.error.HTTPError as e:
        raise RuntimeError('%s -> %s %s' % (path, e.code, e.read()[:400]))


def wait(cond, timeout=30, what=''):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            v = cond()
            if v:
                return v
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.4)
    raise SystemExit('timeout waiting for %s' % what)


def seed():
    api('ros/robot-type', {'robot_type': 's101_dataset'})
    plan = api('planning/plan.new', {'robot_type': 's101_dataset', 'user_id': 'NandithaaaG',
                                     'name': 'red_cube', 'strategy_type': 'dynamic'})['plan']
    plan['task']['instruction'] = 'pick up the object and place it at the target location'
    plan['task']['episode_count'] = 6
    plan['task']['recording'].update(warmup_s=1, episode_s=3, reset_s=1)
    api('planning/plan.save', {'plan': plan, 'regenerate': True})
    pid = plan['id']
    v = api('planning/plan.validate', {'plan_id': pid})['plan']['validation']
    for issue in v['issues']:
        if issue.get('fix'):
            try:
                api('planning/plan.apply_fix', {'plan_id': pid, 'fix': issue['fix']})
            except RuntimeError:
                pass
    api('planning/plan.approve', {'plan_id': pid})
    api('planning/plan.set_active', {'plan_id': pid})
    for _ in range(3):
        st = api('planning/record.state', {})
        eid = st['next_episode_id']
        begin = api('planning/record.begin', {'plan_id': pid, 'episode_id': eid})
        r = api('ros/task', {'command': 'start_record', 'task_info': begin['task_info']})
        assert r['success'], r
        wait(lambda: api('planning/record.state', {})['progress']['episodes'].get(eid, {})
             .get('status') in ('recorded', 'validated'), 60, 'episode %s' % eid)
        print('[devstack] recorded', eid, flush=True)
    return pid


def real_fixture(work):
    """A finished run whose checkpoint points at the recorded dataset, in an environment with
    a real Python (numpy, pyarrow; no LeRobot): rollout preparation (compatibility, safety
    limits from the data) runs for real; loading the model then fails honestly."""
    import fixtures as fx
    env = {'name': 'realpy', 'prefix': str(work / 'realpy'), 'lerobot': None}
    run = fx.write_run(work / 'training', 'fx-real', 'real_act', fx.synth_rows(30),
                       extra={'env': env})
    ds = work / 'ds' / 'NandithaaaG' / 's101_dataset_red_cube'
    for ck in (Path(run['output_dir']) / 'checkpoints').iterdir():
        if ck.name.isdigit():
            (ck / 'pretrained_model' / 'train_config.json').write_text(json.dumps({
                'dataset': {'root': str(ds), 'repo_id': 'NandithaaaG/s101_dataset_red_cube'},
                'policy': {'type': 'act'}}))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('work')
    ap.add_argument('--seed', action='store_true')
    ap.add_argument('--keep', action='store_true', help='do not wipe the work dir')
    a = ap.parse_args()
    import fixtures as fx  # backend/trainer_tests
    work = Path(a.work).resolve()
    if not a.keep:
        shutil.rmtree(work, ignore_errors=True)
    for d in ('plan', 'ds', 'training', 'data', 'var'):
        (work / d).mkdir(parents=True, exist_ok=True)
    env = fx.make_stub_env(work / 'stub_env', working_trainer=True)
    (work / 'realpy' / 'bin').mkdir(parents=True, exist_ok=True)
    if not (work / 'realpy' / 'bin' / 'python').exists():
        (work / 'realpy' / 'bin' / 'python').symlink_to(sys.executable)
    if not a.keep:
        fx.standard_fixture(work / 'training')
    py = sys.executable
    procs = []

    def spawn(argv, cwd, log, extra_env=None):
        import os
        e = dict(os.environ)
        e.update(extra_env or {})
        f = open(work / log, 'w')
        procs.append(subprocess.Popen(argv, cwd=str(cwd), stdout=f, stderr=subprocess.STDOUT,
                                      env=e))

    spawn([py, 'standin_server.py', '--data-root', str(work / 'plan'), '--dataset-root',
           str(work / 'ds')], HERE, 'standin.log')
    spawn([py, '-m', 'physios_trainer', '--data-root', str(work / 'data'), '--data-dir',
           str(work / 'training'), '--dataset-root', str(work / 'ds'), '--env',
           'stub=%s' % env, '--env', 'realpy=%s' % (work / 'realpy')],
          ROOT / 'backend', 'trainer.log')
    spawn([py, '-m', 'physios_gateway'], ROOT / 'backend', 'gateway.log',
          {'PHYSIOS_VAR_DIR': str(work / 'var'), 'PHYSIOS_DATASET_ROOTS': str(work / 'ds'),
           'PHYSIOS_DATA_DIR': str(work / 'data'),
           'PHYSIOS_CONFIG': str(work / 'none.env')})

    def stop(*_):
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    wait(lambda: api('health')['services']['ros_node']['status'] == 'ok', 40, 'stack')
    print('[devstack] up: http://127.0.0.1:8700', flush=True)
    if a.seed:
        seed()
        real_fixture(work)
        print('[devstack] seeded', flush=True)
    print('[devstack] READY', flush=True)
    while True:
        time.sleep(1)
        for p in procs:
            if p.poll() is not None:
                print('[devstack] a process exited (%s); see logs in %s' % (p.args[:3], work))
                stop()


if __name__ == '__main__':
    main()
