# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0
"""Optional operator authentication.

Off by default: on a loopback-only gateway the operating-system user is the boundary, as
before. When ``PHYSIOS_AUTH_TOKEN`` is set (required for a non-loopback ``PHYSIOS_HOST``):

* ``POST /api/v1/auth/login {"token": ...}`` compares the token in constant time and issues a
  random session id as an HttpOnly, SameSite=Strict cookie (``physios_session``);
* scripts may instead send ``Authorization: Bearer <token>``;
* every ``/api/v1`` route except ``/auth/*`` and the ``/ros`` WebSocket then requires a valid
  session; the static frontend stays public so the login screen can load;
* five failed logins from one address within a minute block that address for a minute.

Sessions live in memory (a gateway restart signs everyone out) and expire after
``PHYSIOS_AUTH_SESSION_H`` hours (default 12).
"""
import hmac
import secrets
import threading
import time

COOKIE = 'physios_session'
MAX_FAILS = 5
FAIL_WINDOW_S = 60


class Auth:
    def __init__(self, token, session_hours=12.0, clock=time.time):
        self.token = token or ''
        self.ttl = float(session_hours) * 3600
        self.clock = clock
        self._sessions = {}
        self._fails = {}
        self._lock = threading.Lock()

    @property
    def enabled(self):
        return bool(self.token)

    # ------------------------------------------------------------------ checks --
    def _token_ok(self, candidate):
        return bool(candidate) and hmac.compare_digest(
            str(candidate).encode(), self.token.encode())

    def session_of(self, headers):
        """Session id from the request cookie, if it is valid."""
        raw = headers.get('Cookie') or ''
        for part in raw.split(';'):
            k, _, v = part.strip().partition('=')
            if k == COOKIE and v:
                with self._lock:
                    exp = self._sessions.get(v)
                    if exp and exp > self.clock():
                        return v
                    self._sessions.pop(v, None)
        return None

    def allowed(self, headers):
        if not self.enabled:
            return True
        authz = headers.get('Authorization') or ''
        if authz.lower().startswith('bearer ') and self._token_ok(authz[7:].strip()):
            return True
        return self.session_of(headers) is not None

    # --------------------------------------------------------------- sessions --
    def blocked(self, addr):
        now = self.clock()
        with self._lock:
            fails = [t for t in self._fails.get(addr, []) if now - t < FAIL_WINDOW_S]
            self._fails[addr] = fails
            return len(fails) >= MAX_FAILS

    def login(self, addr, candidate):
        """Returns a new session id, or None for a wrong token."""
        if self._token_ok(candidate):
            sid = secrets.token_urlsafe(32)
            with self._lock:
                now = self.clock()
                self._sessions = {k: e for k, e in self._sessions.items() if e > now}
                self._sessions[sid] = now + self.ttl
                self._fails.pop(addr, None)
            return sid
        with self._lock:
            self._fails.setdefault(addr, []).append(self.clock())
        return None

    def logout(self, headers):
        sid = self.session_of(headers)
        if sid:
            with self._lock:
                self._sessions.pop(sid, None)

    def cookie(self, sid, secure=False):
        attrs = ['%s=%s' % (COOKIE, sid), 'Path=/', 'HttpOnly', 'SameSite=Strict',
                 'Max-Age=%d' % int(self.ttl)]
        if secure:
            attrs.append('Secure')
        return '; '.join(attrs)

    @staticmethod
    def clear_cookie():
        return '%s=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' % COOKIE
