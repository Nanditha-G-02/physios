# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""GitHubClient against a local stand-in of the REST endpoints it uses."""

import base64
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from physical_ai_server.planning.github_publisher import GitHubClient, GitHubError  # noqa


class FakeGitHub(BaseHTTPRequestHandler):
    state = {}

    def log_message(self, *a):
        pass

    def _send(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n)) if n else {}

    def do_GET(self):
        s = self.state
        if self.headers.get('Authorization') != 'Bearer good':
            return self._send(401, {'message': 'Bad credentials'})
        if self.path == '/user':
            return self._send(200, {'login': 'nandi', 'name': 'N'})
        if self.path == '/repos/nandi/meta':
            return self._send(200, {'default_branch': 'main'})
        if self.path.startswith('/repos/nandi/meta/git/ref/heads/'):
            b = self.path.rsplit('/', 1)[1]
            if b in s['refs']:
                return self._send(200, {'object': {'sha': s['refs'][b]}})
            return self._send(404, {'message': 'Not Found'})
        if self.path.startswith('/repos/nandi/meta/git/commits/'):
            return self._send(200, {'tree': {'sha': 'tree0'}})
        return self._send(404, {'message': 'Not Found'})

    def do_POST(self):
        s = self.state
        b = self._body()
        if self.path.endswith('/git/blobs'):
            s['blobs'].append(base64.b64decode(b['content']))
            return self._send(201, {'sha': 'blob%d' % len(s['blobs'])})
        if self.path.endswith('/git/trees'):
            s['tree'] = b
            return self._send(201, {'sha': 'tree1'})
        if self.path.endswith('/git/commits'):
            s['commit'] = b
            return self._send(201, {'sha': 'c1'})
        if self.path.endswith('/git/refs'):
            s['refs'][b['ref'].split('/')[-1]] = b['sha']
            return self._send(201, {'object': {'sha': b['sha']}})
        return self._send(404, {'message': 'nope'})

    def do_PATCH(self):
        b = self._body()
        self.state['refs'][self.path.rsplit('/', 1)[1]] = b['sha']
        return self._send(200, {})


@pytest.fixture
def api():
    FakeGitHub.state = {'refs': {'main': 'c0'}, 'blobs': []}
    srv = HTTPServer(('127.0.0.1', 0), FakeGitHub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield 'http://127.0.0.1:%d' % srv.server_address[1]
    srv.shutdown()


def test_commit_to_new_branch(api):
    c = GitHubClient('good', api=api)
    assert c.user()['login'] == 'nandi'
    res = c.commit_files('nandi/meta', 'data-v1', {'a/README.md': b'# hi', 'a/x.json': b'{}'},
                         'msg')
    st = FakeGitHub.state
    assert res['created_branch'] and st['refs']['data-v1'] == 'c1'
    assert st['commit']['parents'] == ['c0'] and st['tree']['base_tree'] == 'tree0'
    assert sorted(t['path'] for t in st['tree']['tree']) == ['a/README.md', 'a/x.json']
    assert b'# hi' in st['blobs']


def test_bad_token_and_large_file(api):
    with pytest.raises(GitHubError, match='401'):
        GitHubClient('bad', api=api).user()
    with pytest.raises(GitHubError, match='too large'):
        GitHubClient('good', api=api).commit_files('nandi/meta', 'main',
                                                   {'big.bin': b'0' * (6 << 20)}, 'm')
