"""Environment-based configuration.

Order (later wins): built-in defaults -> ``physios/configuration/physios.env`` (or the file
named by ``PHYSIOS_CONFIG``) -> process environment -> command-line flags.
Paths are resolved relative to the repository root; nothing is hard-coded to a user.
"""

import os
from pathlib import Path

HERE = Path(__file__).resolve().parent            # physios/backend/physios_gateway
PHYSIOS_DIR = HERE.parent.parent                  # physios/
REPO_DEFAULT = PHYSIOS_DIR.parent                 # physical_ai_tools/

LOOPBACK = ('127.0.0.1', 'localhost', '::1')


def _read_env_file(path):
    out = {}
    try:
        text = Path(path).read_text(encoding='utf-8')
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
            v = v[1:-1]
        out[k.strip()] = v
    return out


class Config:
    """Effective configuration. ``public()`` is what the API may show (no secrets exist here,
    but local paths are only shown to loopback clients by the app)."""

    def __init__(self, overrides=None, environ=None):
        env = dict(environ if environ is not None else os.environ)
        cfg_file = env.get('PHYSIOS_CONFIG') or str(PHYSIOS_DIR / 'configuration' / 'physios.env')
        merged = _read_env_file(cfg_file)
        merged.update({k: v for k, v in env.items() if k.startswith('PHYSIOS_')})
        merged.update({k: v for k, v in (overrides or {}).items() if v is not None})
        self.source_file = cfg_file if Path(cfg_file).exists() else None

        def get(key, default):
            v = merged.get(key)
            return default if v in (None, '') else v

        self.repo_root = Path(os.path.expanduser(get('PHYSIOS_REPO_ROOT', str(REPO_DEFAULT))))
        self.host = get('PHYSIOS_HOST', '127.0.0.1')
        self.port = int(get('PHYSIOS_PORT', '8700'))
        self.allow_remote = get('PHYSIOS_ALLOW_REMOTE', '0') in ('1', 'true', 'yes')
        self.trainer_url = get('PHYSIOS_TRAINER_URL', 'http://127.0.0.1:8766').rstrip('/')
        self.rosbridge_url = get('PHYSIOS_ROSBRIDGE_URL', 'ws://127.0.0.1:9090')
        self.camera_url = get('PHYSIOS_CAMERA_URL', 'http://127.0.0.1:8080').rstrip('/')
        roots = get('PHYSIOS_DATASET_ROOTS', os.pathsep.join([
            str(self.repo_root / 'docker' / 'huggingface' / 'lerobot'),
            '~/.cache/huggingface/lerobot']))
        self.dataset_roots = [Path(os.path.expanduser(r)).resolve()
                              for r in roots.split(os.pathsep) if r.strip()]
        self.frontend_dist = Path(os.path.expanduser(get(
            'PHYSIOS_FRONTEND_DIST', str(PHYSIOS_DIR / 'frontend' / 'dist'))))
        self.var_dir = Path(os.path.expanduser(get('PHYSIOS_VAR_DIR', str(PHYSIOS_DIR / 'var'))))
        self.trainer_dir = self.repo_root / 'physical_ai_trainer'
        self.ros_timeout_s = float(get('PHYSIOS_ROS_TIMEOUT_S', '20'))
        self.max_upload_mb = int(get('PHYSIOS_MAX_UPLOAD_MB', '128'))
        self.auth_token = get('PHYSIOS_AUTH_TOKEN', '')
        self.auth_session_h = float(get('PHYSIOS_AUTH_SESSION_H', '12'))

    def validate(self):
        problems = []
        if self.host not in LOOPBACK and not self.allow_remote:
            problems.append('PHYSIOS_HOST=%s is not a loopback address. PHYSIOS fronts services '
                            'that move the robot; set PHYSIOS_ALLOW_REMOTE=1 only on a trusted '
                            'network.' % self.host)
        if self.host not in LOOPBACK and not self.auth_token:
            problems.append('PHYSIOS_HOST=%s is reachable from the network: set PHYSIOS_AUTH_TOKEN '
                            '(at least 12 characters) so that operators must sign in.' % self.host)
        if self.auth_token and len(self.auth_token) < 12:
            problems.append('PHYSIOS_AUTH_TOKEN must be at least 12 characters long.')
        for name, url in (('PHYSIOS_TRAINER_URL', self.trainer_url),
                          ('PHYSIOS_CAMERA_URL', self.camera_url)):
            if not url.startswith('http://'):
                problems.append('%s must start with http:// (got %s)' % (name, url))
        if not self.rosbridge_url.startswith('ws://'):
            problems.append('PHYSIOS_ROSBRIDGE_URL must start with ws:// (got %s)'
                            % self.rosbridge_url)
        if not 0 < self.port < 65536:
            problems.append('PHYSIOS_PORT out of range: %s' % self.port)
        return problems

    def public(self):
        return {
            'host': self.host, 'port': self.port, 'allow_remote': self.allow_remote,
            'trainer_url': self.trainer_url, 'rosbridge_url': self.rosbridge_url,
            'camera_url': self.camera_url,
            'dataset_roots': [str(r) for r in self.dataset_roots],
            'repo_root': str(self.repo_root), 'frontend_dist': str(self.frontend_dist),
            'config_file': self.source_file, 'ros_timeout_s': self.ros_timeout_s,
            'auth_enabled': bool(self.auth_token),
        }
