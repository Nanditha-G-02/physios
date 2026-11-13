# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Learn what the installed `lerobot-train` accepts by reading its own --help.

LeRobot's training CLI changes between commits (e.g. wandb -> trackio,
eval_freq -> env_eval_freq), so commands are never built from a fixed list.
"""

import os
from pathlib import Path
import re

from physios_trainer.environment import Environments
from physios_trainer.util import atomic_write_json, read_json, run

FLAG = re.compile(r'--([A-Za-z0-9_.]+)')
CHOICES = re.compile(r'--policy\.type\s+\{([^}]*)\}')


def parse_help(text):
    flags = sorted(set(FLAG.findall(text or '')))
    m = CHOICES.search(text or '')
    types = [t.strip() for t in m.group(1).split(',')] if m else []
    return {'flags': flags, 'policy_types': types}


class Introspector:

    def __init__(self, envs: Environments, cache_dir):
        self.envs = envs
        self.cache_dir = Path(cache_dir)

    def _cache_path(self, env, lerobot_version):
        key = re.sub(r'[^A-Za-z0-9_.-]+', '_', '%s__%s' % (env['prefix'], lerobot_version))
        return self.cache_dir / ('%s.json' % key[-150:])

    def _help(self, env, extra=()):
        exe = os.path.join(env['prefix'], 'bin', 'lerobot-train')
        code, out, err = run([exe, *extra, '--help'], timeout=240,
                             env=Environments.env_vars(env))
        text = out + '\n' + err
        if 'usage:' not in text:
            raise RuntimeError('lerobot-train --help failed in %s: %s' % (
                env['name'], text.strip()[-400:]))
        return text

    def base(self, env_name, refresh=False):
        probe = self.envs.probe(env_name)
        if not probe.get('lerobot_train'):
            raise RuntimeError('Environment "%s" has no lerobot-train.' % env_name)
        env = self.envs.get(env_name)
        path = self._cache_path(env, probe['packages'].get('lerobot'))
        data = None if refresh else read_json(path)
        if not data:
            data = {'lerobot': probe['packages'].get('lerobot'), 'base': parse_help(
                self._help(env)), 'policies': {}}
            atomic_write_json(path, data)
        return data

    def policy(self, env_name, policy_type):
        data = self.base(env_name)
        if policy_type not in data['base']['policy_types']:
            raise ValueError('lerobot-train in "%s" does not offer policy type "%s".' % (
                env_name, policy_type))
        if policy_type not in data['policies']:
            env = self.envs.get(env_name)
            probe = self.envs.probe(env_name)
            data['policies'][policy_type] = parse_help(
                self._help(env, ['--policy.type=%s' % policy_type]))['flags']
            atomic_write_json(self._cache_path(env, probe['packages'].get('lerobot')), data)
        return set(data['base']['flags']) | set(data['policies'][policy_type])
