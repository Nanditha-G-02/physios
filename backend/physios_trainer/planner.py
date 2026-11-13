# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Turn an operator's training configuration into validated stages.

A plan is a list of stages, each an argv list executed without a shell:
  copy     - snapshot the recorded dataset (only when conversion is needed)
  convert  - LeRobot's own v2.1 -> v3.0 converter, run on the snapshot
  train    - lerobot-train
Every flag in the train argv is checked against the installed lerobot-train.
"""

import hashlib
import json
import math
import os
from pathlib import Path
import re

from physios_trainer import catalog
from physios_trainer.util import read_json, SAFE_NAME, slug, version_tuple

NUM = re.compile(r'^-?\d+(\.\d+)?([eE]-?\d+)?$')


class PlanError(ValueError):
    pass


def token_for(stages):
    blob = json.dumps([s['argv'] for s in stages], sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()[:24]


def _bool(v):
    return 'true' if v else 'false'


def snapshot_dir(data_dir, dataset, source_mtime):
    stamp = re.sub(r'[^0-9]', '', source_mtime)[:14]
    # repo-id-safe name (letters, digits, _ - . only) - LeRobot validates repo ids
    return Path(data_dir) / 'datasets' / dataset['owner'] / (
        '%s__%s_ep%d_v30' % (dataset['name'][:50], stamp, dataset['total_episodes']))


def build(cfg, *, dataset, probe, flags, data_dir, default_output_root, existing_output_ok=False):
    """Return a plan dict; raises PlanError with an operator-facing message."""
    errors, warnings = [], []
    policy = cfg.get('policy')
    if policy not in catalog.CATALOG:
        raise PlanError('Choose a model.')
    meta = catalog.CATALOG[policy]
    prefix = probe['prefix']
    train_exe = os.path.join(prefix, 'bin', 'lerobot-train')
    py = os.path.join(prefix, 'bin', 'python')
    t = cfg.get('train') or {}

    # ---- numbers ---------------------------------------------------------
    def need_int(key, lo, hi=None):
        v = t.get(key)
        try:
            v = int(v)
        except (TypeError, ValueError):
            errors.append('%s must be a whole number.' % key.replace('_', ' ').capitalize())
            return None
        if v < lo or (hi is not None and v > hi):
            errors.append('%s must be between %s and %s.' % (key.replace('_', ' ').capitalize(),
                                                             lo, hi or 'unlimited'))
        return v

    steps = need_int('steps', 1, 5_000_000)
    batch = need_int('batch_size', 1, 1024)
    log_freq = need_int('log_freq', 1, 1_000_000)
    save_freq = need_int('save_freq', 1, 5_000_000)
    workers = need_int('num_workers', 0, 64)
    seed = need_int('seed', 0, 2**31 - 1)
    try:
        lr = float(t.get('lr'))
        if not 0 < lr < 1:
            errors.append('Learning rate must be between 0 and 1.')
    except (TypeError, ValueError):
        errors.append('Learning rate must be a number.')
        lr = None
    device = t.get('device') or 'cuda'
    if device not in ('cuda', 'cpu', 'mps'):
        errors.append('Device must be cuda or cpu.')
    if device == 'cuda' and not probe.get('cuda_available'):
        errors.append('This environment has no usable CUDA GPU; choose device "cpu" or another '
                      'environment.')
    if steps and save_freq and save_freq > steps:
        warnings.append('Save frequency is larger than the number of steps - only the final '
                        'checkpoint will be written.')
    if steps and log_freq and log_freq > steps:
        warnings.append('Log frequency is larger than the number of steps - no loss values '
                        'will be shown until the end.')

    # ---- names and paths ---------------------------------------------------
    job = slug(cfg.get('job_name') or '%s_%s' % (dataset['name'], policy))
    if not SAFE_NAME.match(job):
        errors.append('Job name may use letters, digits, "_", "-" and ".".')
    out = Path(cfg.get('output_dir') or Path(default_output_root) / job).expanduser()
    if not out.is_absolute():
        errors.append('Output directory must be an absolute path.')
    if out.exists() and not existing_output_ok:
        errors.append('Output directory %s already exists. Pick another job name, or use '
                      '"Resume" on the earlier run.' % out)

    # ---- dataset format --------------------------------------------------
    ds_v = version_tuple(dataset.get('codebase_version'))
    env_v = version_tuple(probe.get('codebase_version'))
    stages = []
    train_root = dataset['path']
    repo_id = dataset['id']
    snapshot = None
    if not dataset.get('complete'):
        errors.append('Dataset folder is incomplete (missing %s).' % ', '.join(dataset['missing']))
    if ds_v and env_v and ds_v[0] != env_v[0]:
        if ds_v[0] == 2 and env_v[0] == 3:
            if not probe.get('has_converter'):
                errors.append('Dataset is LeRobot %s but this LeRobot needs %s, and its converter '
                              'was not found.' % (dataset['codebase_version'],
                                                  probe['codebase_version']))
            snapshot = snapshot_dir(data_dir, dataset, dataset['modified'])
            manifest = read_json(snapshot / '.pam_snapshot.json') or {}
            reuse = (snapshot / 'meta' / 'info.json').exists() and manifest.get('ok')
            if reuse:
                warnings.append('Reusing the converted copy made earlier (%s).' % snapshot.name)
            else:
                stages.append({'kind': 'copy', 'desc': 'Copy %s (the recorded dataset is not '
                               'modified)' % dataset['id'],
                               'argv': ['pam-copy', dataset['path'], str(snapshot)]})
                stages.append({'kind': 'convert', 'desc': 'Convert the copy from LeRobot %s to %s '
                               'with LeRobot\'s converter' % (dataset['codebase_version'],
                                                              probe['codebase_version']),
                               'argv': [py, '-m', 'lerobot.scripts.convert_dataset_v21_to_v30',
                                        '--repo-id', '%s/%s' % (dataset['owner'], snapshot.name),
                                        '--root', str(snapshot), '--push-to-hub', 'false']})
            train_root = str(snapshot)
            repo_id = '%s/%s' % (dataset['owner'], snapshot.name)
        else:
            errors.append('Dataset is LeRobot %s; this environment\'s LeRobot reads %s and cannot '
                          'convert it.' % (dataset['codebase_version'], probe['codebase_version']))

    # ---- train argv ------------------------------------------------------
    argv = [train_exe]
    unsupported = []

    def add(flag, value):
        name = flag.lstrip('-')
        if name not in flags:
            unsupported.append('--' + name)
            return False
        if isinstance(value, float) and value.is_integer():
            value = int(value)  # JSON turns 1.0 into 1; the command (and its token) must not differ
        argv.append('--%s=%s' % (name, value))
        return True

    add('dataset.repo_id', repo_id)
    add('dataset.root', train_root)
    src = cfg.get('source') or meta['source']
    if src.get('mode') == 'path':
        path = (src.get('path') or '').strip()
        if not path:
            errors.append('Pretrained model path is empty.')
        add('policy.path', path)
    else:
        add('policy.type', policy)
    add('policy.device', device)
    if 'policy.push_to_hub' in flags:
        add('policy.push_to_hub', 'false')
    add('output_dir', str(out))
    add('job_name', job)
    for k, v in (('batch_size', batch), ('steps', steps), ('log_freq', log_freq),
                 ('save_freq', save_freq), ('num_workers', workers), ('seed', seed)):
        if v is not None:
            add(k, v)
    if lr is not None:
        if not add('policy.optimizer_lr', '%g' % lr):
            warnings.append('This LeRobot has no --policy.optimizer_lr; the policy\'s default '
                            'learning rate is used.')
            unsupported.pop()
    for k in ('wandb.enable', 'trackio.enable'):
        if k in flags:
            argv.append('--%s=false' % k)
    for k, v in (cfg.get('policy_params') or {}).items():
        if v in (None, ''):
            continue
        add('policy.%s' % k, v)
    rename = {k: v for k, v in (cfg.get('rename_map') or {}).items() if k and v}
    if rename:
        add('rename_map', json.dumps(rename, separators=(',', ':')))
    if cfg.get('empty_cameras') not in (None, ''):
        add('policy.empty_cameras', int(cfg['empty_cameras']))

    # ---- held-out validation (optional) ------------------------------------------
    val = cfg.get('validation') or {}
    if val.get('enabled'):
        if 'dataset.eval_split' not in flags or 'eval_steps' not in flags:
            errors.append('This lerobot-train cannot hold out validation episodes '
                          '(--dataset.eval_split / --eval_steps are missing). Turn validation off.')
        else:
            try:
                frac = float(val.get('eval_split', 0.1))
                every = int(val.get('eval_steps') or max(100, (steps or 1000) // 20))
            except (TypeError, ValueError):
                frac, every = None, None
                errors.append('Validation split and interval must be numbers.')
            if frac is not None:
                if not 0 < frac < 0.5:
                    errors.append('Validation split must be above 0 and below 0.5.')
                elif every < 1:
                    errors.append('Validation interval must be at least 1 step.')
                else:
                    add('dataset.eval_split', '%g' % frac)
                    add('eval_steps', every)
                    held = max(1, math.ceil(frac * total_eps(dataset, cfg)))
                    warnings.append(
                        'Validation holds out about %d of %d episodes (the last ones of each '
                        'task). Those episodes are NOT learned from, so the model sees fewer '
                        'demonstrations. With very few episodes the validation loss is a noisy '
                        'signal; once you have chosen settings, train again with it off.' %
                        (held, total_eps(dataset, cfg)))

    # ---- episodes ----------------------------------------------------------
    sel = cfg.get('episodes') or 'all'
    total = dataset['total_episodes']
    rejected = dataset.get('rejected_indices') or []
    use = list(range(total))
    if sel == 'exclude_rejected' and rejected:
        use = [i for i in use if i not in rejected]
        if 'dataset.exclude_episodes' in flags:
            add('dataset.exclude_episodes', '[%s]' % ','.join(str(i) for i in rejected))
        else:
            add('dataset.episodes', '[%s]' % ','.join(str(i) for i in use))
    elif sel == 'accepted_only':
        acc = cfg.get('_accepted_indices') or []
        use = [i for i in acc if i < total]
        if not use:
            errors.append('No accepted episodes - review episodes in Data first, or train on all.')
        else:
            add('dataset.episodes', '[%s]' % ','.join(str(i) for i in use))
    if not use:
        errors.append('No episodes left to train on.')

    # ---- advanced flags (validated against --help) ------------------------
    reserved = {a.split('=', 1)[0][2:] for a in argv[1:]}
    for k, v in (cfg.get('advanced') or {}).items():
        k = str(k).strip().lstrip('-')
        v = str(v).strip()
        if not k:
            continue
        if k in reserved:
            errors.append('--%s is already set by the form; change it there.' % k)
        elif k not in flags:
            errors.append('--%s is not an option of this lerobot-train.' % k)
        elif '\n' in v or '\x00' in v:
            errors.append('Value for --%s contains a line break.' % k)
        else:
            argv.append('--%s=%s' % (k, v))
    if unsupported:
        errors.append('This lerobot-train does not accept: %s.' % ', '.join(unsupported))

    stages.append({'kind': 'train', 'desc': 'Train %s with lerobot-train' % meta['name'],
                   'argv': argv})

    # ---- resources -----------------------------------------------------------
    est = (meta.get('est_vram_mb') or {}).get(str(batch))
    gpu = probe.get('gpu')
    if est and gpu and est > gpu['total_mb'] * 0.9 and device == 'cuda':
        warnings.append('Estimated ~%.1f GB GPU memory for batch %s, close to or above the '
                        '%.1f GB '
                        'available - lower the batch size if training stops with "CUDA out of '
                        'memory".' % (est / 1024, batch, gpu['total_mb'] / 1024))
    resources = {
        'gpu_estimate_mb': est,
        'gpu_available_mb': (gpu or {}).get('total_mb'),
        'snapshot_bytes': dataset.get('size_bytes') if any(s['kind'] == 'copy' for s in stages)
        else 0,
        'episodes_used': len(use),
        'frames_estimate': int((dataset.get('total_frames') or 0) * len(use) / max(1, total)),
    }
    plan = {'stages': stages, 'errors': errors, 'warnings': warnings, 'ok': not errors,
            'output_dir': str(out), 'job_name': job, 'dataset_root': train_root,
            'repo_id': repo_id, 'snapshot': str(snapshot) if snapshot else None,
            'env': {'name': probe['name'], 'prefix': prefix,
                    'lerobot': probe['packages'].get('lerobot'),
                    'torch': probe['packages'].get('torch'), 'python': probe.get('python')},
            'resources': resources, 'policy': policy}
    plan['token'] = token_for(stages)
    return plan


def total_eps(dataset, cfg):
    return dataset.get('total_episodes') or 0


def resume_stage(probe, flags, output_dir, extra_steps=None):
    cfg_path = Path(output_dir) / 'checkpoints' / 'last' / 'pretrained_model' / 'train_config.json'
    if not cfg_path.exists():
        raise PlanError('No checkpoint to resume from in %s.' % output_dir)
    if 'resume' not in flags or 'config_path' not in flags:
        raise PlanError('This lerobot-train cannot resume (--resume/--config_path missing).')
    argv = [os.path.join(probe['prefix'], 'bin', 'lerobot-train'),
            '--config_path=%s' % cfg_path, '--resume=true']
    if extra_steps:
        argv.append('--steps=%d' % int(extra_steps))
    return {'kind': 'train', 'desc': 'Resume from the last checkpoint', 'argv': argv}


def is_number(v):
    return bool(NUM.match(str(v)))
