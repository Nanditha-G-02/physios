"""PHYSIOS gateway tests: configuration, adapters and the HTTP API against in-process fakes of
rosbridge, the training service and web_video_server.

    cd physios/backend && python3 -m pytest -q tests
"""
import asyncio
import io
import json
from pathlib import Path
import socket
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from physios_gateway.adapters.datasets import Datasets, parse_range  # noqa: E402
from physios_gateway.adapters.rosbridge import RosBridge  # noqa: E402
from physios_gateway.app import Gateway, Server, make_handler  # noqa: E402
from physios_gateway.config import Config  # noqa: E402
from physios_gateway.errors import ApiError  # noqa: E402
from physios_gateway.services.activity import Activity  # noqa: E402
from physios_gateway.services.ros_api import RosApi, normalise_task_info  # noqa: E402

websockets = pytest.importorskip('websockets')


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


# ------------------------------------------------------------------------------- fakes
class FakeRos:
    """rosbridge protocol server with a few physical_ai_server services."""

    def __init__(self, port):
        self.port = port
        self.calls = []
        self.loop = None
        self.slow = False

    def values(self, m):
        svc = m['service']
        if svc == '/get_robot_types':
            return True, {'robot_types': ['so101_follower', 'omx_f'], 'success': True, 'message': ''}
        if svc == '/set_robot_type':
            return True, {'success': m['args'].get('robot_type') != 'bad', 'message': 'ok'}
        if svc == '/image/get_available_list':
            return True, {'image_topic_list': ['/cam/image_raw/compressed'], 'success': True}
        if svc == '/task/command':
            return True, {'success': True, 'message': 'started %d' % m['args']['command']}
        if svc in ('/planning/command', '/data/command'):
            a = m['args']
            if a['command'] == 'meta':
                return True, {'success': True, 'message': 'ok', 'result_json': json.dumps(
                    {'strategy_types': ['static'], 'echo': json.loads(a['payload_json'])})}
            return True, {'success': False, 'message': 'Unknown command "%s"' % a['command'],
                          'result_json': '{}'}
        if svc == '/slow':
            return None, None
        return False, 'Service %s does not exist' % svc

    async def handler(self, ws):
        async for raw in ws:
            m = json.loads(raw)
            if m.get('op') == 'call_service':
                self.calls.append(m)
                ok, vals = self.values(m)
                if ok is None:
                    continue  # never answer
                await ws.send(json.dumps({'op': 'service_response', 'id': m['id'],
                                          'values': vals, 'result': ok}))
            elif m.get('op') == 'subscribe':
                await ws.send(json.dumps({'op': 'publish', 'topic': m['topic'],
                                          'msg': {'data': 'hello'}}))

    def start(self):
        ready = threading.Event()

        def run():
            self.loop = asyncio.new_event_loop()

            async def main():
                async with websockets.serve(self.handler, '127.0.0.1', self.port):
                    ready.set()
                    await asyncio.Future()
            self.loop.run_until_complete(main())
        threading.Thread(target=run, daemon=True).start()
        assert ready.wait(5)


class FakeTrainer(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        FakeTrainer.seen.append(('GET', self.path, dict(self.headers)))
        if self.path == '/api/health':
            return self._send(200, {'ok': True, 'version': '0.1.0'})
        if self.path.startswith('/api/runs'):
            return self._send(200, {'runs': [{'id': 'r1'}], 'query': self.path})
        self._send(404, {'error': 'Not found: GET %s' % self.path})

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n)
        FakeTrainer.seen.append(('POST', self.path, dict(self.headers), body))
        origin = self.headers.get('Origin')
        host = self.headers.get('X-Forwarded-Host')
        if origin and host and origin.split('//')[-1] != host:
            return self._send(403, {'error': 'Cross-origin request refused.'})
        if self.path == '/api/robots/x/upload':
            return self._send(200, {'files': ['a.urdf'], 'bytes': len(body)})
        self._send(400, {'error': 'The configuration has errors: steps'})


class FakeCamera(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith('/snapshot'):
            b = b'\xff\xd8JPEG' + self.path.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'image/jpeg')
            self.send_header('Content-Length', str(len(b)))
            self.end_headers()
            self.wfile.write(b)
        else:
            b = b'<html>topics</html>'
            self.send_response(200)
            self.send_header('Content-Length', str(len(b)))
            self.end_headers()
            self.wfile.write(b)


