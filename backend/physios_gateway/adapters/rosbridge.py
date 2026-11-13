"""ROS 2 adapter: a persistent rosbridge client used for service calls.

The gateway never runs ROS itself. The physical_ai_server node of the PHYSIOS robot runtime
(robot/, in the physios-robot container) is the ROS side; this client speaks the rosbridge v2 JSON protocol to it. Topic streams for the
browser go through the transparent ``/ros`` WebSocket proxy in app.py instead.
"""

import itertools
import json
import threading
import time

from physios_gateway.adapters.ws import WebSocket, WsClosed
from physios_gateway.errors import ApiError

ROS_HINT = ('Start the RawBot Studio robot runtime: ./start_physios.sh --with-robot (starts the '
            'physios-robot container: Zenoh router, physical_ai_server, rosbridge, '
            'web_video_server; no motion).')


class RosBridge:

    def __init__(self, url, timeout_s=20.0, log=None, on_change=None):
        self.url = url
        self.timeout_s = timeout_s
        self.log = log or (lambda *a: None)
        self.on_change = on_change or (lambda *a: None)
        self._ws = None
        self._lock = threading.Lock()
        self._send_lock = threading.Lock()
        self._pending = {}
        self._ids = itertools.count(1)
        self.connected = False
        self.last_error = None
        self.since = time.time()
        self._stop = threading.Event()
        self._thread = None

    # ------------------------------------------------------------- lifecycle --
    def start(self):
        self._thread = threading.Thread(target=self._loop, daemon=True, name='rosbridge')
        self._thread.start()

    def stop(self):
        self._stop.set()
        ws = self._ws
        if ws:
            ws.close()

    def _set(self, connected, error=None):
        if connected != self.connected:
            self.connected, self.since = connected, time.time()
            self.on_change(connected, error)
        self.last_error = error

    def _loop(self):
        backoff = 1.0
        while not self._stop.is_set():
            try:
                ws = WebSocket(self.url, timeout=3.0)
            except (OSError, WsClosed) as e:
                self._set(False, 'rosbridge not reachable at %s (%s)' % (self.url, e))
                self._stop.wait(backoff)
                backoff = min(backoff * 1.6, 5.0)
                continue
            self._ws, backoff = ws, 1.0
            self._set(True)
            try:
                while not self._stop.is_set():
                    self._dispatch(ws.recv())
            except (OSError, WsClosed) as e:
                self._set(False, 'rosbridge connection lost (%s)' % e)
            finally:
                self._ws = None
                ws.close()
                self._fail_pending('rosbridge connection lost')

    def _dispatch(self, raw):
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        if msg.get('op') != 'service_response':
            return
        with self._lock:
            slot = self._pending.pop(msg.get('id'), None)
        if slot:
            slot['msg'] = msg
            slot['event'].set()

    def _fail_pending(self, reason):
        with self._lock:
            pend, self._pending = self._pending, {}
        for slot in pend.values():
            slot['error'] = reason
            slot['event'].set()

    # ----------------------------------------------------------------- calls --
    def status(self):
        return {'connected': self.connected, 'url': self.url, 'error': self.last_error,
                'since': self.since}

    def call(self, service, srv_type=None, args=None, timeout=None):
        """Call a ROS service; returns the response values dict. Raises ApiError."""
        ws = self._ws
        if not ws or not self.connected:
            raise ApiError(503, 'ros_unavailable', self.last_error or
                           'rosbridge is not connected (%s).' % self.url, ROS_HINT)
        cid = 'physios-%d' % next(self._ids)
        slot = {'event': threading.Event(), 'msg': None, 'error': None}
        with self._lock:
            self._pending[cid] = slot
        req = {'op': 'call_service', 'id': cid, 'service': service, 'args': args or {}}
        if srv_type:
            req['type'] = srv_type
        try:
            with self._send_lock:
                ws.send(json.dumps(req))
        except OSError as e:
            with self._lock:
                self._pending.pop(cid, None)
            raise ApiError(503, 'ros_unavailable', 'sending to rosbridge failed: %s' % e,
                           ROS_HINT)
        if not slot['event'].wait(timeout or self.timeout_s):
            with self._lock:
                self._pending.pop(cid, None)
            raise ApiError(504, 'ros_timeout', 'ROS service %s did not answer within %.0f s.'
                           % (service, timeout or self.timeout_s),
                           'physical_ai_server may be busy or stuck; check its terminal.')
        if slot['error']:
            raise ApiError(503, 'ros_unavailable', slot['error'], ROS_HINT)
        msg = slot['msg']
        if msg.get('result') is False:
            text = msg.get('values')
            text = text if isinstance(text, str) else json.dumps(text)
            if 'does not exist' in text or 'not advertised' in text.lower():
                raise ApiError(503, 'ros_service_missing',
                               'ROS service %s is not available: %s' % (service, text),
                               'rosbridge is up but physical_ai_server is not reachable. With '
                               'rmw_zenoh this usually means the Zenoh router is not running. '
                               + ROS_HINT)
            raise ApiError(502, 'ros_call_failed', 'ROS service %s failed: %s' % (service, text))
        return msg.get('values') or {}
