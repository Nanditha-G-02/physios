# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Inspect the host and the Python environments that can run LeRobot.

Nothing here installs, upgrades or modifies anything: environments are only
probed by running their own interpreter with a read-only script.
"""

import glob
import json
import os
from pathlib import Path
import platform
import re
import shutil
import sys
import time

from physios_trainer.util import run

PROBE = r'''
import json, sys, importlib, importlib.util
out = {"python": sys.version.split()[0], "executable": sys.executable, "packages": {}}
def ver(name):
    try:
        from importlib.metadata import version
        return version(name)
    except Exception:
        return None
for pkg in ["lerobot", "torch", "torchvision", "datasets", "av", "torchcodec", "transformers",
            "diffusers", "num2words", "accelerate", "draccus", "huggingface_hub", "safetensors"]:
    out["packages"][pkg] = ver(pkg)
try:
    import torch
    out["torch_cuda_build"] = torch.version.cuda
    out["cuda_available"] = bool(torch.cuda.is_available())
    if out["cuda_available"]:
        p = torch.cuda.get_device_properties(0)
        out["gpu"] = {"name": p.name, "total_mb": int(p.total_memory / 2**20),
                      "capability": "%d.%d" % (p.major, p.minor),
                      "count": torch.cuda.device_count()}
except Exception as e:
    out["torch_error"] = str(e)[:300]
cv = None
for mod in ("lerobot.datasets.dataset_metadata", "lerobot.datasets.lerobot_dataset",
            "lerobot.common.datasets.lerobot_dataset"):
    try:
        cv = importlib.import_module(mod).CODEBASE_VERSION
        break
    except Exception:
        continue
out["codebase_version"] = cv
out["has_converter"] = bool(out["packages"]["lerobot"]) and importlib.util.find_spec(
    "lerobot.scripts.convert_dataset_v21_to_v30") is not None
print("PAM_PROBE" + json.dumps(out))
'''


def _meminfo():
    info = {}
    try:
        with open('/proc/meminfo') as f:
            for line in f:
                k, v = line.split(':', 1)
                info[k] = int(v.strip().split()[0]) * 1024
    except OSError:
        pass
    return info


def nvidia_smi():
    if not shutil.which('nvidia-smi'):
        return {'available': False, 'reason': 'nvidia-smi not found'}
    code, out, err = run(['nvidia-smi', '--query-gpu=index,name,memory.total,memory.used,'
                          'utilization.gpu,driver_version', '--format=csv,noheader,nounits'],
                         timeout=10)
    if code != 0:
        return {'available': False, 'reason': (err or out).strip()[:200]}
    gpus = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(',')]
        if len(parts) >= 6:
            gpus.append({'index': int(parts[0]), 'name': parts[1],
                         'memory_total_mb': _int(parts[2]), 'memory_used_mb': _int(parts[3]),
                         'utilization_pct': _int(parts[4]), 'driver': parts[5]})
    code, out, _ = run(['nvidia-smi'], timeout=10)
    m = re.search(r'CUDA Version:\s*([\d.]+)', out or '')
    return {'available': bool(gpus), 'gpus': gpus, 'driver_cuda': m.group(1) if m else None}


def _int(x):
    try:
        return int(float(x))
    except (TypeError, ValueError):
        return None


def os_release():
    try:
        data = dict(line.rstrip().split('=', 1) for line in open('/etc/os-release') if '=' in line)
        return data.get('PRETTY_NAME', '').strip('"')
    except OSError:
        return platform.platform()


def system_info(paths=()):
    mem = _meminfo()
    disks = []
    for p in paths:
        try:
            u = shutil.disk_usage(p)
            disks.append({'path': str(p), 'total': u.total, 'free': u.free})
        except OSError:
            pass
    return {
        'os': os_release(),
        'kernel': platform.release(),
        'machine': platform.machine(),
        'cpu_count': os.cpu_count(),
        'ram_total': mem.get('MemTotal'),
        'ram_available': mem.get('MemAvailable'),
        'disks': disks,
        'gpu': nvidia_smi(),
        'agent_python': sys.version.split()[0],
        'active_conda_env': os.environ.get('CONDA_DEFAULT_ENV'),
    }


def find_conda():
    cands = [os.environ.get('CONDA_EXE'), shutil.which('conda'), shutil.which('mamba')]
    home = Path.home()
    for base in ('miniconda3', 'anaconda3', 'miniforge3', 'mambaforge'):
        cands.append(str(home / base / 'bin' / 'conda'))
    for c in cands:
        if c and os.path.exists(c):
            return c
    return None


class Environments:
    """Discovers conda environments (plus explicitly configured prefixes)."""

    def __init__(self, extra=None, cache_s=120):
        self.extra = dict(extra or {})  # name -> prefix
        self.cache_s = cache_s
        self._cache = {}

    def list(self):
        envs = {}
        conda = find_conda()
        if conda:
            code, out, _ = run([conda, 'env', 'list', '--json'], timeout=30)
            if code == 0:
                try:
                    for prefix in json.loads(out).get('envs', []):
                        in_envs = Path(prefix).parent.name == 'envs'
                        name = Path(prefix).name if in_envs else 'base'
                        envs[name] = {'name': name, 'prefix': prefix, 'kind': 'conda'}
                except ValueError:
                    pass
        if not envs:  # conda not on PATH for the agent: look at the usual folders
            for pat in ('~/miniconda3', '~/anaconda3', '~/miniforge3'):
                base = os.path.expanduser(pat)
                if os.path.isdir(base):
                    envs.setdefault('base', {'name': 'base', 'prefix': base, 'kind': 'conda'})
                    for p in glob.glob(os.path.join(base, 'envs', '*')):
                        envs.setdefault(Path(p).name, {'name': Path(p).name, 'prefix': p,
                                                       'kind': 'conda'})
        for name, prefix in self.extra.items():
            envs[name] = {'name': name, 'prefix': prefix, 'kind': 'configured'}
        return [envs[k] for k in sorted(envs)]

    def get(self, name):
        for e in self.list():
            if e['name'] == name:
                return e
        raise KeyError('Environment "%s" not found.' % name)

    def probe(self, name, refresh=False):
        env = self.get(name)
        key = env['prefix']
        hit = self._cache.get(key)
        if hit and not refresh and time.time() - hit[0] < self.cache_s:
            return hit[1]
        py = os.path.join(env['prefix'], 'bin', 'python')
        result = dict(env)
        if not os.path.exists(py):
            result.update(ok=False, error='No python in %s' % env['prefix'])
        else:
            code, out, err = run([py, '-c', PROBE], timeout=120, env=self.env_vars(env))
            line = next((ln for ln in out.splitlines() if ln.startswith('PAM_PROBE')), None)
            if line:
                result.update(json.loads(line[len('PAM_PROBE'):]))
                result['ok'] = True
            else:
                result.update(ok=False, error=(err or out).strip()[-500:])
        exe = os.path.join(env['prefix'], 'bin', 'lerobot-train')
        result['lerobot_train'] = os.path.exists(exe)
        self._cache[key] = (time.time(), result)
        return result

    @staticmethod
    def env_vars(env, base=None):
        """Process environment equivalent to `conda activate <env>` for running its tools."""
        e = dict(base if base is not None else os.environ)
        prefix = env['prefix']
        e['PATH'] = os.path.join(prefix, 'bin') + os.pathsep + e.get('PATH', '')
        e['CONDA_PREFIX'] = prefix
        e['CONDA_DEFAULT_ENV'] = env['name']
        e['PYTHONUNBUFFERED'] = '1'
        e.pop('PYTHONPATH', None)
        e.pop('PYTHONHOME', None)
        return e
