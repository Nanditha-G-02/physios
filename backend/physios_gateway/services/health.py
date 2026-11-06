"""Aggregated health of everything PHYSIOS depends on. Each check is real (an HTTP request,
a ROS service call, a folder scan) and cached for a few seconds."""

import http.client
import threading
import time
from urllib.parse import urlparse

from physios_gateway import __version__
from physios_gateway.errors import ApiError
from physios_gateway.adapters.rosbridge import ROS_HINT

TRAINER_HINT = ('Start the training service on the host: cd physical_ai_trainer && '
                'python3 -m pam_trainer (./start_physios.sh does this).')
CAMERA_HINT = ('web_video_server is not answering. It runs inside the physical_ai_server '
               'container with the bringup launch.')


def http_get(url, path, timeout=1.5):
    u = urlparse(url)
    c = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=timeout)
    try:
        t0 = time.time()
        c.request('GET', path)
        r = c.getresponse()
        body = r.read(1 << 20)
        return r.status, body, round((time.time() - t0) * 1000)
    finally:
        c.close()


class Health:

    def __init__(self, cfg, ros, rosapi, datasets, activity, ttl=3.0):
        self.cfg, self.ros, self.rosapi, self.datasets = cfg, ros, rosapi, datasets
        self.activity = activity
        self.ttl = ttl
        self._cache = None
        self._t = 0.0
        self._lock = threading.Lock()
        self._last_state = {}

    def _trainer(self):
        try:
            st, body, ms = http_get(self.cfg.trainer_url, '/api/health')
            if st == 200:
                import json
                ver = json.loads(body).get('version')
                return {'status': 'ok', 'latency_ms': ms, 'version': ver,
                        'detail': 'pam_trainer %s at %s' % (ver, self.cfg.trainer_url)}
            return {'status': 'down', 'detail': 'HTTP %d from %s' % (st, self.cfg.trainer_url),
                    'hint': TRAINER_HINT}
        except (OSError, ValueError) as e:
            return {'status': 'down', 'detail': 'not reachable at %s (%s)' % (
                self.cfg.trainer_url, e), 'hint': TRAINER_HINT}

    def _rosbridge(self):
        s = self.ros.status()
        if s['connected']:
            return {'status': 'ok', 'detail': 'connected to %s' % s['url']}
        return {'status': 'down', 'detail': s['error'] or 'not connected', 'hint': ROS_HINT}

    def _ros_node(self, bridge_ok):
        if not bridge_ok:
            return {'status': 'unknown', 'detail': 'needs rosbridge'}
        try:
            t0 = time.time()
            r = self.rosapi.robot_types(timeout=2.5)
            return {'status': 'ok', 'latency_ms': round((time.time() - t0) * 1000),
                    'detail': 'physical_ai_server answers (%d robot types)'
                    % len(r['robot_types']), 'robot_types': r['robot_types']}
        except ApiError as e:
            return {'status': 'down', 'detail': e.message, 'hint': e.hint}

    def _camera(self):
        try:
            st, _, ms = http_get(self.cfg.camera_url, '/', timeout=1.0)
            if st < 500:
                return {'status': 'ok', 'latency_ms': ms,
                        'detail': 'web_video_server at %s' % self.cfg.camera_url}
            return {'status': 'down', 'detail': 'HTTP %d' % st, 'hint': CAMERA_HINT}
        except OSError as e:
            return {'status': 'down', 'detail': 'not reachable at %s (%s)' % (
                self.cfg.camera_url, e), 'hint': CAMERA_HINT}

    def _datasets(self):
        roots = self.datasets.summary()
        n = sum(r['datasets'] for r in roots)
        ok = any(r['exists'] for r in roots)
        return {'status': 'ok' if ok else 'down', 'datasets': n, 'roots': roots,
                'detail': '%d LeRobot dataset(s) found' % n if ok else 'no dataset folder exists',
                'hint': None if ok else 'Record a dataset first or set PHYSIOS_DATASET_ROOTS.'}

    def check(self, force=False):
        with self._lock:
            if not force and self._cache and time.time() - self._t < self.ttl:
                return self._cache
            ros = self._rosbridge()
            services = {
                'gateway': {'status': 'ok', 'version': __version__,
                            'detail': 'PHYSIOS gateway %s' % __version__},
                'trainer': self._trainer(),
                'rosbridge': ros,
                'ros_node': self._ros_node(ros['status'] == 'ok'),
                'camera': self._camera(),
                'datasets': self._datasets(),
            }
            for name, s in services.items():
                prev = self._last_state.get(name)
                if prev is not None and prev != s['status']:
                    self.activity.add('health', 'info' if s['status'] == 'ok' else 'warn',
                                      '%s is %s' % (name, s['status']))
                self._last_state[name] = s['status']
            core_ok = all(services[k]['status'] == 'ok' for k in ('trainer', 'ros_node'))
            self._cache = {'status': 'ok' if core_ok else 'degraded', 'services': services,
                           'checked_at': time.time()}
            self._t = time.time()
            return self._cache
