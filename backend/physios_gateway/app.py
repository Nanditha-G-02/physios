"""PHYSIOS gateway HTTP server.

    python3 -m physios_gateway [--host 127.0.0.1] [--port 8700]

Routes (full contract in documentation/03-API.md):

  GET  /api/v1/health | /system | /config | /activity
  GET  /api/v1/ros/status | /ros/robot-types | /ros/cameras | /ros/policies
  POST /api/v1/ros/robot-type | /ros/task | /ros/hf
  POST /api/v1/planning/<command> | /api/v1/data/<command>      (PlanningService)
  ANY  /api/v1/trainer/<path>                                     (physios_trainer /api/<path>)
  GET  /api/v1/camera/stream?topic= | /camera/snapshot?topic=     (web_video_server)
  GET  /api/v1/datasets/roots | /datasets/<owner>/<name>/files/<path> | .../export
  WS   /ros                                                       (rosbridge, transparent)
  GET  /*                                                         (PHYSIOS frontend)
"""

import argparse
import http.client
import json
import logging
import logging.handlers
import os
import re
import select
import signal
import socket
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlencode, urlparse

from physios_gateway import __version__
from physios_gateway.adapters.datasets import Datasets, content_type, parse_range
from physios_gateway.adapters.rosbridge import RosBridge
from physios_gateway.config import Config, LOOPBACK
from physios_gateway.errors import ApiError, bad_request, not_found
from physios_gateway.services.activity import Activity
from physios_gateway.services.auth import Auth
from physios_gateway.services.health import Health, TRAINER_HINT, CAMERA_HINT
from physios_gateway.services.ros_api import RosApi
from physios_gateway.services.system import SystemMonitor

log = logging.getLogger('physios')
TOPIC_RE = re.compile(r'^/[A-Za-z0-9_/]+$')
MAX_JSON = 2 << 20


PROTECTED = ('/api/', '/train-api', '/camera-stream/', '/lerobot-data/')


class Gateway:
    """Composition root: one instance per process."""

    def __init__(self, cfg):
        self.cfg = cfg
        cfg.var_dir.mkdir(parents=True, exist_ok=True)
        self.activity = Activity(cfg.var_dir / 'activity.jsonl')
        self.ros = RosBridge(cfg.rosbridge_url, cfg.ros_timeout_s, log=log.info,
                             on_change=self._ros_changed)
        self.rosapi = RosApi(self.ros, self.activity)
        self.datasets = Datasets(cfg.dataset_roots)
        self.system = SystemMonitor(cfg.trainer_dir, [cfg.var_dir, *cfg.dataset_roots,
                                                      cfg.data_dir])
        self.health = Health(cfg, self.ros, self.rosapi, self.datasets, self.activity)
        self.auth = Auth(cfg.auth_token, cfg.auth_session_h)
        self.started = time.time()

    def _ros_changed(self, connected, error):
        self.activity.add('ros', 'info' if connected else 'warn',
                          'rosbridge connected' if connected else 'rosbridge disconnected: %s'
                          % (error or ''))

    def start(self):
        self.ros.start()
        self.system.start()
        self.activity.add('gateway', 'info', 'RawBot Studio gateway %s started' % __version__)

    def stop(self):
        self.ros.stop()
        self.system.stop()