def serve(handler, port):
    s = ThreadingHTTPServer(('127.0.0.1', port), handler)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


def make_dataset(root):
    d = root / 'alice' / 'cube_v1'
    (d / 'meta').mkdir(parents=True)
    (d / 'videos').mkdir()
    (d / 'meta' / 'info.json').write_text(json.dumps({'codebase_version': 'v2.1'}))
    (d / 'videos' / 'ep0.mp4').write_bytes(bytes(range(256)) * 4)
    (root / 'secret.txt').write_text('outside')
    return d


@pytest.fixture(scope='module')
def stack(tmp_path_factory):
    tmp = tmp_path_factory.mktemp('gw')
    ports = {k: free_port() for k in ('ros', 'trainer', 'cam', 'gw')}
    ros = FakeRos(ports['ros'])
    ros.start()
    tr = serve(FakeTrainer, ports['trainer'])
    cam = serve(FakeCamera, ports['cam'])
    ds_root = tmp / 'ds'
    make_dataset(ds_root)
    dist = tmp / 'dist'
    (dist / 'assets').mkdir(parents=True)
    (dist / 'index.html').write_text('<!doctype html><title>PHYSIOS</title>')
    (dist / 'assets' / 'app.js').write_text('console.log(1)')
    cfg = Config({'PHYSIOS_PORT': str(ports['gw']), 'PHYSIOS_TRAINER_URL': 'http://127.0.0.1:%d' % ports['trainer'],
                  'PHYSIOS_ROSBRIDGE_URL': 'ws://127.0.0.1:%d' % ports['ros'],
                  'PHYSIOS_CAMERA_URL': 'http://127.0.0.1:%d' % ports['cam'],
                  'PHYSIOS_DATASET_ROOTS': str(ds_root), 'PHYSIOS_FRONTEND_DIST': str(dist),
                  'PHYSIOS_VAR_DIR': str(tmp / 'var'), 'PHYSIOS_ROS_TIMEOUT_S': '1.5'},
                 environ={'PHYSIOS_CONFIG': str(tmp / 'none.env')})
    gw = Gateway(cfg)
    httpd = Server(('127.0.0.1', ports['gw']), make_handler(gw))
    gw.start()
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    t0 = time.time()
    while not gw.ros.connected and time.time() - t0 < 5:
        time.sleep(0.05)
    yield {'url': 'http://127.0.0.1:%d' % ports['gw'], 'gw': gw, 'ros': ros, 'ports': ports}
    httpd.shutdown()
    gw.stop()
    tr.shutdown()
    cam.shutdown()


