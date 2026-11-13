# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading

LOCK = threading.RLock()


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec='seconds')


def atomic_write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with LOCK:
        fd, tmp = tempfile.mkstemp(prefix='.' + path.name, dir=str(path.parent))
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False, default=str)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)


def read_json(path, default=None):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def run(argv, timeout=60, env=None, cwd=None):
    """(returncode, stdout, stderr); never raises for a failing command."""
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env,
                           cwd=cwd)
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError as e:
        return 127, '', str(e)
    except subprocess.TimeoutExpired:
        return 124, '', 'timed out after %ss' % timeout


def dir_size(path):
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def version_tuple(v):
    nums = re.findall(r'\d+', str(v or ''))
    return tuple(int(x) for x in nums[:3]) if nums else ()


SAFE_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$')


def slug(text, fallback='run'):
    s = re.sub(r'[^A-Za-z0-9_.-]+', '_', str(text or '')).strip('_.-')
    return s[:80] or fallback