def make_handler(gw):
    cfg = gw.cfg

    class H(BaseHTTPRequestHandler):
        server_version = 'RawBotStudio/%s' % __version__
        protocol_version = 'HTTP/1.0'

        def log_message(self, fmt, *args):  # route through logging
            log.debug('%s %s', self.address_string(), fmt % args)

        # ------------------------------------------------------------- helpers --
        def _json(self, status, obj, headers=None):
            data = json.dumps(obj, default=str).encode()
            self.send_response(status)
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(data)

        def _body(self):
            n = int(self.headers.get('Content-Length') or 0)
            if n > MAX_JSON:
                raise ApiError(413, 'too_large', 'Request body too large.')
            if not n:
                return {}
            try:
                body = json.loads(self.rfile.read(n) or b'{}')
            except ValueError:
                raise bad_request('Body is not valid JSON.')
            if not isinstance(body, dict):
                raise bad_request('Body must be a JSON object.')
            return body

        def _check_origin(self):
            origin = self.headers.get('Origin')
            if not origin or origin == 'null':
                return
            host = self.headers.get('Host') or ''
            if urlparse(origin).netloc != host:
                raise ApiError(403, 'cross_origin', 'Cross-origin request refused.')

        # ------------------------------------------------------------ dispatch --
        def do_GET(self):
            self._dispatch('GET')

        def do_HEAD(self):
            self._dispatch('HEAD')

        def do_POST(self):
            self._dispatch('POST')

        def _dispatch(self, method):
            t0 = time.time()
            u = urlparse(self.path)
            q = {k: v[-1] for k, v in parse_qs(u.query).items()}
            path = u.path
            status = 200
            try:
                if method == 'POST':
                    self._check_origin()
                if path.startswith('/api/v1/auth/'):
                    return self._auth(method, path[len('/api/v1/auth/'):])
                if (path.startswith(PROTECTED) or path == '/ros') and \
                        not gw.auth.allowed(self.headers):
                    raise ApiError(401, 'auth_required', 'Sign in to RawBot Studio to continue.',
                                   'Enter the access token set in PHYSIOS_AUTH_TOKEN.')
                if path == '/ros' and self.headers.get('Upgrade', '').lower() == 'websocket':
                    self._check_origin()
                    return self._ws_proxy()
                # same-origin paths of the PHYSIOS frontend (the Physical AI Manager interface)
                if path.startswith('/train-api/') or path == '/train-api':
                    return self._trainer_proxy(method, path[len('/train-api'):], u.query)
                if path.startswith('/camera-stream/') and method in ('GET', 'HEAD'):
                    return self._camera_passthrough(path[len('/camera-stream'):], u.query)
                if path.startswith('/lerobot-data/') and method in ('GET', 'HEAD'):
                    return self._lerobot_data(path[len('/lerobot-data/'):])
                if path.startswith('/api/v1/trainer/') or path == '/api/v1/trainer':
                    return self._trainer_proxy(method, path[len('/api/v1/trainer'):], u.query)
                if path.startswith('/api/v1/camera/'):
                    return self._camera(path[len('/api/v1/camera/'):], q)
                if path.startswith('/api/v1/datasets/') and method in ('GET', 'HEAD'):
                    if self._dataset_files(path[len('/api/v1/datasets/'):]):
                        return
                if path.startswith('/api/'):
                    body = self._body() if method == 'POST' else {}
                    self._json(200, self.route(method, path, q, body))
                    return
                if method in ('GET', 'HEAD'):
                    return self._static(path)
                raise not_found('No route for %s %s' % (method, path))
            except ApiError as e:
                status = e.status
                self._json(e.status, e.body())
            except (BrokenPipeError, ConnectionResetError):
                status = 499
            except Exception as e:  # noqa: BLE001
                status = 500
                log.error('unhandled error on %s %s\n%s', method, path, traceback.format_exc())
                try:
                    self._json(500, ApiError(500, 'internal', 'Internal error: %s' % e).body())
                except OSError:
                    pass
            finally:
                if path.startswith('/api/') and not path.endswith(('/health', '/system',
                                                                   '/activity', '/events')):
                    log.info('%s %s -> %s (%d ms)', method, path, status,
                             (time.time() - t0) * 1000)

        # ----------------------------------------------------------------- auth --
        def _auth(self, method, what):
            a = gw.auth
            if method == 'GET' and what == 'session':
                return self._json(200, {'enabled': a.enabled,
                                        'authenticated': a.allowed(self.headers)})
            if method == 'POST' and what == 'login':
                if not a.enabled:
                    return self._json(200, {'enabled': False, 'authenticated': True})
                addr = self.client_address[0]
                if a.blocked(addr):
                    raise ApiError(429, 'too_many_attempts',
                                   'Too many failed sign-ins. Wait a minute and try again.')
                sid = a.login(addr, self._body().get('token'))
                if not sid:
                    gw.activity.add('gateway', 'warn', 'Failed sign-in from %s' % addr)
                    raise ApiError(401, 'bad_token', 'That access token is not correct.')
                gw.activity.add('gateway', 'info', 'Operator signed in from %s' % addr)
                return self._json(200, {'enabled': True, 'authenticated': True},
                                  {'Set-Cookie': a.cookie(sid)})
            if method == 'POST' and what == 'logout':
                a.logout(self.headers)
                return self._json(200, {'enabled': a.enabled, 'authenticated': not a.enabled},
                                  {'Set-Cookie': a.clear_cookie()})
            raise not_found('No route for %s /api/v1/auth/%s' % (method, what))

        # --------------------------------------------------------------- routes --
        def route(self, m, path, q, b):
            p = [x for x in path.split('/') if x][2:]  # drop api, v1
            if m == 'GET' and p == ['health']:
                return gw.health.check(force=q.get('force') == '1')
            if m == 'GET' and p == ['system']:
                return gw.system.snapshot()
            if m == 'GET' and p == ['config']:
                pub = cfg.public()
                pub['version'] = __version__
                pub['uptime_s'] = round(time.time() - gw.started)
                return pub
            if m == 'GET' and p == ['activity']:
                return gw.activity.since(int(q.get('after', 0) or 0),
                                         min(int(q.get('limit', 100) or 100), 500))
            if p[:1] == ['ros']:
                return self._ros(m, p[1:], b)
            if m == 'POST' and len(p) == 2 and p[0] in ('planning', 'data'):
                fn = gw.rosapi.planning if p[0] == 'planning' else gw.rosapi.data
                return fn(p[1], b)
            if m == 'GET' and p == ['datasets', 'roots']:
                return {'roots': gw.datasets.summary()}
            raise not_found('No route for %s %s' % (m, path))

        def _ros(self, m, p, b):
            api = gw.rosapi
            if m == 'GET' and p == ['status']:
                return gw.ros.status()
            if m == 'GET' and p == ['robot-types']:
                return api.robot_types()
            if m == 'POST' and p == ['robot-type']:
                return api.set_robot_type(b.get('robot_type'))
            if m == 'GET' and p == ['cameras']:
                return api.cameras()
            if m == 'GET' and p == ['policies']:
                return api.saved_policies()
            if m == 'POST' and p == ['task']:
                return api.task(b)
            if m == 'POST' and p == ['hf']:
                return api.hf_control(b)
            raise not_found('No route for %s ros/%s' % (m, '/'.join(p)))

        # --------------------------------------------------------- trainer proxy --
        def _trainer_proxy(self, method, rest, query):
            if method not in ('GET', 'POST', 'HEAD'):
                raise ApiError(405, 'method_not_allowed', 'Method not allowed.')
            n = int(self.headers.get('Content-Length') or 0)
            if n > cfg.max_upload_mb << 20:
                raise ApiError(413, 'too_large', 'Upload larger than %d MB.' % cfg.max_upload_mb)
            body = self.rfile.read(n) if n else None
            u = urlparse(cfg.trainer_url)
            target = '/api' + (rest or '/') + ('?' + query if query else '')
            headers = {'Content-Type': self.headers.get('Content-Type') or 'application/json',
                       'X-Forwarded-Host': self.headers.get('Host') or ''}
            if self.headers.get('Origin'):
                headers['Origin'] = self.headers['Origin']
            conn = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=300)
            try:
                conn.request(method, target, body=body, headers=headers)
                r = conn.getresponse()
            except OSError as e:
                conn.close()
                raise ApiError(503, 'trainer_unavailable',
                               'Training service not reachable at %s (%s).' % (
                                   cfg.trainer_url, e), TRAINER_HINT)
            try:
                self.send_response(r.status)
                for h in ('Content-Type', 'Content-Length', 'Cache-Control',
                          'X-Content-Type-Options', 'Content-Disposition'):
                    if r.getheader(h):
                        self.send_header(h, r.getheader(h))
                self.end_headers()
                while True:
                    chunk = r.read1(65536) if hasattr(r, 'read1') else r.read(65536)
                    if not chunk:
                        break
                    if method != 'HEAD':
                        self.wfile.write(chunk)
            finally:
                conn.close()

        # ----------------------------------------------------------- cameras --
        def _camera(self, what, q):
            topic = q.get('topic', '')
            if not TOPIC_RE.match(topic):
                raise bad_request('topic must be a ROS topic name like /camera/image_raw')
            if topic.endswith('/compressed'):
                topic = topic[:-len('/compressed')]
            params = {'topic': topic}
            if what == 'stream':
                params.update(type='ros_compressed', default_transport='compressed',
                              quality=str(int(q.get('quality', 60) or 60)))
                for k in ('width', 'height'):
                    if q.get(k, '').isdigit():
                        params[k] = q[k]
            elif what != 'snapshot':
                raise not_found('No camera route %s' % what)
            u = urlparse(cfg.camera_url)
            conn = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=10)
            try:
                conn.request('GET', '/%s?%s' % (what, urlencode(params)))
                r = conn.getresponse()
            except OSError as e:
                conn.close()
                raise ApiError(503, 'camera_unavailable', 'Camera server not reachable at %s '
                               '(%s).' % (cfg.camera_url, e), CAMERA_HINT)
            try:
                self.send_response(r.status)
                self.send_header('Content-Type', r.getheader('Content-Type') or
                                 'application/octet-stream')
                self.send_header('Cache-Control', 'no-store')
                if r.getheader('Content-Length'):
                    self.send_header('Content-Length', r.getheader('Content-Length'))
                self.end_headers()
                if conn.sock:
                    conn.sock.settimeout(30)
                while True:
                    chunk = r.read1(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, socket.timeout):
                pass
            finally:
                conn.close()

        def _camera_passthrough(self, rest, query):
            """/camera-stream/<path>?<query> -> web_video_server, unchanged (MJPEG streaming)."""
            if not re.match(r'^/[A-Za-z0-9_./-]*$', rest or '/') or '..' in rest:
                raise bad_request('Bad camera path.')
            u = urlparse(cfg.camera_url)
            conn = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=10)
            try:
                conn.request('GET', (rest or '/') + ('?' + query if query else ''))
                r = conn.getresponse()
            except OSError as e:
                conn.close()
                raise ApiError(503, 'camera_unavailable', 'Camera server not reachable at %s '
                               '(%s).' % (cfg.camera_url, e), CAMERA_HINT)
            try:
                self.send_response(r.status)
                self.send_header('Content-Type', r.getheader('Content-Type') or
                                 'application/octet-stream')
                self.send_header('Cache-Control', 'no-store')
                if r.getheader('Content-Length'):
                    self.send_header('Content-Length', r.getheader('Content-Length'))
                self.end_headers()
                if self.command == 'HEAD':
                    return
                if conn.sock:
                    conn.sock.settimeout(30)
                while True:
                    chunk = r.read1(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, socket.timeout):
                pass
            finally:
                conn.close()

        def _lerobot_data(self, rest):
            """/lerobot-data/<owner>/<name>/<file...> -> that dataset's file (read-only, Range)."""
            parts = unquote(rest).split('/')
            if len(parts) < 3 or not all(parts):
                raise not_found('Not found')
            p = gw.datasets.file('%s/%s' % (parts[0], parts[1]), '/'.join(parts[2:]))
            self._send_file(p)

        # ----------------------------------------------------------- datasets --
        def _dataset_files(self, rest):
            # <owner>/<name>/files/<path...>  or  <owner>/<name>/export
            parts = rest.split('/')
            if len(parts) >= 4 and parts[2] == 'files':
                did = '%s/%s' % (parts[0], parts[1])
                p = gw.datasets.file(did, '/'.join(parts[3:]))
                self._send_file(p)
                return True
            if len(parts) == 3 and parts[2] == 'export':
                did = '%s/%s' % (parts[0], parts[1])
                gw.datasets.resolve(did)
                self.send_response(200)
                self.send_header('Content-Type', 'application/gzip')
                self.send_header('Content-Disposition', 'attachment; filename="%s.tar.gz"'
                                 % did.replace('/', '__'))
                self.end_headers()
                gw.activity.add('datasets', 'info', 'Export of %s started' % did)
                if self.command != 'HEAD':
                    gw.datasets.export_stream(did, self.wfile)
                return True
            return False

        def _send_file(self, p, cache='no-cache'):
            size = p.stat().st_size
            rng = parse_range(self.headers.get('Range'), size)
            start, end = rng if rng else (0, size - 1)
            self.send_response(206 if rng else 200)
            self.send_header('Content-Type', content_type(p))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(max(0, end - start + 1)))
            self.send_header('Cache-Control', cache)
            if rng:
                self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
            self.end_headers()
            if self.command == 'HEAD' or size == 0:
                return
            with open(p, 'rb') as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = f.read(min(262144, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)

        # ------------------------------------------------------------- static --
        def _static(self, path):
            root = cfg.frontend_dist
            if not (root / 'index.html').is_file():
                html = ('<!doctype html><meta charset="utf-8"><title>RawBot Studio</title><link rel="icon" href="/favicon.ico?v=3">'
                        '<body style="font:15px system-ui;padding:40px;background:#0b0e13;'
                        'color:#e6e9ef"><h1>RawBot Studio gateway is running</h1><p>The frontend is '
                        'not built yet. Run <code>cd physios/frontend && npm ci && npm run '
                        'build</code>, or <code>./start_physios.sh --build</code>.</p>'
                        '<p>API: <a style="color:#7cc4ff" href="/api/v1/health">/api/v1/health'
                        '</a></p>').encode()
                self.send_response(503)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(html)))
                self.end_headers()
                self.wfile.write(html)
                return
            rel = path.lstrip('/') or 'index.html'
            p = (root / rel).resolve()
            try:
                p.relative_to(root.resolve())
            except ValueError:
                raise not_found('Not found')
            if not p.is_file():
                p = root / 'index.html'  # client-side routing
            immutable = '/assets/' in path or path.startswith('/static/')
            self._send_file(p, 'public, max-age=31536000, immutable' if immutable
                            else 'no-cache')

        # ---------------------------------------------------------- ws proxy --
        def _ws_proxy(self):
            u = urlparse(cfg.rosbridge_url)
            try:
                up = socket.create_connection((u.hostname, u.port or 80), timeout=3)
            except OSError as e:
                raise ApiError(503, 'ros_unavailable', 'rosbridge not reachable at %s (%s)'
                               % (cfg.rosbridge_url, e))
            lines = ['GET %s HTTP/1.1' % (u.path or '/'),
                     'Host: %s:%d' % (u.hostname, u.port or 80)]
            for k, v in self.headers.items():
                if k.lower() in ('host', 'origin'):
                    continue
                lines.append('%s: %s' % (k, v))
            up.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode())
            up.settimeout(None)
            client = self.connection
            self.close_connection = True
            socks = [client, up]
            try:
                while True:
                    r, _, x = select.select(socks, [], socks, 60)
                    if x:
                        break
                    if not r:
                        continue
                    done = False
                    for s in r:
                        data = s.recv(65536)
                        if not data:
                            done = True
                            break
                        (up if s is client else client).sendall(data)
                    if done:
                        break
            except OSError:
                pass
            finally:
                up.close()

    return H


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler):
        if ':' in addr[0]:
            self.address_family = socket.AF_INET6
        super().__init__(addr, handler)


