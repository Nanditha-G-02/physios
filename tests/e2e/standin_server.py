#!/usr/bin/env python3
# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0
"""TEST STAND-IN - not part of the product.

Emulates just enough of the robot side to drive the Physical AI Manager UI in a
browser without ROS:

* a rosbridge-protocol websocket on :9090 that serves the services/topics the
  UI uses.  /planning/command and /data/command are routed to the REAL
  ``physical_ai_server.planning`` PlanningService (same code as on the robot);
  only the ROS transport and the recorder are simulated;
* a web_video_server-like MJPEG endpoint on :8080 (synthetic frames);
* a follower JointState publisher (synthetic sine motion).

The simulated recorder appends synthetic episodes (ffmpeg test pattern videos)
to a LeRobot v2.1 folder so the Data session has real files to read.
"""

import argparse
import asyncio
import io
import json
import math
import os
from pathlib import Path
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import websockets

HERE = Path(__file__).resolve().parent
ROBOT_SRC = HERE.parents[1] / 'robot' / 'src'   # the PHYSIOS robot runtime sources
sys.path.insert(0, str(ROBOT_SRC / 'physical_ai_server'))
sys.path.insert(0, str(ROBOT_SRC / 'physical_ai_server' / 'test' / 'planning'))

from physical_ai_server.planning.service import PlanningService  # noqa: E402
from physical_ai_server.planning.store import Store  # noqa: E402
import synthetic  # noqa: E402

READY, WARMING_UP, RESETTING, RECORDING, SAVING, STOPPED = 0, 1, 2, 3, 4, 5