def req(stack, path, body=None, method=None, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    h = {'Content-Type': 'application/json'}
    h.update(headers or {})
    r = urllib.request.Request(stack['url'] + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=10) as res:
            return res.status, res.read(), dict(res.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def js(stack, path, body=None, **kw):
    st, b, _ = req(stack, path, body, **kw)
    return st, json.loads(b)


# ------------------------------------------------------------------------------- unit
def test_config_defaults_and_env_file(tmp_path):
    f = tmp_path / 'p.env'
    f.write_text('# comment\nPHYSIOS_PORT=9001\nPHYSIOS_DATASET_ROOTS="/a:/b"\n')
    c = Config(environ={'PHYSIOS_CONFIG': str(f), 'PHYSIOS_TRAINER_URL': 'http://127.0.0.1:1'})
    assert c.port == 9001 and [str(p) for p in c.dataset_roots] == ['/a', '/b']
    assert c.trainer_url == 'http://127.0.0.1:1' and c.validate() == []
    c2 = Config({'PHYSIOS_HOST': '0.0.0.0'}, environ={'PHYSIOS_CONFIG': '/none'})
    assert any('loopback' in p for p in c2.validate())
    c3 = Config({'PHYSIOS_HOST': '0.0.0.0', 'PHYSIOS_ALLOW_REMOTE': '1', 'PHYSIOS_ROSBRIDGE_URL': 'http://x',
                 'PHYSIOS_AUTH_TOKEN': 'remote-operator-token'},
                environ={'PHYSIOS_CONFIG': '/none'})
    assert len(c3.validate()) == 1 and 'ws://' in c3.validate()[0]


def test_dataset_resolution_refuses_traversal(tmp_path):
    make_dataset(tmp_path)
    d = Datasets([tmp_path])
    assert d.resolve('alice/cube_v1').name == 'cube_v1'
    for bad in ('../x', 'alice/../..', 'alice', 'a/b/c', '/etc/passwd'):
        with pytest.raises(ApiError):
            d.resolve(bad)
    with pytest.raises(ApiError):
        d.file('alice/cube_v1', '../../secret.txt')
    with pytest.raises(ApiError):
        d.file('alice/cube_v1', 'meta/missing.json')
    assert d.file('alice/cube_v1', 'videos/ep0.mp4').stat().st_size == 1024
    assert d.summary()[0]['datasets'] == 1


def test_range_parsing():
    assert parse_range(None, 100) is None
    assert parse_range('bytes=0-9', 100) == (0, 9)
    assert parse_range('bytes=90-', 100) == (90, 99)
    assert parse_range('bytes=-10', 100) == (90, 99)
    assert parse_range('bytes=50-500', 100) == (50, 99)
    with pytest.raises(ApiError) as e:
        parse_range('bytes=200-300', 100)
    assert e.value.status == 416


def test_task_info_normalisation_and_motion_confirmation():
    ti = normalise_task_info({'task_name': 'x', 'fps': '30', 'task_instruction': 'pick'})
    assert ti['fps'] == 30 and ti['task_instruction'] == ['pick'] and ti['push_to_hub'] is False
    assert set(ti) >= {'warmup_time_s', 'record_rosbag2', 'policy_path'}
    with pytest.raises(ApiError):
        normalise_task_info({'fps': 999})
    api = RosApi(bridge=None, activity=Activity())
    with pytest.raises(ApiError) as e:
        api.task({'command': 'start_inference', 'task_info': {'policy_path': '/p'}})
    assert e.value.status == 428  # nothing was sent: bridge is None
    with pytest.raises(ApiError):
        api.task({'command': 'self_destruct'})


def test_activity_persists(tmp_path):
    a = Activity(tmp_path / 'a.jsonl')
    a.add('x', 'info', 'one')
    a.add('x', 'warn', 'two')
    b = Activity(tmp_path / 'a.jsonl')
    assert [e['text'] for e in b.since(0)['events']] == ['one', 'two']
    assert b.since(1)['events'][0]['text'] == 'two'


def test_rosbridge_unreachable_is_structured():
    rb = RosBridge('ws://127.0.0.1:%d' % free_port(), timeout_s=0.5)
    with pytest.raises(ApiError) as e:
        rb.call('/get_robot_types')
    assert e.value.status == 503 and e.value.code == 'ros_unavailable' and e.value.hint


# ------------------------------------------------------------------------- integration
def test_health_aggregates_real_checks(stack):
    st, h = js(stack, '/api/v1/health?force=1')
    s = h['services']
    assert st == 200 and h['status'] == 'ok'
    assert s['trainer']['status'] == 'ok' and s['rosbridge']['status'] == 'ok'
    assert s['ros_node']['robot_types'] == ['so101_follower', 'omx_f']
    assert s['camera']['status'] == 'ok' and s['datasets']['datasets'] == 1


def test_system_and_config(stack):
    st, s = js(stack, '/api/v1/system')
    assert st == 200 and s['cpu_count'] >= 1 and 'disks' in s
    st, c = js(stack, '/api/v1/config')
    assert c['port'] == stack['ports']['gw'] and c['version']


def test_ros_operations(stack):
    assert js(stack, '/api/v1/ros/robot-types')[1]['robot_types'][0] == 'so101_follower'
    assert js(stack, '/api/v1/ros/cameras')[1]['topics'] == ['/cam/image_raw/compressed']
    st, r = js(stack, '/api/v1/ros/robot-type', {'robot_type': 'bad'})
    assert st == 422 and r['error']['code'] == 'command_rejected'
    st, r = js(stack, '/api/v1/ros/task', {'command': 'start_record', 'task_info': {'task_name': 't', 'fps': 30}})
    assert st == 200 and r['success'] and r['message'] == 'started 1'
    sent = [c for c in stack['ros'].calls if c['service'] == '/task/command'][-1]['args']
    assert sent['command'] == 1 and sent['task_info']['fps'] == 30 and sent['task_info']['tags'] == []
    n = len(stack['ros'].calls)
    st, r = js(stack, '/api/v1/ros/task', {'command': 'start_inference', 'task_info': {'policy_path': '/p'}})
    assert st == 428 and len(stack['ros'].calls) == n, 'inference must not reach ROS without confirm'


def test_planning_commands(stack):
    st, r = js(stack, '/api/v1/planning/meta', {'x': 1})
    assert st == 200 and r['echo'] == {'x': 1}
    st, r = js(stack, '/api/v1/data/data.nope', {})
    assert st == 422 and 'Unknown command' in r['error']['message']
    st, r = js(stack, '/api/v1/planning/DROP;TABLE', {})
    assert st == 400


def test_missing_service_and_timeout(stack):
    api = stack['gw'].rosapi
    with pytest.raises(ApiError) as e:
        api.ros.call('/nope')
    assert e.value.code == 'ros_service_missing' and 'Zenoh' in e.value.hint
    with pytest.raises(ApiError) as e:
        api.ros.call('/slow', timeout=0.3)
    assert e.value.status == 504


def test_trainer_proxy(stack):
    st, r = js(stack, '/api/v1/trainer/runs?x=1')
    assert st == 200 and r['query'] == '/api/runs?x=1'
    st, r = js(stack, '/api/v1/trainer/plan', {'config': {}})
    assert st == 400 and 'steps' in r['error']  # trainer errors pass through unchanged
    host = '127.0.0.1:%d' % stack['ports']['gw']
    st, r = js(stack, '/api/v1/trainer/plan', {}, headers={'Origin': 'http://evil.example'})
    assert st == 403 and r['error']['code'] == 'cross_origin'
    st, b, _ = req(stack, '/api/v1/trainer/robots/x/upload', raw=b'z' * 5000,
                   headers={'Origin': 'http://' + host, 'Content-Type': 'application/octet-stream'})
    assert st == 200 and json.loads(b)['bytes'] == 5000
    fwd = FakeTrainer.seen[-1][2]
    assert fwd.get('X-Forwarded-Host') == host


def test_camera_proxy(stack):
    st, b, h = req(stack, '/api/v1/camera/snapshot?topic=/cam/image_raw/compressed')
    assert st == 200 and h['Content-Type'] == 'image/jpeg'
    assert b'topic=%2Fcam%2Fimage_raw' in b and b'compressed' not in b.split(b'topic=')[1]
    st, b, _ = req(stack, '/api/v1/camera/snapshot?topic=%3Brm%20-rf')
    assert st == 400


def test_dataset_files_range_and_export(stack):
    st, b, h = req(stack, '/api/v1/datasets/alice/cube_v1/files/videos/ep0.mp4', headers={'Range': 'bytes=10-19'})
    assert st == 206 and b == bytes(range(10, 20)) and h['Content-Range'] == 'bytes 10-19/1024'
    assert h['Content-Type'] == 'video/mp4'
    st, _, _ = req(stack, '/api/v1/datasets/alice/cube_v1/files/..%2F..%2Fsecret.txt')
    assert st in (400, 404)
    st, b, h = req(stack, '/api/v1/datasets/alice/cube_v1/export')
    assert st == 200 and 'attachment' in h['Content-Disposition']
    names = tarfile.open(fileobj=io.BytesIO(b), mode='r:gz').getnames()
    assert 'cube_v1/meta/info.json' in names and 'cube_v1/videos/ep0.mp4' in names


def test_static_frontend_and_spa_fallback(stack):
    st, b, h = req(stack, '/datasets/alice/cube_v1')
    assert st == 200 and b'PHYSIOS' in b and h['Cache-Control'] == 'no-cache'
    st, b, h = req(stack, '/assets/app.js')
    assert st == 200 and 'immutable' in h['Cache-Control']
    st, b, _ = req(stack, '/api/v1/nothing')
    assert st == 404 and json.loads(b)['error']['code'] == 'not_found'


def test_ros_websocket_proxy(stack):
    async def go():
        url = 'ws://127.0.0.1:%d/ros' % stack['ports']['gw']
        async with websockets.connect(url) as ws:
            await ws.send(json.dumps({'op': 'call_service', 'id': 'a', 'service': '/get_robot_types', 'args': {}}))
            await ws.send(json.dumps({'op': 'subscribe', 'topic': '/heartbeat'}))
            got = {json.loads(await asyncio.wait_for(ws.recv(), 3))['op'] for _ in range(2)}
            return got
    assert asyncio.run(go()) == {'service_response', 'publish'}


def test_activity_records_commands(stack):
    st, a = js(stack, '/api/v1/activity')
    texts = [e['text'] for e in a['events']]
    assert any('gateway' in t and 'started' in t for t in texts)
    assert any('Task command start_record' in t for t in texts)


# ------------------------------------------------------------------------ authentication
def test_auth_sessions_bearer_rate_limit_and_expiry():
    from physios_gateway.services.auth import Auth, COOKIE
    now = [1000.0]
    a = Auth('correct-horse-battery', session_hours=1, clock=lambda: now[0])
    assert a.enabled and not a.allowed({})
    assert a.allowed({'Authorization': 'Bearer correct-horse-battery'})
    assert not a.allowed({'Authorization': 'Bearer wrong'})
    sid = a.login('1.2.3.4', 'correct-horse-battery')
    assert sid and a.allowed({'Cookie': 'x=1; %s=%s' % (COOKIE, sid)})
    assert 'HttpOnly' in a.cookie(sid) and 'SameSite=Strict' in a.cookie(sid)
    now[0] += 3601  # expired
    assert not a.allowed({'Cookie': '%s=%s' % (COOKIE, sid)})
    for _ in range(5):
        assert a.login('5.6.7.8', 'nope') is None
    assert a.blocked('5.6.7.8') and not a.blocked('1.2.3.4')
    now[0] += 61
    assert not a.blocked('5.6.7.8')
    assert not Auth('').enabled and Auth('').allowed({})


def test_remote_binding_requires_token(tmp_path):
    env = {'PHYSIOS_CONFIG': str(tmp_path / 'none.env')}
    c = Config({'PHYSIOS_HOST': '0.0.0.0', 'PHYSIOS_ALLOW_REMOTE': '1'}, environ=env)
    assert any('PHYSIOS_AUTH_TOKEN' in p for p in c.validate())
    c = Config({'PHYSIOS_HOST': '0.0.0.0', 'PHYSIOS_ALLOW_REMOTE': '1', 'PHYSIOS_AUTH_TOKEN': 'short'}, environ=env)
    assert any('12 characters' in p for p in c.validate())
    c = Config({'PHYSIOS_HOST': '0.0.0.0', 'PHYSIOS_ALLOW_REMOTE': '1', 'PHYSIOS_AUTH_TOKEN': 'a-long-enough-token'}, environ=env)
    assert c.validate() == [] and c.public()['auth_enabled'] is True
    assert 'a-long-enough-token' not in json.dumps(c.public())


def test_api_requires_sign_in_when_enabled(stack):
    from physios_gateway.services.auth import Auth
    gw = stack['gw']
    old = gw.auth
    gw.auth = Auth('integration-token-123')
    try:
        st, body, _ = req(stack, '/api/v1/health')
        assert st == 401 and json.loads(body)['error']['code'] == 'auth_required'
        st, body, _ = req(stack, '/')  # the login screen itself stays reachable
        assert st == 200
        st, body, _ = req(stack, '/api/v1/auth/session')
        assert json.loads(body) == {'enabled': True, 'authenticated': False}
        st, body, _ = req(stack, '/api/v1/auth/login', {'token': 'wrong'})
        assert st == 401 and json.loads(body)['error']['code'] == 'bad_token'
        st, body, h = req(stack, '/api/v1/auth/login', {'token': 'integration-token-123'})
        assert st == 200 and 'physios_session=' in h['Set-Cookie']
        cookie = h['Set-Cookie'].split(';')[0]
        st, body, _ = req(stack, '/api/v1/health', headers={'Cookie': cookie})
        assert st == 200
        st, _, _ = req(stack, '/api/v1/config', headers={'Authorization': 'Bearer integration-token-123'})
        assert st == 200
        st, _, h = req(stack, '/api/v1/auth/logout', {}, headers={'Cookie': cookie})
        assert st == 200 and 'Max-Age=0' in h['Set-Cookie']
        st, _, _ = req(stack, '/api/v1/health', headers={'Cookie': cookie})
        assert st == 401
        st, body, _ = req(stack, '/api/v1/auth/login', {'token': 'integration-token-123'},
                          headers={'Origin': 'http://evil.example'})
        assert st == 403
    finally:
        gw.auth = old
