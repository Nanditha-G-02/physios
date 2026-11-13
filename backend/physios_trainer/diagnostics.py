# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Training diagnostics: summarise a run's logged metrics and detect problems.

Everything here is computed from values that lerobot-train really logged
(``loss``, ``grdn``, ``lr``, ``updt_s``, ``data_s``, ``epch``, ``eval_loss``) and from the
GPU samples the service takes every 3 s. Nothing is estimated or invented. Every issue
carries the numbers that triggered it so the operator can check them.

Caveats the UI repeats:
* ``grdn`` is the gradient norm *before* clipping (torch ``clip_grad_norm_`` returns the
  pre-clip total), so ``grdn > clip`` means the update was clipped.
* GPU memory is the whole-GPU figure from nvidia-smi - other programs count too.
* A training or validation loss says nothing certain about grasp success.
"""

import math
import statistics

DEFAULT_CLIP = 10.0  # LeRobot's optimizer_grad_clip_norm default for the policies we list

FINISHED = ('succeeded', 'failed', 'stopped')
SEVERITY_ORDER = {'critical': 0, 'warning': 1, 'info': 2}


def _num(v):
    return isinstance(v, (int, float)) and math.isfinite(v)


is_num = _num


def _med(xs):
    xs = [x for x in xs if _num(x)]
    return statistics.median(xs) if xs else None


def _smooth(vals, k):
    """Median over consecutive blocks of k values (robust against single spikes)."""
    out = []
    for i in range(0, len(vals), k):
        blk = vals[i:i + k]
        if blk:
            out.append(statistics.median(blk))
    return out


def step_times(rows):
    """Seconds per optimisation step between consecutive exact log lines."""
    out = []
    prev = None
    for r in rows:
        if not r.get('step_exact') or 't' not in r:
            prev = None
            continue
        if prev and r['step'] > prev['step'] and r['t'] > prev['t']:
            out.append({'step': r['step'], 's': (r['t'] - prev['t']) / (r['step'] - prev['step'])})
        prev = r
    return out


def gpu_series(resources, rows):
    """GPU memory (MB) against training step, matching samples to the nearest log line."""
    pts = [(r['t'], r['gpu']['memory_used_mb'], r['gpu'].get('memory_total_mb'))
           for r in resources if r.get('gpu') and _num(r['gpu'].get('memory_used_mb'))]
    steps = [(r['t'], r['step']) for r in rows if 't' in r and 'step' in r]
    out = []
    j = 0
    for t, used, total in pts:
        while j + 1 < len(steps) and steps[j + 1][0] <= t:
            j += 1
        if steps and steps[0][0] <= t:
            out.append({'step': steps[j][1], 'mb': used, 'total_mb': total, 't': t})
    return out


def summarize(rows, evals, resources):
    train = [r for r in rows if r.get('kind') != 'eval']
    losses = [r['loss'] for r in train if _num(r.get('loss'))]
    st = step_times(train)
    stm = [x['s'] for x in st]
    gpu = [r['gpu'] for r in resources if r.get('gpu') and _num(r['gpu'].get('memory_used_mb'))]
    # steps per epoch from the logged epoch counter (epch)
    ep = [(r['step'], r['epch']) for r in train if _num(r.get('epch')) and r.get('step')]
    steps_per_epoch = None
    if len(ep) >= 2 and ep[-1][1] > ep[0][1]:
        steps_per_epoch = (ep[-1][0] - ep[0][0]) / (ep[-1][1] - ep[0][1])
    med_step = _med(stm)
    s = {
        'points': len(train),
        'last_step': train[-1]['step'] if train else None,
        'loss_last': losses[-1] if losses else None,
        'loss_min': min(losses) if losses else None,
        'loss_first': losses[0] if losses else None,
        'grdn_last': next((r['grdn'] for r in reversed(train) if _num(r.get('grdn'))), None),
        'lr_last': next((r['lr'] for r in reversed(train) if _num(r.get('lr'))), None),
        'step_time_s': med_step,
        'steps_per_s': (1.0 / med_step) if med_step else None,
        'data_s': _med([r.get('data_s') for r in train[-20:]]),
        'update_s': _med([r.get('updt_s') for r in train[-20:]]),
        'steps_per_epoch': steps_per_epoch,
        'epoch_duration_s': steps_per_epoch * med_step if steps_per_epoch and med_step else None,
        'epochs_done': ep[-1][1] if ep else None,
        'eval_last': next((e['eval_loss'] for e in reversed(evals) if _num(e.get('eval_loss'))),
                          None),
        'eval_min': min((e['eval_loss'] for e in evals if _num(e.get('eval_loss'))), default=None),
        'gpu_peak_mb': max((g['memory_used_mb'] for g in gpu), default=None),
        'gpu_total_mb': next((g.get('memory_total_mb') for g in reversed(gpu)), None),
    }
    s['stability'] = stability(losses)
    return s


def stability(losses):
    """Share of steps whose loss jumped to >2x the median of the 10 values before it."""
    if len(losses) < 12:
        return {'label': 'not enough data', 'spikes': 0, 'spike_rate': None, 'score': None}
    spikes = 0
    n = 0
    for i in range(10, len(losses)):
        base = statistics.median(losses[i - 10:i])
        n += 1
        if base > 0 and losses[i] > 2 * base:
            spikes += 1
    rate = spikes / n
    label = 'stable' if rate < 0.02 else 'noisy' if rate < 0.10 else 'unstable'
    return {'label': label, 'spikes': spikes, 'spike_rate': round(rate, 4),
            'score': round(1 - min(1, rate * 5), 3)}


def _issue(iid, severity, title, detail, evidence, action, levers):
    return {'id': iid, 'severity': severity, 'title': title, 'detail': detail,
            'evidence': evidence, 'action': action, 'levers': levers}


def detect(rows, evals, resources, config, status=None, error_tail=None, clip_norm=None):
    """Return a list of issues, most severe first. Pure function of its inputs."""
    config = config or {}
    train = [r for r in rows if r.get('kind') != 'eval']
    issues = []
    clip = clip_norm if _num(clip_norm) and clip_norm > 0 else DEFAULT_CLIP
    err_text = ' '.join(error_tail or []).lower()
    stop = '' if status in FINISHED else 'Stop the run. '

    # ---- NaN / infinite --------------------------------------------------------------
    bad = [r for r in train if 'loss' in (r.get('nonfinite') or [])]
    bad_eval = [e for e in evals if 'eval_loss' in (e.get('nonfinite') or [])]
    if bad or bad_eval:
        first = (bad or bad_eval)[0]
        issues.append(_issue(
            'nonfinite_loss', 'critical', 'Loss became NaN or infinite',
            'lerobot-train logged a non-finite %s at step %d. Training cannot recover from this '
            'state; later checkpoints are worthless.' % ('loss' if bad else 'eval_loss',
                                                          first['step']),
            {'first_step': first['step'], 'train_lines': len(bad), 'eval_lines': len(bad_eval)},
            stop + 'Restart from the last checkpoint written BEFORE this step with a lower '
            'learning rate and a lower gradient-clip norm, and use full precision if mixed '
            'precision was on.', ['lr_down', 'clip_down', 'fp32', 'warmup_up']))

    losses = [r['loss'] for r in train if _num(r.get('loss'))]
    steps = [r['step'] for r in train if _num(r.get('loss'))]

    # ---- loss explosion ----------------------------------------------------------------
    if len(losses) >= 12:
        blocks = _smooth(losses, 5)
        best = min(blocks[:-1])
        recent = blocks[-1]
        grdn = [r['grdn'] for r in train if _num(r.get('grdn'))]
        gm = _med(grdn[:-5]) if len(grdn) > 10 else None
        gl = _med(grdn[-5:]) if len(grdn) > 10 else None
        onset = steps[-1]
        for bi in range(1, len(blocks)):
            if blocks[bi] > 3 * min(blocks[:bi]):
                onset = steps[min(bi * 5, len(steps) - 1)]
                break
        if best > 0 and recent > 5 * best and recent > blocks[0] * 0.5 and not bad:
            issues.append(_issue(
                'loss_explosion', 'critical', 'Loss exploded',
                'The recent loss is %.1fx the best earlier level.' % (recent / best),
                {'recent_loss': round(recent, 5), 'best_earlier_loss': round(best, 5),
                 'ratio': round(recent / best, 2), 'step': steps[-1], 'onset_step': onset,
                 'grad_norm_recent': gl, 'grad_norm_before': gm},
                stop + 'Restart from a checkpoint before the jump with a lower learning '
                'rate (about a third) and a lower gradient-clip norm.',
                ['lr_down', 'clip_down', 'warmup_up']))
        elif gm and gl and gm > 0 and gl > 20 * gm and not bad:
            issues.append(_issue(
                'grad_explosion', 'warning', 'Gradient norm jumped',
                'The gradient norm is %.0fx its earlier level - the loss may follow.' % (gl / gm),
                {'grad_norm_recent': round(gl, 3), 'grad_norm_before': round(gm, 3),
                 'step': steps[-1]},
                'Watch the next log lines. If the loss rises too, stop and restart with a lower '
                'learning rate and clip norm.', ['lr_down', 'clip_down']))

    # ---- stagnation --------------------------------------------------------------------
    if len(losses) >= 40:
        k = max(3, len(losses) // 10)
        last = _med(losses[-k:])
        old = _med(losses[len(losses) // 2 - k:len(losses) // 2]) if len(losses) // 2 >= k \
            else None
        lrs = [r['lr'] for r in train[-k:] if _num(r.get('lr'))]
        lr_tiny = bool(lrs) and max(lrs) < 1e-7
        if old and last is not None and old > 0 and not any(i['id'] == 'loss_explosion'
                                                             for i in issues):
            gain = (old - last) / old
            if gain < 0.01 and not lr_tiny:
                issues.append(_issue(
                    'stagnation', 'warning', 'Training loss has stopped improving',
                    'Over the last %d logged points the loss improved by %.2f%% (%.4f -> %.4f).' %
                    (k * 2, gain * 100, old, last),
                    {'loss_before': round(old, 5), 'loss_now': round(last, 5),
                     'improvement_pct': round(gain * 100, 3), 'window_points': k * 2,
                     'step': steps[-1]},
                    'A flat loss can mean the learning rate is too low, too high (noise floor), '
                    'or that the model has simply fitted this small dataset. Compare with the '
                    'validation loss and a robot trial before changing anything.',
                    ['lr_up', 'lr_down', 'wd_up']))

    # ---- overfitting ---------------------------------------------------------------------
    ev = [e for e in evals if _num(e.get('eval_loss'))]
    if len(ev) >= 3 and len(losses) >= 20:
        last3 = [e['eval_loss'] for e in ev[-3:]]
        rising = last3[0] < last3[1] < last3[2]
        lo = min(e['eval_loss'] for e in ev)
        s0, s1 = ev[-3]['step'], ev[-1]['step']
        tr = [r['loss'] for r in train if _num(r.get('loss')) and s0 <= r['step'] <= s1]
        falling = len(tr) >= 4 and _med(tr[-max(2, len(tr) // 3):]) < _med(tr[:max(2, len(tr) // 3)])
        if (rising or last3[-1] > 1.15 * lo) and falling:
            issues.append(_issue(
                'overfitting', 'warning', 'Validation loss rises while training loss falls',
                'The model is fitting the training episodes better but the held-out episodes '
                'worse (validation %.4f vs best %.4f).' % (last3[-1], lo),
                {'eval_losses': [round(x, 5) for x in last3], 'eval_best': round(lo, 5),
                 'best_step': next(e['step'] for e in ev if e['eval_loss'] == lo),
                 'window_steps': [s0, s1]},
                'Prefer the checkpoint near the best validation step, add weight decay or image '
                'augmentation, and record more varied demonstrations. With a handful of held-out '
                'episodes this is a noisy signal - confirm on the robot.',
                ['wd_up', 'lr_down', 'augment', 'early_stop']))

    # ---- excessive gradient clipping --------------------------------------------------
    grd = [r['grdn'] for r in train if _num(r.get('grdn'))]
    if len(grd) >= 10:
        over = sum(1 for g in grd if g > clip)
        frac = over / len(grd)
        if frac >= 0.30:
            issues.append(_issue(
                'excess_clipping', 'critical' if frac >= 0.8 else 'warning',
                'Gradients are being clipped on most steps',
                '%.0f%% of logged steps had a gradient norm above the clip value %g, so the '
                'optimiser mostly sees clipped updates.' % (frac * 100, clip),
                {'clip_norm': clip, 'fraction_clipped': round(frac, 3),
                 'median_grad_norm': round(_med(grd), 4), 'max_grad_norm': round(max(grd), 4)},
                'Either the learning rate is too high for this loss scale, or the clip value is '
                'too tight. Try a lower learning rate first; raise the clip norm only if the '
                'loss is still decreasing well.', ['lr_down', 'clip_up']))

    # ---- GPU memory ---------------------------------------------------------------------
    gpus = [r['gpu'] for r in resources if r.get('gpu') and _num(r['gpu'].get('memory_used_mb'))]
    oom = 'out of memory' in err_text or ('cuda error' in err_text and 'memory' in err_text)
    if oom:
        issues.append(_issue(
            'gpu_oom', 'critical', 'GPU ran out of memory',
            'The log contains a CUDA out-of-memory error.',
            {'gpu_peak_mb': max((g['memory_used_mb'] for g in gpus), default=None),
             'batch_size': (config.get('train') or {}).get('batch_size')},
            'Restart with a smaller batch size (half), and close other programs that use the GPU.',
            ['batch_down', 'amp']))
    elif gpus:
        peak = max(g['memory_used_mb'] for g in gpus)
        total = next((g.get('memory_total_mb') for g in reversed(gpus)
                      if g.get('memory_total_mb')), None)
        if total and peak / total >= 0.92:
            issues.append(_issue(
                'gpu_memory', 'warning', 'GPU memory is almost full',
                'Peak GPU memory use was %.0f MB of %.0f MB (%.0f%%). The figure covers the whole '
                'GPU, not just this run.' % (peak, total, 100 * peak / total),
                {'gpu_peak_mb': peak, 'gpu_total_mb': total,
                 'fraction': round(peak / total, 3)},
                'A memory spike (a longer batch, a checkpoint save) could stop the run. Consider '
                'a smaller batch size or mixed precision for the next run.',
                ['batch_down', 'amp']))

    # ---- slow training --------------------------------------------------------------------
    st = step_times(train)
    if len(st) >= 12:
        base = _med([x['s'] for x in st[:len(st) // 2]])
        now = _med([x['s'] for x in st[-6:]])
        data = [r.get('data_s') for r in train[-20:] if _num(r.get('data_s'))]
        upd = [r.get('updt_s') for r in train[-20:] if _num(r.get('updt_s'))]
        dm, um = _med(data), _med(upd)
        if base and now and now > 2 * base:
            issues.append(_issue(
                'slow_training', 'warning', 'Training slowed down',
                'Recent steps take %.2f s, %.1fx the earlier %.2f s.' % (now, now / base, base),
                {'step_time_now_s': round(now, 3), 'step_time_before_s': round(base, 3),
                 'ratio': round(now / base, 2)},
                'Check for another program using the GPU/CPU, thermal throttling, or a nearly '
                'full disk.', []))
        elif dm is not None and um is not None and dm + um > 0 and dm / (dm + um) > 0.5:
            issues.append(_issue(
                'data_bound', 'info', 'Training waits for data',
                'Data loading takes %.0f%% of each step (%.3f s of %.3f s), so the GPU is idle '
                'part of the time.' % (100 * dm / (dm + um), dm, dm + um),
                {'data_s': round(dm, 4), 'update_s': round(um, 4),
                 'num_workers': (config.get('train') or {}).get('num_workers')},
                'Raise the number of data-loader workers (up to the CPU core count).',
                ['workers_up']))

    issues.sort(key=lambda i: SEVERITY_ORDER.get(i['severity'], 9))
    return issues