class Robot:
    def __init__(self, data_root, dataset_root):
        self.robot_type = ''
        self.recording = False
        self.dataset_root = Path(dataset_root)
        self.svc = PlanningService(
            store=Store(data_root), dataset_root=dataset_root,
            context={'get_robot_type': lambda: self.robot_type,
                     'is_recording': lambda: self.recording,
                     'robot_params': self.params},
            logger=print)
        self.clients = set()
        self.subs = {}  # ws -> set(topics)
        self.task = None
        self.cmd = None
        self.status = self._status(READY)
        self.hf_progress = None
        self.log = []
        self.command = None        # last JointTrajectory positions received on the leader topic
        self.command_t = 0.0
        self.commands_file = Path(os.environ.get('STANDIN_COMMANDS_FILE', '/tmp/standin_commands.jsonl'))

    def params(self):
        if not self.robot_type:
            return {}
        return {'camera_topic_list': ['global:/camera/color/image_raw/compressed',
                                      'gripper:/gripper_camera/color/image_raw/compressed'],
                'joint_topic_list': ['follower:/joint_states', 'leader:/leader/joint_trajectory'],
                'joint_list': ['leader'], 'observation_list': ['global', 'gripper', 'state'],
                'joint_order': {'leader': synthetic.JOINTS}}

    def _status(self, phase, ti=None, **kw):
        msg = {'task_info': ti or {'task_name': '', 'task_type': '', 'user_id': '',
                                    'task_instruction': [], 'policy_path': '',
                                    'record_inference_mode': False, 'fps': 30, 'tags': [],
                                    'warmup_time_s': 0, 'episode_time_s': 0, 'reset_time_s': 0,
                                    'num_episodes': 0, 'push_to_hub': False,
                                    'private_mode': False, 'use_optimized_save_mode': True,
                                    'record_rosbag2': False},
               'robot_type': self.robot_type, 'phase': phase, 'total_time': 0,
               'proceed_time': 0, 'current_episode_number': 0, 'current_scenario_number': 0,
               'current_task_instruction': '', 'encoding_progress': 0.0,
               'used_storage_size': 120.0, 'total_storage_size': 512.0, 'used_cpu': 23.0,
               'used_ram_size': 6.1, 'total_ram_size': 15.5, 'error': ''}
        msg.update(kw)
        return msg

    async def publish(self, topic, msg):
        dead = []
        for ws, topics in list(self.subs.items()):
            if topic in topics:
                try:
                    await ws.send(json.dumps({'op': 'publish', 'topic': topic, 'msg': msg}))
                except Exception:
                    dead.append(ws)
        for ws in dead:
            self.subs.pop(ws, None)

    # ------------------------------------------------------------- record --
    async def run_take(self, ti):
        self.recording = True
        ds_path = self.dataset_root / ti['user_id'] / ('%s_%s' % (self.robot_type, ti['task_name']))
        try:
            phases = [(WARMING_UP, ti['warmup_time_s']), (RECORDING, ti['episode_time_s'])]
            k = 0
            while k < len(phases):
                phase, dur = phases[k]
                t0 = time.time()
                while time.time() - t0 < dur:
                    if self.cmd in ('stop', 'next') and phase == RECORDING:
                        break
                    if self.cmd == 'rerecord':
                        self.cmd = None
                        t0 = time.time()
                        phase = RECORDING
                    if self.cmd == 'finish':
                        break
                    await self.publish('/task/status', self._status(
                        phase, ti, total_time=int(dur), proceed_time=int(time.time() - t0),
                        current_task_instruction=ti['task_instruction'][0]))
                    await asyncio.sleep(0.1)
                if self.cmd == 'finish' and phase != RECORDING:
                    self.cmd = None
                    break
                k += 1
                if phase == RECORDING:
                    recorded_s = max(0.5, time.time() - t0)
                    self.cmd = None
                    for p in range(0, 101, 25):
                        await self.publish('/task/status', self._status(
                            SAVING, ti, encoding_progress=float(p)))
                        await asyncio.sleep(0.15)
                    if not (ds_path / 'meta' / 'info.json').exists():
                        synthetic.make_dataset(self.dataset_root, ds_path.relative_to(
                            self.dataset_root).as_posix(), episodes=0, fps=ti['fps'],
                            cameras=('global', 'gripper'), task=ti['task_instruction'][0],
                            width=320, height=240)
                        info = json.loads((ds_path / 'meta' / 'info.json').read_text())
                        info['robot_type'] = self.robot_type
                        (ds_path / 'meta' / 'info.json').write_text(json.dumps(info, indent=2))
                    await asyncio.to_thread(synthetic.append_episode, ds_path,
                                            int(recorded_s * ti['fps']),
                                            ti['task_instruction'][0])
                    self.svc.on_episode_saved(str(ds_path))
        finally:
            self.recording = False
            self.cmd = None
            self.svc.on_recording_finished()
            await self.publish('/task/status', self._status(READY, ti))
            self.task = None

    async def task_command(self, args):
        cmd = int(args.get('command', 0))
        ti = args.get('task_info') or {}
        if cmd == 1:  # START_RECORD
            if self.task:
                self.cmd = 'rerecord'
                return {'success': True, 'message': 'Restarting the recording.'}
            ok, msg = self.svc.check_start({
                'task_name': ti.get('task_name'), 'user_id': ti.get('user_id'),
                'task_instruction': list(ti.get('task_instruction') or []),
                'num_episodes': int(ti.get('num_episodes') or 0),
                'push_to_hub': bool(ti.get('push_to_hub')), 'fps': int(ti.get('fps') or 0)})
            if not ok:
                return {'success': False, 'message': msg}
            self.log.append(('START_RECORD', ti))
            self.task = asyncio.create_task(self.run_take(ti))
            return {'success': True, 'message': 'Recording started'}
        if not self.task:
            return {'success': False, 'message': 'Not currently recording'}
        self.cmd = {3: 'stop', 4: 'next', 5: 'rerecord', 6: 'finish'}.get(cmd)
        return {'success': True, 'message': 'ok'}

    # -------------------------------------------------------- hf (stand-in) --
    async def hf_upload(self, repo_id):
        for i in range(0, 11):
            await self.publish('/huggingface/status', {
                'operation': 'upload', 'status': 'Uploading' if i < 10 else 'Success',
                'local_path': '', 'repo_id': repo_id,
                'message': 'Stand-in upload (no data leaves this machine)' if i == 10 else '',
                'progress_current': i, 'progress_total': 10, 'progress_percentage': i * 10.0})
            await asyncio.sleep(0.25)

    # ----------------------------------------------------------- services --
    async def call_service(self, name, args):
        if name == '/rosapi/topic_type':
            t = args.get('topic')
            return {'type': 'trajectory_msgs/msg/JointTrajectory' if 'leader' in t else
                    'sensor_msgs/msg/JointState'}
        if name == '/rosapi/publishers':
            extra = os.environ.get('STANDIN_EXTRA_PUBLISHER')
            return {'publishers': ['/rosbridge_websocket'] + ([extra] if extra else [])}
        if name == '/get_robot_types':
            return {'robot_types': ['s101_dataset', 'omx_f']}
        if name == '/set_robot_type':
            self.robot_type = args.get('robot_type', '')
            return {'success': True, 'message': 'Robot type set to %s' % self.robot_type}
        if name == '/get_registered_hf_user':
            return {'user_id_list': ['NandithaaaG'], 'success': True, 'message': ''}
        if name == '/register_hf_user':
            return {'user_id_list': ['NandithaaaG'], 'success': True, 'message': ''}
        if name == '/image/get_available_list':
            return {'image_topic_list': ['/camera/color/image_raw/compressed',
                                         '/gripper_camera/color/image_raw/compressed'],
                    'success': True, 'message': ''}
        if name in ('/planning/command', '/data/command'):
            cmd = args.get('command', '')
            if cmd == 'data.hf_account':
                return {'success': True, 'message': 'ok', 'result_json': json.dumps(
                    {'name': 'NandithaaaG', 'orgs': [], 'fullname': 'stand-in'})}
            if cmd == 'data.hf_repos':
                return {'success': True, 'message': 'ok', 'result_json': '{"repos": []}'}
            if cmd == 'data.hf_prepare':
                p = json.loads(args.get('payload_json') or '{}')
                ds = self.dataset_root / p['dataset_id']
                return {'success': True, 'message': 'ok', 'result_json': json.dumps(
                    {'local_dir': str(ds), 'repo_url': 'stand-in', 'metadata_files': [],
                     'note': ''})}
            ok, msg, res = await asyncio.to_thread(
                self.svc.handle_json, cmd, args.get('payload_json', '{}'))
            return {'success': ok, 'message': msg, 'result_json': res}
        if name == '/task/command':
            return await self.task_command(args)
        if name == '/huggingface/control':
            if args.get('mode') == 'upload':
                asyncio.create_task(self.hf_upload(args.get('repo_id', '')))
            return {'success': True, 'message': 'stand-in'}
        if name == '/training/get_user_list':
            return {'user_list': ['NandithaaaG'], 'success': True, 'message': ''}
        raise KeyError(name)

    async def handler(self, ws):
        self.subs[ws] = set()
        try:
            async for raw in ws:
                m = json.loads(raw)
                op = m.get('op')
                if op == 'call_service':
                    try:
                        values = await self.call_service(m['service'], m.get('args') or {})
                        await ws.send(json.dumps({'op': 'service_response', 'id': m.get('id'),
                                                  'service': m['service'], 'values': values,
                                                  'result': True}))
                    except KeyError:
                        await ws.send(json.dumps({'op': 'service_response', 'id': m.get('id'),
                                                  'service': m['service'],
                                                  'values': 'Service %s does not exist'
                                                            % m['service'], 'result': False}))
                elif op == 'subscribe':
                    self.subs[ws].add(m['topic'])
                elif op == 'advertise':
                    pass
                elif op == 'publish' and 'leader' in m.get('topic', ''):
                    pts = (m.get('msg') or {}).get('points') or [{}]
                    self.command = list(pts[0].get('positions') or [])
                    self.command_t = time.time()
                    with open(self.commands_file, 'a') as f:
                        f.write(json.dumps({'t': self.command_t, 'names': m['msg'].get(
                            'joint_names'), 'positions': self.command}) + '\n')
                elif op == 'unsubscribe':
                    self.subs[ws].discard(m['topic'])
        finally:
            self.subs.pop(ws, None)

    async def tickers(self):
        t0 = time.time()
        while True:
            t = time.time() - t0
            if self.robot_type:
                await self.publish('/heartbeat', {})
                if self.command is not None:
                    # follower tracks the last command (first-order), like a position servo
                    prev = getattr(self, '_pos', self.command)
                    pos = [p + 0.3 * (c - p) for p, c in zip(prev, self.command)]
                else:
                    pos = [0.6 * math.sin(t * 0.7), -0.7 + 0.35 * math.sin(t * 0.5),
                           1.1 + 0.35 * math.sin(t * 0.5 + 1), -0.4 + 0.3 * math.sin(t * 0.9),
                           0.5 * math.sin(t * 0.3), 0.5 + 0.5 * math.sin(t * 1.3)]
                self._pos = pos
                await self.publish('/joint_states', {
                    'header': {'stamp': {'sec': int(t), 'nanosec': 0}, 'frame_id': ''},
                    'name': synthetic.JOINTS, 'position': pos, 'velocity': [], 'effort': []})
                # cameras over rosbridge (CompressedImage) for subscribers, 320x240 like
                # the stand-in recorder's videos, ~10 Hz
                if int(t * 20) % 2 == 0:
                    for topic in ('/camera/color/image_raw/compressed',
                                  '/gripper_camera/color/image_raw/compressed'):
                        if any(topic in tp for tp in self.subs.values()):
                            import base64
                            jpg = frame_jpeg(topic, t, size=(320, 240))
                            await self.publish(topic, {
                                'header': {'stamp': {'sec': int(t), 'nanosec': 0},
                                           'frame_id': ''},
                                'format': 'jpeg', 'data': base64.b64encode(jpg).decode()})
            await asyncio.sleep(0.05)


