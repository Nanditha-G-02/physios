# Copyright 2026 ROBOTIS CO., LTD.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Publish dataset *metadata* (never videos or frame data) to GitHub.

Uses the GitHub REST API with a personal access token that the server stores
in a 0600 file and never returns to the browser.  All files go into one
commit through the Git Data API (blobs -> tree -> commit -> ref update).
Robot videos belong on the Hugging Face Hub; the generated README links there.
"""

import base64
import json
import urllib.error
import urllib.parse
import urllib.request

API = 'https://api.github.com'
MAX_FILE_BYTES = 5 * 1024 * 1024  # metadata only - refuse anything large


class GitHubError(RuntimeError):
    pass


class GitHubClient:

    def __init__(self, token, api=API, timeout=20):
        if not token:
            raise GitHubError('Not signed in to GitHub. Add a personal access token first.')
        self.token = token
        self.api = api.rstrip('/')
        self.timeout = timeout

    def _req(self, method, path, body=None, ok=(200, 201)):
        url = path if path.startswith('http') else self.api + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            'Authorization': 'Bearer ' + self.token,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'physical-ai-manager',
            'Content-Type': 'application/json',
        })
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw = r.read()
                status = r.status
        except urllib.error.HTTPError as e:
            raw = e.read()
            status = e.code
        except urllib.error.URLError as e:
            raise GitHubError('Cannot reach GitHub: %s' % e.reason)
        payload = json.loads(raw) if raw else {}
        if status not in ok:
            msg = payload.get('message', '') if isinstance(payload, dict) else ''
            if status == 401:
                raise GitHubError('GitHub rejected the token (401). Sign in again.')
            if status == 403:
                raise GitHubError('GitHub refused the request (403): %s' % msg)
            if status == 404:
                raise GitHubError('Not found on GitHub (404) - check the repository name and '
                                  'that the token can access it.')
            raise GitHubError('GitHub error %d: %s' % (status, msg))
        return status, payload

    # ---- account / repos ---------------------------------------------------
    def user(self):
        _, u = self._req('GET', '/user')
        return {'login': u.get('login'), 'name': u.get('name'),
                'avatar_url': u.get('avatar_url'), 'html_url': u.get('html_url')}

    def repos(self):
        _, rows = self._req('GET', '/user/repos?per_page=100&sort=updated&affiliation=owner,'
                                   'collaborator,organization_member')
        return [{'full_name': r['full_name'], 'private': r['private'],
                 'default_branch': r.get('default_branch'), 'html_url': r['html_url'],
                 'can_push': (r.get('permissions') or {}).get('push', False)} for r in rows]

    def branches(self, full_name):
        _, rows = self._req('GET', '/repos/%s/branches?per_page=100' % full_name)
        return [b['name'] for b in rows]

    def create_repo(self, name, private=True, description=''):
        _, r = self._req('POST', '/user/repos', {
            'name': name, 'private': bool(private), 'description': description,
            'auto_init': True})
        return {'full_name': r['full_name'], 'html_url': r['html_url'],
                'default_branch': r.get('default_branch', 'main'), 'private': r['private']}

    # ---- commit ------------------------------------------------------------
    def commit_files(self, full_name, branch, files, message, progress=None):
        """files: {path_in_repo: bytes}.  Creates the branch from the default one if needed."""
        for path, content in files.items():
            if len(content) > MAX_FILE_BYTES:
                raise GitHubError('%s is %d bytes - too large for a metadata commit. '
                                  'Upload data to Hugging Face instead.' % (path, len(content)))
        _, repo = self._req('GET', '/repos/%s' % full_name)
        default = repo.get('default_branch', 'main')
        branch = branch or default
        q = urllib.parse.quote
        try:
            _, ref = self._req('GET', '/repos/%s/git/ref/heads/%s' % (full_name, q(branch)))
            created_branch = False
        except GitHubError:
            _, base = self._req('GET', '/repos/%s/git/ref/heads/%s' % (full_name, q(default)))
            _, ref = self._req('POST', '/repos/%s/git/refs' % full_name, {
                'ref': 'refs/heads/' + branch, 'sha': base['object']['sha']})
            created_branch = True
        head_sha = ref['object']['sha']
        _, head = self._req('GET', '/repos/%s/git/commits/%s' % (full_name, head_sha))
        tree = []
        total = len(files)
        for n, (path, content) in enumerate(sorted(files.items()), 1):
            _, blob = self._req('POST', '/repos/%s/git/blobs' % full_name, {
                'content': base64.b64encode(content).decode(), 'encoding': 'base64'})
            tree.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
            if progress:
                progress(n, total + 2, 'Uploaded %s' % path)
        _, new_tree = self._req('POST', '/repos/%s/git/trees' % full_name, {
            'base_tree': head['tree']['sha'], 'tree': tree})
        _, commit = self._req('POST', '/repos/%s/git/commits' % full_name, {
            'message': message, 'tree': new_tree['sha'], 'parents': [head_sha]})
        if progress:
            progress(total + 1, total + 2, 'Created commit')
        self._req('PATCH', '/repos/%s/git/refs/heads/%s' % (full_name, q(branch)),
                  {'sha': commit['sha'], 'force': False})
        if progress:
            progress(total + 2, total + 2, 'Branch updated')
        return {'commit_sha': commit['sha'], 'branch': branch, 'created_branch': created_branch,
                'html_url': 'https://github.com/%s/commit/%s' % (full_name, commit['sha']),
                'files': sorted(files)}
