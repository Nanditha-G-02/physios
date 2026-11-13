# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Build a small synthetic LeRobot v2.1 dataset on disk for tests.

The layout follows the v2.1 spec used by physical_ai_server (meta/info.json,
episodes.jsonl, tasks.jsonl, one parquet and one mp4 per camera per episode).
The data is synthetic - it is only used to exercise the readers.
"""

import json
import math
from pathlib import Path
import shutil
import subprocess

import numpy as np
import pandas as pd

JOINTS = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper']


def make_dataset(root, dataset_id, episodes=3, fps=30, seconds=2.0, cameras=('global',),
                 task='Pick up the red cube and place it in the tray.', videos=True,
                 width=160, height=120):
    path = Path(root) / dataset_id
    if path.exists():
        shutil.rmtree(path)
    (path / 'meta').mkdir(parents=True)
    n = int(fps * seconds)
    features = {
        'observation.state': {'dtype': 'float32', 'shape': [6], 'names': JOINTS},
        'action': {'dtype': 'float32', 'shape': [6], 'names': JOINTS},
        'timestamp': {'dtype': 'float32', 'shape': [1], 'names': None},
        'frame_index': {'dtype': 'int64', 'shape': [1], 'names': None},
        'episode_index': {'dtype': 'int64', 'shape': [1], 'names': None},
        'index': {'dtype': 'int64', 'shape': [1], 'names': None},
        'task_index': {'dtype': 'int64', 'shape': [1], 'names': None},
    }
    for cam in cameras:
        features['observation.images.' + cam] = {
            'dtype': 'video', 'shape': [height, width, 3],
            'names': ['height', 'width', 'channels'],
            'info': {'video.codec': 'libx264', 'video.pix_fmt': 'yuv420p'}}
    info = {
        'codebase_version': 'v2.1', 'robot_type': 's101_dataset', 'total_episodes': 0,
        'total_frames': 0, 'total_tasks': 1, 'total_videos': 0, 'total_chunks': 1,
        'chunks_size': 1000, 'fps': fps, 'splits': {},
        'data_path': 'data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet',
        'video_path': 'videos/chunk-{episode_chunk:03d}/{video_key}/'
                      'episode_{episode_index:06d}.mp4',
        'features': features,
    }
    (path / 'meta' / 'tasks.jsonl').write_text(json.dumps({'task_index': 0, 'task': task}) + '\n')
    (path / 'data' / 'chunk-000').mkdir(parents=True)
    (path / 'videos' / 'chunk-000').mkdir(parents=True)
    _write_info(path, info)
    for _ in range(episodes):
        append_episode(path, n_frames=n, task=task, videos=videos)
    return path


def _write_info(path, info):
    (path / 'meta' / 'info.json').write_text(json.dumps(info, indent=2))


def append_episode(path, n_frames=60, task=None, videos=True, phase=0.0):
    path = Path(path)
    info = json.loads((path / 'meta' / 'info.json').read_text())
    idx = info['total_episodes']
    fps = info['fps']
    t = np.arange(n_frames) / fps
    state = np.stack([np.sin(t * (k + 1) * 0.8 + phase + idx) * (20 + 5 * k)
                      for k in range(6)], axis=1).astype('float32')
    action = state + 0.5
    df = pd.DataFrame({
        'observation.state': list(state), 'action': list(action),
        'timestamp': t.astype('float32'), 'frame_index': np.arange(n_frames),
        'episode_index': np.full(n_frames, idx), 'index':
            np.arange(info['total_frames'], info['total_frames'] + n_frames),
        'task_index': np.zeros(n_frames, dtype='int64')})
    df.to_parquet(path / 'data' / 'chunk-000' / ('episode_%06d.parquet' % idx))
    cams = [k for k, f in info['features'].items() if f['dtype'] == 'video']
    for key in cams:
        out = path / 'videos' / 'chunk-000' / key / ('episode_%06d.mp4' % idx)
        out.parent.mkdir(parents=True, exist_ok=True)
        h, w = info['features'][key]['shape'][:2]
        if videos and shutil.which('ffmpeg'):
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                            'testsrc=size=%dx%d:rate=%d' % (w, h, fps), '-t',
                            str(n_frames / fps), '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
                            str(out)], check=True)
        else:
            out.write_bytes(b'\x00' * 32)

    # per-episode stats as written by the v2.1 recorder (meta/episodes_stats.jsonl)
    def st(arr):
        arr = np.asarray(arr, dtype='float64')
        if arr.ndim == 1:
            arr = arr[:, None]
        return {'min': arr.min(0).tolist(), 'max': arr.max(0).tolist(),
                'mean': arr.mean(0).tolist(), 'std': arr.std(0).tolist(), 'count': [len(arr)]}
    stats = {'observation.state': st(state), 'action': st(action), 'timestamp': st(t),
             'frame_index': st(np.arange(n_frames)), 'episode_index': st(np.full(n_frames, idx)),
             'index': st(np.arange(info['total_frames'], info['total_frames'] + n_frames)),
             'task_index': st(np.zeros(n_frames))}
    for key in cams:
        stats[key] = {'min': [[[0.0]]] * 3, 'max': [[[1.0]]] * 3, 'mean': [[[0.5]]] * 3,
                      'std': [[[0.25]]] * 3, 'count': [n_frames]}
    with open(path / 'meta' / 'episodes_stats.jsonl', 'a') as f:
        f.write(json.dumps({'episode_index': idx, 'stats': stats}) + '\n')
    with open(path / 'meta' / 'episodes.jsonl', 'a') as f:
        f.write(json.dumps({'episode_index': idx, 'tasks': [task or 'task'],
                            'length': n_frames}) + '\n')
    info['total_episodes'] += 1
    info['total_frames'] += n_frames
    info['total_videos'] += len(cams)
    info['splits'] = {'train': '0:%d' % info['total_episodes']}
    _write_info(path, info)
    return idx


def finite(x):
    return x is not None and math.isfinite(x)