# ------------------------------------------------------------ fake cameras --
def frame_jpeg(topic, t, size=None):
    from PIL import Image, ImageDraw, ImageFilter
    import random
    w, h = 640, 480
    im = Image.new('RGB', (w, h), (205, 200, 190))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 300, w, h], fill=(170, 160, 140))
    if 'gripper' in topic:
        d.polygon([(250, 480), (300, 330), (340, 330), (390, 480)], fill=(60, 60, 60))
        cx = 320 + 80 * math.sin(t * 0.8)
        d.rectangle([cx - 45, 180, cx + 45, 270], fill=(200, 35, 35))
    else:
        cx = 220 + 120 * math.sin(t * 0.5)
        d.rectangle([cx - 22, 330, cx + 22, 372], fill=(205, 40, 40))
        d.rectangle([440, 320, 560, 400], outline=(120, 85, 45), width=8)
        d.line([(320, 120), (320 + 90 * math.sin(t * 0.5), 300)], fill=(30, 30, 30), width=14)
    rnd = random.Random(int(t * 10))
    for _ in range(600):
        x, y = rnd.randrange(w), rnd.randrange(h)
        v = rnd.randrange(0, 255)
        d.point((x, y), fill=(v, v, v))
    im = im.filter(ImageFilter.GaussianBlur(0.4))
    if size:
        im = im.resize(size)
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=70)
    return buf.getvalue()


class Mjpeg(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        from urllib.parse import parse_qs, urlparse
        q = parse_qs(urlparse(self.path).query)
        topic = (q.get('topic') or [''])[0]
        self.send_response(200)
        self.send_header('Content-Type', 'multipart/x-mixed-replace;boundary=boundarydonotcross')
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        t0 = time.time()
        try:
            while True:
                jpg = frame_jpeg(topic, time.time() - t0)
                self.wfile.write(b'--boundarydonotcross\r\nContent-Type: image/jpeg\r\n'
                                 b'Content-Length: %d\r\n\r\n' % len(jpg))
                self.wfile.write(jpg + b'\r\n')
                time.sleep(1 / 12)
        except (BrokenPipeError, ConnectionResetError):
            pass


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data-root', required=True)
    ap.add_argument('--dataset-root', required=True)
    a = ap.parse_args()
    robot = Robot(a.data_root, a.dataset_root)
    srv = ThreadingHTTPServer(('127.0.0.1', 8080), Mjpeg)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    async with websockets.serve(robot.handler, '127.0.0.1', 9090, max_size=2 ** 24):
        print('stand-in ready: rosbridge :9090, mjpeg :8080', flush=True)
        await robot.tickers()


if __name__ == '__main__':
    asyncio.run(main())