def setup_logging(var_dir, verbose=False):
    log.setLevel(logging.DEBUG if verbose else logging.INFO)
    fmt = logging.Formatter('%(asctime)s %(levelname)s %(message)s')
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    log.addHandler(sh)
    try:
        (var_dir / 'log').mkdir(parents=True, exist_ok=True)
        fh = logging.handlers.RotatingFileHandler(var_dir / 'log' / 'gateway.log',
                                                  maxBytes=5 << 20, backupCount=3)
        fh.setFormatter(fmt)
        log.addHandler(fh)
    except OSError:
        pass


def main(argv=None):
    ap = argparse.ArgumentParser(prog='physios-gateway', description='RawBot Studio gateway')
    ap.add_argument('--host')
    ap.add_argument('--port', type=int)
    ap.add_argument('--config', help='env file (default physios/configuration/physios.env)')
    ap.add_argument('--verbose', action='store_true')
    ap.add_argument('--check-config', action='store_true', help='print config and exit')
    a = ap.parse_args(argv)
    if a.config:
        os.environ['PHYSIOS_CONFIG'] = a.config
    cfg = Config({'PHYSIOS_HOST': a.host, 'PHYSIOS_PORT': str(a.port) if a.port else None})
    problems = cfg.validate()
    if a.check_config:
        print(json.dumps({'config': cfg.public(), 'problems': problems}, indent=2))
        return 1 if problems else 0
    if problems:
        for pr in problems:
            print('[physios] config error: %s' % pr, file=sys.stderr)
        return 2
    setup_logging(cfg.var_dir, a.verbose)
    if cfg.host not in LOOPBACK:
        log.warning('Listening on %s: anyone on this network can reach services that move '
                    'the robot.', cfg.host)
    gw = Gateway(cfg)
    try:
        httpd = Server((cfg.host, cfg.port), make_handler(gw))
    except OSError as e:
        print('[physios] cannot listen on %s:%d: %s' % (cfg.host, cfg.port, e), file=sys.stderr)
        return 3
    gw.start()

    def _term(*_):
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _term)
    log.info('RawBot Studio gateway %s listening on http://%s:%d (trainer %s, rosbridge %s)',
             __version__, cfg.host, cfg.port, cfg.trainer_url, cfg.rosbridge_url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        gw.stop()
        httpd.server_close()
        log.info('RawBot Studio gateway stopped')
    return 0
