"""Minimal RFC 6455 WebSocket client (text frames, ping/pong, close), standard library only.
Enough for the rosbridge JSON protocol."""

import base64
import os
import socket
import struct
from urllib.parse import urlparse


class WsClosed(Exception):
    pass


class WebSocket:

    def __init__(self, url, timeout=3.0):
        u = urlparse(url)
        if u.scheme != 'ws':
            raise ValueError('only ws:// URLs are supported: %s' % url)
        self.host, self.port = u.hostname or '127.0.0.1', u.port or 80
        path = u.path or '/'
        self.sock = socket.create_connection((self.host, self.port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = ('GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
               'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n'
               % (path, self.host, self.port, key))
        self.sock.sendall(req.encode())
        head = b''
        while b'\r\n\r\n' not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WsClosed('connection closed during handshake')
            head += chunk
            if len(head) > 65536:
                raise WsClosed('handshake response too large')
        head, self._buf = head.split(b'\r\n\r\n', 1)
        status = head.split(b'\r\n', 1)[0]
        if b' 101 ' not in status + b' ':
            raise WsClosed('handshake refused: %s' % status.decode(errors='replace'))
        self.sock.settimeout(None)

    def _read(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(max(65536, n - len(self._buf)))
            if not chunk:
                raise WsClosed('connection closed')
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _send_frame(self, opcode, payload):
        head = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126)
            head += struct.pack('!H', n)
        else:
            head.append(0x80 | 127)
            head += struct.pack('!Q', n)
        mask = os.urandom(4)
        head += mask
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        self.sock.sendall(bytes(head) + masked)

    def send(self, text):
        self._send_frame(0x1, text.encode('utf-8'))

    def recv(self):
        """Next complete text/binary message as str; answers pings; raises WsClosed."""
        parts, opcode0 = [], None
        while True:
            b0, b1 = self._read(2)
            fin, opcode = b0 & 0x80, b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack('!H', self._read(2))[0]
            elif n == 127:
                n = struct.unpack('!Q', self._read(8))[0]
            mask = self._read(4) if b1 & 0x80 else None
            data = self._read(n)
            if mask:
                data = bytes(b ^ mask[i & 3] for i, b in enumerate(data))
            if opcode == 0x8:
                raise WsClosed('closed by peer')
            if opcode == 0x9:
                self._send_frame(0xA, data)
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x2):
                opcode0 = opcode
                parts = [data]
            elif opcode == 0x0:
                parts.append(data)
            if fin and opcode0 is not None:
                return b''.join(parts).decode('utf-8', errors='replace')

    def close(self):
        try:
            self._send_frame(0x8, b'')
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass
