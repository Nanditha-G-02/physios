# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Dataset health analysis. Runs INSIDE the operator's Python environment
(needs numpy, pyarrow; av for the video checks) and is started by the training
service:   python -I health_probe.py <dataset_root> <result.json> [--no-video]

Reads LeRobot v2.1 and v3.0 datasets. Read-only: nothing in the dataset is
written. Prints progress lines ("PROGRESS <0-100> <text>") on stdout.
"""

import glob
import json
import math
import os
import sys
import time

import numpy as np
import pyarrow.parquet as pq


def progress(pct, text):
    print('PROGRESS %d %s' % (pct, text), flush=True)


def load_info(root):
    with open(os.path.join(root, 'meta', 'info.json')) as f:
        return json.load(f)


def load_frames(root):
    files = sorted(glob.glob(os.path.join(root, 'data', '**', '*.parquet'), recursive=True))
    if not files:
        raise RuntimeError('No parquet files under data/.')
    tables = [pq.read_table(f) for f in files]
    cols = set(tables[0].column_names)
    out = {}
    for name in cols:
        parts = []
        for t in tables:
            if name in t.column_names:
                parts.append(t.column(name).to_pylist())
        out[name] = [x for p in parts for x in p]
    return out


def as_matrix(rows):
    width = max((len(r) for r in rows if r is not None), default=0)
    m = np.full((len(rows), width), np.nan, dtype=np.float64)
    for i, r in enumerate(rows):
        if r is not None:
            m[i, :len(r)] = [np.nan if v is None else v for v in r]
    return m


def episode_video_spans(root, info, keys):
    """(episode, key) -> (path, from_s, to_s or None)."""
    spans = {}
    ver = str(info.get('codebase_version', ''))
    if ver.startswith('v2'):
        tmpl = info.get('video_path') or \
            'videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4'
        cs = info.get('chunks_size') or 1000
        for ep in range(info.get('total_episodes', 0)):
            for k in keys:
                spans[(ep, k)] = (os.path.join(root, tmpl.format(
                    episode_chunk=ep // cs, video_key=k, episode_index=ep)), 0.0, None)
        return spans
    files = sorted(glob.glob(os.path.join(root, 'meta', 'episodes', '**', '*.parquet'),
                             recursive=True))
    tmpl = info.get('video_path') or \
        'videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4'
    for f in files:
        t = pq.read_table(f).to_pydict()
        for i, ep in enumerate(t.get('episode_index', [])):
            for k in keys:
                try:
                    c = t['videos/%s/chunk_index' % k][i]
                    fi = t['videos/%s/file_index' % k][i]
                    a = t['videos/%s/from_timestamp' % k][i]
                    b = t['videos/%s/to_timestamp' % k][i]
                except KeyError:
                    continue
                spans[(ep, k)] = (os.path.join(root, tmpl.format(
                    video_key=k, chunk_index=c, file_index=fi)), a, b)
    return spans


def video_check(path, t0, t1, fps, step=3):
    """Decode a span; return frame count, longest frozen run (s), dark/bright flags,
    mean brightness and colour means."""
    import av
    res = {'frames': 0, 'frozen_s': 0.0, 'errors': None, 'mean': None, 'rgb': None,
           'size': None}
    if not os.path.exists(path):
        res['errors'] = 'missing video file'
        return res
    prev = None
    run = best = 0
    means = []
    rgb = np.zeros(3)
    try:
        with av.open(path) as c:
            s = c.streams.video[0]
            res['size'] = [s.codec_context.width, s.codec_context.height]
            if t0:
                c.seek(int(max(0.0, t0 - 1.0) / s.time_base), stream=s, backward=True,
                       any_frame=False)
            n = 0
            for fr in c.decode(s):
                ts = float(fr.pts * s.time_base) if fr.pts is not None else None
                if ts is not None and ts < t0 - 1e-3:
                    continue
                if t1 is not None and ts is not None and ts >= t1 - 1e-3:
                    break
                res['frames'] += 1
                n += 1
                if n % step:
                    continue
                img = fr.to_ndarray(format='rgb24')[::4, ::4].astype(np.float32)
                means.append(float(img.mean()))
                rgb += img.reshape(-1, 3).mean(axis=0)
                if prev is not None:
                    d = float(np.abs(img - prev).mean())
                    if d < 0.35:
                        run += step
                        best = max(best, run)
                    else:
                        run = 0
                prev = img
    except Exception as e:  # noqa: BLE001 - report, do not crash the whole report
        res['errors'] = '%s: %s' % (type(e).__name__, e)
    res['frozen_s'] = round(best / float(fps or 30), 2)
    if means:
        res['mean'] = round(float(np.mean(means)), 1)
        res['rgb'] = [round(float(v), 1) for v in (rgb / len(means))]
    return res


def clean(o):
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, set)):
        return [clean(v) for v in o]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (float, np.floating)):
        return float(o) if math.isfinite(o) else None
    return o


def find_gripper(names):
    for i, n in enumerate(names):
        if 'gripper' in str(n).lower():
            return i
    return len(names) - 1 if names else None


def main():
    root, out_path = sys.argv[1], sys.argv[2]
    do_video = '--no-video' not in sys.argv
    t_start = time.time()
    info = load_info(root)
    fps = float(info.get('fps') or 30)
    feats = info.get('features') or {}
    progress(3, 'reading data')
    data = load_frames(root)
    missing_cols = [c for c in ('observation.state', 'action', 'episode_index', 'timestamp')
                    if c not in data]
    if 'episode_index' in missing_cols:
        raise RuntimeError('No episode_index column.')
    ep_idx = np.asarray(data['episode_index'])
    episodes = sorted(set(int(e) for e in ep_idx))
    act_names = (feats.get('action') or {}).get('names') or []
    if isinstance(act_names, dict):
        act_names = next(iter(act_names.values()), [])
    act = as_matrix(data['action']) if 'action' in data else None
    st = as_matrix(data['observation.state']) if 'observation.state' in data else None
    ts = np.asarray(data.get('timestamp') or [np.nan] * len(ep_idx), dtype=float)
    width = act.shape[1] if act is not None else 0
    names = list(act_names) or ['joint%d' % i for i in range(width)]
    g = find_gripper(names)
    cams = [k for k, v in feats.items() if (v or {}).get('dtype') == 'video']

    # global joint ranges (robust)
    ref = act if act is not None else st
    lo = np.nanpercentile(ref, 1, axis=0)
    hi = np.nanpercentile(ref, 99, axis=0)
    span = np.maximum(hi - lo, 1e-6)
    joints = [{'name': names[j] if j < len(names) else 'j%d' % j,
               'min': round(float(np.nanmin(ref[:, j])), 3),
               'max': round(float(np.nanmax(ref[:, j])), 3),
               'p1': round(float(lo[j]), 3), 'p99': round(float(hi[j]), 3)}
              for j in range(ref.shape[1])]
    g_mid = (lo[g] + hi[g]) / 2 if g is not None else None

    eps = []
    for n, e in enumerate(episodes):
        m = ep_idx == e
        a = ref[m]
        L = int(m.sum())
        rec = {'episode': e, 'frames': L, 'duration_s': round(L / fps, 2), 'issues': []}
        nan_a = int(np.isnan(act[m]).sum()) if act is not None else None
        nan_s = int(np.isnan(st[m]).sum()) if st is not None else None
        rec['nan_values'] = (nan_a or 0) + (nan_s or 0)
        t = ts[m]
        if np.isfinite(t).all() and L > 1:
            gaps = np.diff(np.sort(t))
            rec['max_gap_s'] = round(float(gaps.max()), 3)
            if gaps.max() > 2.5 / fps:
                rec['issues'].append({'level': 'warn', 'code': 'time_gap',
                                      'text': 'Gap of %.2f s between frames.' % gaps.max()})
        # motion / idle
        if L > 2:
            d = np.abs(np.diff(a, axis=0)) / span
            arm = np.delete(d, g, axis=1) if g is not None and d.shape[1] > 1 else d
            moving = arm.max(axis=1) > 0.002
            rec['moving_fraction'] = round(float(moving.mean()), 3)
            idx = np.where(moving)[0]
            rec['idle_start_s'] = round((idx[0] if len(idx) else L) / fps, 2)
            rec['idle_end_s'] = round((L - 1 - (idx[-1] if len(idx) else 0)) / fps, 2)
            rec['path_length'] = round(float(arm.sum()), 2)
        else:
            rec.update(moving_fraction=0.0, idle_start_s=0.0, idle_end_s=0.0, path_length=0.0)
        # gripper cycles: crossings of the mid level with hysteresis
        if g is not None:
            gv = a[:, g]
            band = 0.15 * span[g]
            state = None
            cross = []
            for i, v in enumerate(gv):
                s2 = 'hi' if v > g_mid + band else ('lo' if v < g_mid - band else state)
                if state is not None and s2 != state:
                    cross.append((i, s2))
                state = s2
            rec['gripper_changes'] = len(cross)
            rec['gripper_range'] = round(float(np.nanmax(gv) - np.nanmin(gv)), 3)
            first = cross[0][0] if cross else None
            # arm motion after the first gripper change (lift / transport)
            if first is not None and first < L - 2:
                rec['motion_after_grasp'] = round(float(
                    (np.abs(np.diff(a[first:], axis=0)) / span).sum()), 2)
            else:
                rec['motion_after_grasp'] = 0.0
        # per-episode out-of-range
        out = [names[j] for j in range(a.shape[1])
               if np.nanmin(a[:, j]) < lo[j] - 0.1 * span[j] or
               np.nanmax(a[:, j]) > hi[j] + 0.1 * span[j]]
        if out:
            rec['issues'].append({'level': 'warn', 'code': 'joint_outlier',
                                  'text': 'Unusual range for %s.' % ', '.join(out)})
        eps.append(rec)
        if n % 5 == 0:
            progress(5 + int(25 * (n + 1) / len(episodes)), 'episode %d' % e)

    lens = np.array([r['frames'] for r in eps], dtype=float)
    med = float(np.median(lens)) if len(lens) else 0
    for r in eps:
        if r['frames'] < max(2 * fps, 0.4 * med):
            r['issues'].append({'level': 'warn', 'code': 'short',
                                'text': 'Very short (%.1f s; median %.1f s).' % (
                                    r['duration_s'], med / fps)})
        if med and r['frames'] > 2.5 * med:
            r['issues'].append({'level': 'info', 'code': 'long',
                                'text': 'Much longer than usual (%.1f s).' % r['duration_s']})
        if r['moving_fraction'] < 0.2:
            r['issues'].append({'level': 'warn', 'code': 'idle',
                                'text': 'Arm moves in only %d%% of the frames.' % (
                                    100 * r['moving_fraction'])})
        if max(r['idle_start_s'], r['idle_end_s']) > 3:
            r['issues'].append({'level': 'info', 'code': 'idle_edges',
                                'text': 'Idle %.1f s at the start, %.1f s at the end.' % (
                                    r['idle_start_s'], r['idle_end_s'])})
        if r['nan_values']:
            r['issues'].append({'level': 'error', 'code': 'nan',
                                'text': '%d missing values in state/action.' % r['nan_values']})
        gc = r.get('gripper_changes')
        if gc is not None:
            if gc == 0:
                r['issues'].append({'level': 'warn', 'code': 'no_grasp',
                                    'text': 'Gripper never closed or opened - likely no grasp.'})
            elif gc == 1:
                r['issues'].append({'level': 'warn', 'code': 'no_release',
                                    'text': 'Gripper changed only once - grasp without release '
                                            '(or release without grasp).'})
            if gc >= 1 and r.get('motion_after_grasp', 0) < 0.3:
                r['issues'].append({'level': 'warn', 'code': 'no_lift',
                                    'text': 'Arm barely moves after the gripper changed - '
                                            'object probably not lifted/placed.'})

    # videos
    cam_stats = {k: {'sizes': set(), 'means': []} for k in cams}
    if do_video and cams:
        try:
            spans = episode_video_spans(root, info, cams)
        except Exception as e:  # noqa: BLE001
            spans = {}
            for r in eps:
                r['issues'].append({'level': 'warn', 'code': 'video_index',
                                    'text': 'Could not locate videos: %s' % e})
        total = len(eps) * len(cams)
        k = 0
        for r in eps:
            r['video'] = {}
            for cam in cams:
                k += 1
                sp = spans.get((r['episode'], cam))
                if not sp:
                    continue
                v = video_check(sp[0], sp[1], sp[2], fps)
                short = cam.split('.')[-1]
                r['video'][short] = v
                if v['size']:
                    cam_stats[cam]['sizes'].add(tuple(v['size']))
                if v['mean'] is not None:
                    cam_stats[cam]['means'].append(v['mean'])
                if v['errors']:
                    r['issues'].append({'level': 'error', 'code': 'video_error',
                                        'text': '%s video: %s' % (short, v['errors'])})
                elif abs(v['frames'] - r['frames']) > 2:
                    r['issues'].append({'level': 'warn', 'code': 'video_frames',
                                        'text': '%s video has %d frames, data has %d.' % (
                                            short, v['frames'], r['frames'])})
                if v['frozen_s'] >= 1.0:
                    r['issues'].append({'level': 'warn', 'code': 'frozen',
                                        'text': '%s image frozen for %.1f s.' % (
                                            short, v['frozen_s'])})
                if v['mean'] is not None and (v['mean'] < 25 or v['mean'] > 235):
                    r['issues'].append({'level': 'warn', 'code': 'exposure',
                                        'text': '%s image is %s (mean %d).' % (
                                            short, 'very dark' if v['mean'] < 25 else
                                            'very bright', v['mean'])})
                progress(30 + int(68 * k / max(1, total)),
                         'video %s ep %d' % (short, r['episode']))

    # summary + recommendations
    counts = {}
    for r in eps:
        for i in r['issues']:
            counts[i['code']] = counts.get(i['code'], 0) + 1
    worst = {}
    for r in eps:
        lv = [i['level'] for i in r['issues']]
        r['status'] = 'error' if 'error' in lv else 'warn' if 'warn' in lv else 'ok'
        worst[r['status']] = worst.get(r['status'], 0) + 1
    rec = []
    if counts.get('no_grasp') or counts.get('no_lift'):
        rec.append('Watch the episodes flagged "no grasp"/"not lifted" in Data and reject failed '
                   'demonstrations before training - the policy copies them.')
    if counts.get('frozen') or counts.get('video_error'):
        rec.append('Some camera streams froze or are unreadable; check the camera connection and '
                   're-record those episodes.')
    if counts.get('short') or counts.get('idle'):
        rec.append('Very short or mostly idle episodes add little; consider rejecting them.')
    if counts.get('idle_edges'):
        rec.append('Long idle time at the start/end teaches the policy to wait; keep resets '
                   'short.')
    if len(eps) < 30:
        rec.append('Only %d episodes - 40-60 demonstrations covering the whole workspace usually '
                   'give a more reliable grasp.' % len(eps))
    if counts.get('nan'):
        rec.append('Missing values will break training; exclude those episodes.')
    cams_out = []
    for k2, v in cam_stats.items():
        cams_out.append({'key': k2, 'sizes': [list(s) for s in v['sizes']],
                         'brightness_mean': round(float(np.mean(v['means'])), 1)
                         if v['means'] else None,
                         'brightness_spread': round(float(np.std(v['means'])), 1)
                         if v['means'] else None})
    result = {
        'dataset': root, 'codebase_version': info.get('codebase_version'), 'fps': fps,
        'episodes': eps, 'joints': joints, 'gripper_joint': names[g] if g is not None else None,
        'cameras': cams_out, 'video_checked': bool(do_video and cams),
        'missing_columns': missing_cols,
        'summary': {'episodes': len(eps), 'ok': worst.get('ok', 0), 'warn': worst.get('warn', 0),
                    'error': worst.get('error', 0), 'issue_counts': counts,
                    'duration_median_s': round(med / fps, 2) if med else None,
                    'duration_min_s': round(float(lens.min()) / fps, 2) if len(lens) else None,
                    'duration_max_s': round(float(lens.max()) / fps, 2) if len(lens) else None,
                    'durations_s': [r['duration_s'] for r in eps]},
        'recommendations': rec,
        'elapsed_s': round(time.time() - t_start, 1),
    }
    tmp = out_path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(clean(result), f, allow_nan=False)
    os.replace(tmp, out_path)
    progress(100, 'done')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print('ERROR %s: %s' % (type(e).__name__, e), flush=True)
        sys.exit(1)
