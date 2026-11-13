# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Host rollout worker - runs a trained checkpoint on the robot through ROS.

Started by the training service inside the operator's Python environment (the
same LeRobot that trained the model):

    python -I rollout_worker.py run <config.json>
    python -I rollout_worker.py limits <dataset_root> <out.json>

It talks to the robot ONLY through rosbridge, exactly like the Inference
session of physical_ai_server: it reads the camera topics and the follower
JointState topic and publishes trajectory_msgs/JointTrajectory on the leader
topic of the robot configuration. It never opens a serial port.

Safety is enforced here, before every publish:
  * joint position envelope (from the training data, possibly tightened by the operator)
  * maximum change per control step (speed) and maximum lead over the measured state
  * actions far outside the envelope stop the rollout instead of being clamped
  * stale camera / joint data -> hold
  * operator heartbeat missing -> hold
  * maximum duration
  * emergency stop / stop -> one "hold at the measured position" command, then exit
A hold command is the measured follower position, sent once; the bridge keeps
the arm there. Killing this process also stops all motion commands.
"""

import base64
import io
import json
import math
import os
import random
import socket
import struct
import sys
import threading
import time
from urllib.parse import urlparse

STATE = {'phase': 'starting'}


def now():
    return time.time()


# ---------------------------------------------------------------- websocket --
class WS:
    """Minimal RFC 6455 client (text frames, client masking) - stdlib only."""

    def __init__(self, url, timeout=5.0):
        u = urlparse(url)
        self.sock = socket.create_connection((u.hostname, u.port or 80), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = ('GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
               'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n' % (
                   u.path or '/', u.hostname, u.port or 80, key))
        self.sock.sendall(req.encode())
        resp = b''
        while b'\r\n\r\n' not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError('rosbridge closed the connection during the handshake')
            resp += chunk
        head, self.buf = resp.split(b'\r\n\r\n', 1)
        if b' 101 ' not in head.split(b'\r\n')[0]:
            raise ConnectionError('rosbridge refused the websocket: %r' % head[:80])
        self.sock.settimeout(None)
        self.lock = threading.Lock()

    def send(self, obj):
        data = json.dumps(obj).encode()
        hdr = bytearray([0x81])
        n = len(data)
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126)
            hdr += struct.pack('>H', n)
        else:
            hdr.append(0x80 | 127)
            hdr += struct.pack('>Q', n)
        mask = os.urandom(4)
        hdr += mask
        body = _mask_fast(data, mask)
        with self.lock:
            self.sock.sendall(bytes(hdr) + body)

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError('rosbridge connection closed')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        parts = []
        while True:
            b0, b1 = self._read(2)
            op = b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack('>H', self._read(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', self._read(8))[0]
            if b1 & 0x80:
                mask = self._read(4)
                payload = _mask_fast(self._read(n), mask)
            else:
                payload = self._read(n)
            if op == 0x8:
                raise ConnectionError('rosbridge closed the connection')
            if op == 0x9:   # ping -> pong
                with self.lock:
                    self.sock.sendall(bytes([0x8A, 0x80]) + os.urandom(4))
                continue
            if op in (0x1, 0x2, 0x0):
                parts.append(payload)
                if b0 & 0x80:
                    return b''.join(parts)

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def _mask_fast(data, mask):
    import numpy as np
    a = np.frombuffer(data, dtype=np.uint8)
    m = np.frombuffer((mask * (len(data) // 4 + 1))[:len(data)], dtype=np.uint8)
    return (a ^ m).tobytes()


class Bridge:
    """Subscriptions + service calls over rosbridge."""

    def __init__(self, url):
        self.ws = WS(url)
        self.latest = {}       # topic -> (t_received, msg)
        self.responses = {}
        self.cv = threading.Condition()
        self.alive = True
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        try:
            while self.alive:
                m = json.loads(self.ws.recv())
                op = m.get('op')
                if op == 'publish':
                    self.latest[m['topic']] = (now(), m['msg'])
                elif op == 'service_response':
                    with self.cv:
                        self.responses[m.get('id')] = m
                        self.cv.notify_all()
        except Exception as e:  # noqa: BLE001
            self.error = str(e)
            self.alive = False

    def subscribe(self, topic, typ, throttle_ms=0):
        self.ws.send({'op': 'subscribe', 'topic': topic, 'type': typ,
                      'throttle_rate': throttle_ms, 'queue_length': 1})

    def advertise(self, topic, typ):
        self.ws.send({'op': 'advertise', 'topic': topic, 'type': typ})

    def publish(self, topic, msg):
        self.ws.send({'op': 'publish', 'topic': topic, 'msg': msg})

    def call(self, service, args=None, timeout=3.0):
        cid = 'pam-%d' % random.randint(0, 1 << 30)
        self.ws.send({'op': 'call_service', 'id': cid, 'service': service, 'args': args or {}})
        end = now() + timeout
        with self.cv:
            while cid not in self.responses and now() < end:
                self.cv.wait(end - now())
            r = self.responses.pop(cid, None)
        if r is None:
            raise TimeoutError('no answer from %s' % service)
        if r.get('result') is False:
            raise RuntimeError(str(r.get('values')))
        return r.get('values') or {}

    def close(self):
        self.alive = False
        self.ws.close()


# ------------------------------------------------------------------- limits --
def compute_limits(dataset_root):
    """Joint envelope and speed limits from the recorded demonstrations."""
    import glob
    import numpy as np
    import pyarrow.parquet as pq
    info = json.load(open(os.path.join(dataset_root, 'meta', 'info.json')))
    files = sorted(glob.glob(os.path.join(dataset_root, 'data', '**', '*.parquet'),
                             recursive=True))
    acts, sts, eps = [], [], []
    for f in files:
        t = pq.read_table(f, columns=[c for c in ('action', 'observation.state',
                                                  'episode_index')
                                      if c in pq.read_schema(f).names])
        d = t.to_pydict()
        acts += d['action']
        sts += d.get('observation.state') or d['action']
        eps += d['episode_index']
    a = np.asarray(acts, dtype=float)
    s = np.asarray(sts, dtype=float)
    e = np.asarray(eps)
    names = (info['features'].get('action') or {}).get('names') or \
        ['joint%d' % i for i in range(a.shape[1])]
    if isinstance(names, dict):
        names = next(iter(names.values()))
    lo = np.nanpercentile(a, 0.5, axis=0)
    hi = np.nanpercentile(a, 99.5, axis=0)
    span = np.maximum(hi - lo, 1e-6)
    same = e[1:] == e[:-1]
    step = np.abs(np.diff(a, axis=0))[same]
    lead = np.abs(a - s) if s.shape == a.shape else np.zeros_like(a)
    joints = []
    for j, n in enumerate(names):
        joints.append({
            'name': n,
            'min': round(float(lo[j] - 0.05 * span[j]), 4),
            'max': round(float(hi[j] + 0.05 * span[j]), 4),
            'data_min': round(float(np.nanmin(a[:, j])), 4),
            'data_max': round(float(np.nanmax(a[:, j])), 4),
            'max_step': round(float(max(np.nanpercentile(step[:, j], 99.9), 0.01 * span[j])),
                              4) if len(step) else round(float(0.05 * span[j]), 4),
            'max_lead': round(float(max(np.nanpercentile(lead[:, j], 99.9), 0.05 * span[j]) *
                                    1.2), 4),
        })
    return {'joints': joints, 'fps': info.get('fps'), 'frames': int(len(a)),
            'episodes': int(len(set(eps))), 'dataset_root': dataset_root,
            'computed_at': time.strftime('%Y-%m-%dT%H:%M:%S')}


# ----------------------------------------------------------------- run loop --
class Safety:

    def __init__(self, limits, speed_factor, fps):
        self.j = limits['joints']
        self.n = len(self.j)
        self.lo = [x['min'] for x in self.j]
        self.hi = [x['max'] for x in self.j]
        self.span = [max(x['max'] - x['min'], 1e-6) for x in self.j]
        f = max(0.05, min(1.0, float(speed_factor)))
        self.step = [x['max_step'] * f for x in self.j]
        self.lead = [x['max_lead'] for x in self.j]
        self.counts = {'clamped_range': 0, 'clamped_speed': 0, 'clamped_lead': 0}

    def check_state(self, state):
        bad = [self.j[i]['name'] for i in range(self.n)
               if state[i] < self.lo[i] - 0.15 * self.span[i] or
               state[i] > self.hi[i] + 0.15 * self.span[i]]
        return bad

    def filter(self, raw, prev_cmd, state):
        """Returns (safe action, list of notes) or raises StopIteration(reason)."""
        out = []
        notes = []
        for i in range(self.n):
            v = float(raw[i])
            if not math.isfinite(v):
                raise StopIteration('model produced a non-finite action for %s' %
                                    self.j[i]['name'])
            if v < self.lo[i] - 0.25 * self.span[i] or v > self.hi[i] + 0.25 * self.span[i]:
                raise StopIteration('model asked for %s = %.3f, far outside the allowed range '
                                    '%.3f..%.3f' % (self.j[i]['name'], v, self.lo[i], self.hi[i]))
            if v < self.lo[i] or v > self.hi[i]:
                v = min(self.hi[i], max(self.lo[i], v))
                self.counts['clamped_range'] += 1
                notes.append('range:' + self.j[i]['name'])
            ref = prev_cmd[i] if prev_cmd is not None else state[i]
            if abs(v - ref) > self.step[i]:
                v = ref + math.copysign(self.step[i], v - ref)
                self.counts['clamped_speed'] += 1
                notes.append('speed:' + self.j[i]['name'])
            if abs(v - state[i]) > self.lead[i]:
                v = state[i] + math.copysign(self.lead[i], v - state[i])
                self.counts['clamped_lead'] += 1
                notes.append('lead:' + self.j[i]['name'])
            out.append(v)
        return out, notes


def write_status(path, st):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(st, f)
    os.replace(tmp, path)


def read_control(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def decode_jpeg(b64):
    import numpy as np
    from PIL import Image
    data = base64.b64decode(b64) if isinstance(b64, str) else bytes(b64)
    return np.array(Image.open(io.BytesIO(data)).convert('RGB'))


def traj_msg(names, positions):
    return {'header': {'stamp': {'sec': 0, 'nanosec': 0}, 'frame_id': ''},
            'joint_names': list(names),
            'points': [{'positions': [float(p) for p in positions], 'velocities': [],
                        'accelerations': [], 'effort': [],
                        'time_from_start': {'sec': 0, 'nanosec': 0}}]}


def run(cfg_path):
    import numpy as np
    import torch
    cfg = json.load(open(cfg_path))
    st_path = cfg['status_file']
    ctl_path = cfg['control_file']
    status = {'phase': 'loading', 'step': 0, 'started_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
              'warnings': [], 'error': None, 'pid': os.getpid()}

    def push(**kw):
        status.update(kw)
        status['t'] = now()
        write_status(st_path, status)

    push()
    print('[rollout] loading %s' % cfg['checkpoint'], flush=True)
    try:
        from lerobot.policies.factory import get_policy_class, make_pre_post_processors
        from lerobot.configs.policies import PreTrainedConfig
        try:
            from lerobot.common.control_utils import predict_action
        except ImportError:
            from lerobot.utils.control_utils import predict_action
    except ImportError as e:
        push(phase='failed', error='This LeRobot cannot run policies here: %s' % e)
        return 2
    device = torch.device(cfg.get('device') or ('cuda' if torch.cuda.is_available() else 'cpu'))
    pcfg = PreTrainedConfig.from_pretrained(cfg['checkpoint'])
    pcfg.device = device.type
    policy = get_policy_class(pcfg.type).from_pretrained(cfg['checkpoint'], config=pcfg)
    policy.to(device)
    policy.eval()
    pre, post = make_pre_post_processors(
        policy_cfg=pcfg, pretrained_path=cfg['checkpoint'],
        preprocessor_overrides={'device_processor': {'device': device.type},
                                'rename_observations_processor': {
                                    'rename_map': cfg.get('rename_map') or {}}})
    in_feats = pcfg.input_features or {}
    img_keys = [k for k in in_feats if k.startswith('observation.images.')]
    print('[rollout] policy %s on %s; image inputs %s' % (pcfg.type, device, img_keys),
          flush=True)

    names = cfg['action_names']
    cams = cfg['cameras']             # dataset key -> topic
    safety = Safety(cfg['limits'], cfg.get('speed_factor', 0.5), cfg['fps'])
    if safety.n != len(names):
        push(phase='failed', error='Limits cover %d joints, the model outputs %d.' % (
            safety.n, len(names)))
        return 2
    push(phase='connecting')
    br = Bridge(cfg['rosbridge_url'])
    # ---- refuse to command if something else publishes on the leader topic
    others = []
    try:
        typ = br.call('/rosapi/topic_type', {'topic': cfg['action_topic']}).get('type')
        if typ and typ != 'trajectory_msgs/msg/JointTrajectory':
            push(phase='failed', error='%s has type %s; only JointTrajectory is supported.' % (
                cfg['action_topic'], typ))
            return 2
        pubs = br.call('/rosapi/publishers', {'topic': cfg['action_topic']}).get(
            'publishers') or []
        others = [p for p in pubs if 'rosbridge' not in p]
        status['other_publishers'] = others
    except (TimeoutError, RuntimeError) as e:
        status['warnings'].append('Could not ask rosapi who publishes on %s (%s).' % (
            cfg['action_topic'], e))
        if not cfg.get('allow_unverified_publishers'):
            push(phase='failed', error='Cannot verify that nothing else commands the arm '
                 '(rosapi not reachable). Start rosapi, or confirm this check manually.')
            return 2
    if others:
        push(phase='failed', error='Another node is already commanding the arm on %s: %s. '
             'Stop it (e.g. the Inference session or teleoperation) first.' % (
                 cfg['action_topic'], ', '.join(others)))
        return 2
    for topic in cams.values():
        br.subscribe(topic, 'sensor_msgs/msg/CompressedImage')
    br.subscribe(cfg['state_topic'], 'sensor_msgs/msg/JointState')
    br.advertise(cfg['action_topic'], 'trajectory_msgs/msg/JointTrajectory')

    period = 1.0 / float(cfg['fps'])
    stale = float(cfg.get('stale_s', 0.5))
    max_dur = float(cfg.get('max_duration_s', 60))
    hb_timeout = float(cfg.get('heartbeat_timeout_s', 2.0))
    prev_cmd = None
    run_started = None
    last_state = None
    held = False
    sizes = {}
    rate = []

    def hold(reason):
        nonlocal held
        if last_state is not None and not held:
            br.publish(cfg['action_topic'], traj_msg(names, last_state))
            held = True
            print('[rollout] HOLD at measured position (%s)' % reason, flush=True)

    def observe():
        nonlocal last_state
        t = now()
        sm = br.latest.get(cfg['state_topic'])
        if not sm or t - sm[0] > stale:
            return None, 'joint states stale'
        pos = dict(zip(sm[1].get('name') or [], sm[1].get('position') or []))
        missing = [n for n in cfg['state_names'] if n not in pos]
        if missing:
            return None, 'joint states lack %s' % ', '.join(missing)
        state = [float(pos[n]) for n in cfg['state_names']]
        last_state = [float(pos[n]) for n in names] if all(n in pos for n in names) else state
        obs = {'observation.state': np.asarray(state, dtype=np.float32)}
        for key, topic in cams.items():
            im = br.latest.get(topic)
            if not im or t - im[0] > stale:
                return None, 'camera %s stale' % key
            arr = decode_jpeg(im[1]['data'])
            sizes[key] = [int(arr.shape[1]), int(arr.shape[0])]
            want = (in_feats.get(rename_map_key(key)) or in_feats.get(key))
            if want is not None and list(want.shape)[-2:] != [arr.shape[0], arr.shape[1]]:
                raise StopIteration('camera %s delivers %dx%d but the model was trained on '
                                    '%dx%d' % (key, arr.shape[1], arr.shape[0],
                                               want.shape[-1], want.shape[-2]))
            obs[key] = arr
        return obs, None

    def rename_map_key(key):
        return (cfg.get('rename_map') or {}).get(key, key)

    push(phase='waiting_for_data')
    t0 = now()
    reason = None
    exit_code = 0
    preview_done = False
    try:
        while True:
            tick = now()
            ctl = read_control(ctl_path)
            cmd = ctl.get('command')
            if cmd in ('estop', 'stop'):
                hold('emergency stop' if cmd == 'estop' else 'stopped by operator')
                reason = 'Emergency stop' if cmd == 'estop' else 'Stopped by operator'
                break
            if not br.alive:
                reason = 'rosbridge connection lost: %s' % getattr(br, 'error', '')
                exit_code = 1
                break
            try:
                obs, why = observe()
            except StopIteration as e:
                hold(str(e))
                reason = str(e)
                exit_code = 1
                break
            running = status['phase'] in ('running', 'paused')
            if obs is None:
                if running:
                    hold(why)
                    push(phase='paused', pause_reason=why)
                elif now() - t0 > 20:
                    reason = 'No data from the robot for 20 s (%s).' % why
                    exit_code = 1
                    break
                else:
                    push(phase='waiting_for_data', pause_reason=why)
                time.sleep(0.05)
                continue
            bad = safety.check_state(last_state)
            if bad:
                hold('state out of range')
                reason = 'Measured position of %s is outside the allowed range; move the arm ' \
                    'by hand into the workspace first.' % ', '.join(bad)
                exit_code = 1
                break
            hb_age = now() - float(ctl.get('heartbeat') or 0)
            go = cmd == 'run'
            if go and status['phase'] in ('ready', 'paused', 'waiting_for_data'):
                if hb_age > hb_timeout:
                    push(phase='paused', pause_reason='operator page not connected')
                else:
                    if run_started is None:
                        run_started = now()
                        print('[rollout] RUN', flush=True)
                    else:
                        print('[rollout] resume', flush=True)
                    # (re)start from the measured position with a fresh action queue
                    policy.reset()
                    prev_cmd = None
                    held = False
                    status['phase'] = 'running'
                    status.pop('pause_reason', None)
            if status['phase'] == 'running' and hb_age > hb_timeout:
                hold('operator heartbeat lost')
                push(phase='paused', pause_reason='operator page not connected')
                continue
            if cmd == 'pause' and status['phase'] == 'running':
                hold('paused')
                push(phase='paused', pause_reason='paused by operator')
                continue
            if status['phase'] in ('waiting_for_data', 'loading', 'connecting'):
                status['phase'] = 'ready'
            if status['phase'] == 'ready':
                # dry run: predict once to show what would happen, publish nothing
                if not preview_done:
                    raw = predict_action(dict(obs), policy, device, pre, post,
                                         use_amp=False, task=cfg.get('task') or '',
                                         robot_type=cfg.get('robot_type') or '')
                    raw = raw.squeeze(0).detach().cpu().numpy().tolist() \
                        if hasattr(raw, 'detach') else list(raw)
                    try:
                        safe, notes = safety.filter(raw, None, last_state)
                        verdict = 'ok' if not notes else 'clamped'
                    except StopIteration as e:
                        safe, notes, verdict = None, [str(e)], 'unsafe'
                    policy.reset()
                    push(preview={'state': last_state, 'raw': raw, 'safe': safe,
                                  'notes': notes, 'verdict': verdict}, camera_sizes=sizes)
                    preview_done = True
                push()
                time.sleep(0.05)
                continue
            if status['phase'] != 'running':
                push()
                time.sleep(0.05)
                continue
            if now() - run_started > max_dur:
                hold('maximum duration')
                reason = 'Maximum duration (%.0f s) reached.' % max_dur
                break
            raw = predict_action(obs, policy, device, pre, post, use_amp=False,
                                 task=cfg.get('task') or '', robot_type=cfg.get('robot_type')
                                 or '')
            raw = raw.squeeze(0).detach().cpu().numpy().tolist() if hasattr(raw, 'detach') \
                else list(raw)
            try:
                safe, notes = safety.filter(raw, prev_cmd, last_state)
            except StopIteration as e:
                hold('unsafe action')
                reason = 'Stopped: %s.' % e
                exit_code = 1
                break
            br.publish(cfg['action_topic'], traj_msg(names, safe))
            prev_cmd = safe
            status['step'] += 1
            rate.append(now())
            rate[:] = [x for x in rate if rate[-1] - x < 2.0]
            push(last={'raw': raw, 'safe': safe, 'state': last_state, 'notes': notes},
                 clamps=safety.counts, elapsed_s=round(now() - run_started, 2),
                 rate_hz=round((len(rate) - 1) / max(1e-3, rate[-1] - rate[0]), 1)
                 if len(rate) > 1 else None)
            dt = period - (now() - tick)
            if dt > 0:
                time.sleep(dt)
    except Exception as e:  # noqa: BLE001
        hold('error')
        reason = 'Rollout error: %s: %s' % (type(e).__name__, e)
        exit_code = 1
    push(phase='finished' if exit_code == 0 else 'failed', end_reason=reason,
         error=reason if exit_code else None, finished_at=time.strftime('%Y-%m-%dT%H:%M:%S'),
         clamps=safety.counts)
    print('[rollout] end: %s' % reason, flush=True)
    time.sleep(0.2)
    br.close()
    return exit_code


def main():
    if len(sys.argv) >= 4 and sys.argv[1] == 'limits':
        res = compute_limits(sys.argv[2])
        with open(sys.argv[3], 'w') as f:
            json.dump(res, f)
        return 0
    if len(sys.argv) >= 3 and sys.argv[1] == 'run':
        return run(sys.argv[2])
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main())
