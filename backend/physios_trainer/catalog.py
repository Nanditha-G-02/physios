# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Policy catalog and compatibility checks.

The memory figures are planning estimates, not measurements, except where noted
(SmolVLA batch 4 ~2.5 GB was measured on this project's RTX 3050). Whether a
policy type exists at all is decided by the installed lerobot-train, never by
this list.
"""

CATALOG = {
    'act': {
        'name': 'ACT — Action Chunking with Transformers',
        'summary': 'Fast, data-efficient imitation policy. Strong default for a single arm with '
                   '30–100 demonstrations of one task.',
        'robots': 'Any arm with joint state + action and at least one camera.',
        'language': False,
        'packages': [],
        'min_vram_mb': 3000, 'est_vram_mb': {'8': 4500, '4': 3000},
        'source': {'mode': 'type'},
        'defaults': {'steps': 50000, 'batch_size': 8, 'lr': 1e-5, 'save_freq': 10000,
                     'log_freq': 200},
        'policy_params': {'chunk_size': 100, 'n_action_steps': 100},
        'notes': 'Downloads ImageNet ResNet-18 weights on first use (internet needed once).',
    },
    'diffusion': {
        'name': 'Diffusion Policy',
        'summary': 'Denoising action generator; handles multi-modal demonstrations well but '
                   'trains longer than ACT.',
        'robots': 'Any arm; all cameras must have the same resolution.',
        'language': False,
        'packages': ['diffusers'],
        'min_vram_mb': 4000, 'est_vram_mb': {'8': 6000, '4': 4500},
        'source': {'mode': 'type'},
        'defaults': {'steps': 80000, 'batch_size': 8, 'lr': 1e-4, 'save_freq': 10000,
                     'log_freq': 200},
        'policy_params': {},
        'notes': '',
    },
    'smolvla': {
        'name': 'SmolVLA (fine-tune lerobot/smolvla_base)',
        'summary': 'Small vision-language-action model conditioned on the task instruction. '
                   'This project\'s current model family.',
        'robots': 'SO-100/SO-101 class arms; up to 3 cameras; needs a task instruction.',
        'language': True,
        'packages': ['transformers', 'num2words', 'accelerate'],
        'min_vram_mb': 3000, 'est_vram_mb': {'4': 2500, '8': 4500},
        'source': {'mode': 'path', 'path': 'lerobot/smolvla_base'},
        'defaults': {'steps': 20000, 'batch_size': 4, 'lr': 1e-4, 'save_freq': 2000,
                     'log_freq': 200},
        'policy_params': {},
        'notes': 'Batch 4 used ~2.5 GB on the RTX 3050 (measured, Run 2). Needs '
                 'lerobot/smolvla_base in the Hugging Face cache or internet access.',
    },
    'vqbet': {
        'name': 'VQ-BeT',
        'summary': 'Behaviour transformer with vector-quantised actions. Advanced users.',
        'robots': 'Any arm with one camera; sensitive to hyper-parameters.',
        'language': False,
        'packages': [],
        'min_vram_mb': 4000, 'est_vram_mb': {'8': 5000},
        'source': {'mode': 'type'},
        'defaults': {'steps': 80000, 'batch_size': 8, 'lr': 1e-4, 'save_freq': 10000,
                     'log_freq': 200},
        'policy_params': {},
        'notes': '',
    },
    'pi0': {
        'name': 'π0 (pi0)',
        'summary': '3B-parameter vision-language-action model.',
        'robots': 'General; needs a large GPU.',
        'language': True, 'packages': ['transformers'],
        'min_vram_mb': 22000, 'est_vram_mb': {}, 'source': {'mode': 'path', 'path': 'lerobot/pi0'},
        'defaults': {'steps': 30000, 'batch_size': 4, 'lr': 2.5e-5, 'save_freq': 5000,
                     'log_freq': 100},
        'policy_params': {}, 'notes': 'Far beyond a 6 GB GPU.',
    },
    'pi05': {
        'name': 'π0.5 (pi05)',
        'summary': 'Successor of π0; also several billion parameters.',
        'robots': 'General; needs a large GPU.',
        'language': True, 'packages': ['transformers'],
        'min_vram_mb': 22000, 'est_vram_mb': {},
        'source': {'mode': 'path', 'path': 'lerobot/pi05_base'},
        'defaults': {'steps': 30000, 'batch_size': 4, 'lr': 2.5e-5, 'save_freq': 5000,
                     'log_freq': 100},
        'policy_params': {}, 'notes': 'Far beyond a 6 GB GPU.',
    },
    'tdmpc': {
        'name': 'TD-MPC',
        'summary': 'Model-based reinforcement learning; needs rewards.',
        'robots': 'Simulated environments with rewards.',
        'language': False, 'packages': [], 'min_vram_mb': 0, 'est_vram_mb': {},
        'source': {'mode': 'type'}, 'defaults': {}, 'policy_params': {},
        'notes': 'Not usable with teleoperated demonstration data (no reward signal).',
        'blocked': 'Needs reward signals; recorded demonstrations have none.',
    },
}

ORDER = ['act', 'smolvla', 'diffusion', 'vqbet', 'pi0', 'pi05', 'tdmpc']


def camera_order(cameras):
    """Main/scene cameras first, wrist/gripper cameras after (for SmolVLA rename)."""
    def key(k):
        low = k.lower()
        wrist = any(w in low for w in ('gripper', 'wrist', 'hand'))
        return (wrist, k)
    return sorted(cameras, key=key)


def check(policy, dataset, probe, available_types):
    """Return {'status': ok|warn|blocked, 'reasons': [...], 'recommended': bool}."""
    meta = CATALOG.get(policy, {})
    reasons, status = [], 'ok'

    def block(msg):
        nonlocal status
        status = 'blocked'
        reasons.append(msg)

    def warn(msg):
        nonlocal status
        if status == 'ok':
            status = 'warn'
        reasons.append(msg)

    if policy not in available_types:
        block('The installed lerobot-train does not offer "%s".' % policy)
    if meta.get('blocked'):
        block(meta['blocked'])
    pk = (probe or {}).get('packages') or {}
    missing = [p for p in meta.get('packages', []) if not pk.get(p)]
    if missing:
        block('Missing Python packages in this environment: %s.' % ', '.join(missing))
    if dataset:
        cams = dataset.get('cameras') or []
        if not dataset.get('state_dim') or not dataset.get('action_dim'):
            block('Dataset has no observation.state/action features.')
        if not cams and policy in ('act', 'diffusion', 'smolvla', 'vqbet'):
            block('Dataset has no camera streams.')
        if policy == 'diffusion' and len({tuple(s or ()) for s in
                                          (dataset.get('camera_shapes') or {}).values()}) > 1:
            block('Diffusion Policy requires all cameras to have the same resolution; this '
                  'dataset has %s.' % ', '.join('%s %s' % (k.split('.')[-1], 'x'.join(
                      str(x) for x in (v or [])[:2]))
                      for k, v in dataset['camera_shapes'].items()))
        if policy == 'smolvla':
            if len(cams) > 3:
                block('SmolVLA takes at most 3 cameras; dataset has %d.' % len(cams))
            if not any((t or '').strip() for t in dataset.get('tasks') or []) and \
                    str(dataset.get('codebase_version', '')).startswith('v2'):
                warn('No task instruction found in meta/tasks.jsonl.')
        if policy == 'vqbet' and len(cams) > 1:
            warn('VQ-BeT is usually trained with a single camera.')
        n = dataset.get('total_episodes') or 0
        if n < 20:
            warn('Only %d episodes; imitation policies usually need 30 or more.' % n)
    gpu = (probe or {}).get('gpu')
    min_mb = meta.get('min_vram_mb', 0)
    if probe and not probe.get('cuda_available'):
        if min_mb > 8000:
            block('Needs a GPU with about %.0f GB memory; this environment has no CUDA GPU.' % (
                min_mb / 1024))
        elif min_mb > 0:
            warn('No CUDA GPU in this environment - training would run on the CPU and take '
                 'very long.')
    elif gpu and min_mb and gpu['total_mb'] < min_mb:
        block('Needs about %.0f GB GPU memory; %s has %.1f GB.' % (
            min_mb / 1024, gpu['name'], gpu['total_mb'] / 1024))
    recommended = status == 'ok' and policy in ('act', 'smolvla')
    return {'status': status, 'reasons': reasons, 'recommended': recommended}


def defaults_for(policy, dataset, probe):
    meta = CATALOG[policy]
    d = dict(meta.get('defaults') or {})
    gpu = (probe or {}).get('gpu')
    est = meta.get('est_vram_mb') or {}
    if gpu and est and 'batch_size' in d:
        # largest estimated batch size (not above the default) that fits in 85% of the GPU
        fits = [int(k) for k, mb in est.items()
                if int(k) <= d['batch_size'] and mb <= gpu['total_mb'] * 0.85]
        d['batch_size'] = max(fits) if fits else min(int(k) for k in est)
    d['device'] = 'cuda' if (probe or {}).get('cuda_available') else 'cpu'
    d['num_workers'] = 4
    d['seed'] = 1000
    params = dict(meta.get('policy_params') or {})
    rename = {}
    empty = None
    if policy == 'smolvla' and dataset:
        cams = camera_order(dataset.get('cameras') or [])
        rename = {k: 'observation.images.camera%d' % (i + 1) for i, k in enumerate(cams)}
        empty = max(0, 3 - len(cams))
    return {'train': d, 'policy_params': params, 'rename_map': rename, 'empty_cameras': empty,
            'source': meta['source']}
