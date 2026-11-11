// Copyright 2026 ROBOTIS CO., LTD.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Dataset health report (computed by the training service inside the conda env).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { useTrainer } from '../../hooks/useTrainer';
import { Callout, ProgressBar, Spinner, Toggle } from '../../components/ui';

const LEVEL = { error: 'chip-err', warn: 'chip-warn', info: 'chip', ok: 'chip-ok' };

function Durations({ values }) {
  // strip plot: one dot per episode on a duration axis
  if (!values?.length) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const sx = (v) => (hi === lo ? 50 : 4 + ((v - lo) / (hi - lo)) * 92);
  return (
    <div>
      <div className="relative h-8 rounded-xl bg-paper" aria-label="Episode durations">
        {values.map((v, i) => (
          <span
            key={i}
            title={`episode ${i}: ${v}s`}
            className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-ink/70 ring-2 ring-white"
            style={{ left: `${sx(v)}%` }}
          />
        ))}
      </div>
      <div className="flex justify-between num text-[10.5px] text-ink-3 mt-1">
        <span>{lo}s</span>
        <span>{hi}s</span>
      </div>
    </div>
  );
}

export default function HealthReport({ path, env, compact, onResult }) {
  const { get, post } = useTrainer();
  const [st, setSt] = useState(null);
  const [video, setVideo] = useState(true);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);

  const poll = useCallback(async () => {
    try {
      const r = await get(`/health-report?path=${encodeURIComponent(path)}&video=${video ? 1 : 0}`);
      setSt(r);
      setErr('');
      return r;
    } catch (e) {
      setErr(e.message);
      return null;
    }
  }, [get, path, video]);

  const start = useCallback(
    async (refresh) => {
      try {
        setSt(await post('/health-report', { path, env, video, refresh }, { timeoutMs: 120000 }));
        setErr('');
      } catch (e) {
        setErr(e.message);
      }
    },
    [post, path, env, video],
  );

  // automatic: use a cached report or start the analysis
  useEffect(() => {
    if (!path) return undefined;
    let alive = true;
    (async () => {
      const r = await poll();
      if (alive && r && r.state === 'none') start(false);
    })();
    return () => {
      alive = false;
    };
  }, [path, video, poll, start]);

  useEffect(() => {
    if (st?.state !== 'running') return undefined;
    const t = setInterval(poll, 1200);
    return () => clearInterval(t);
  }, [st?.state, poll]);

  const res = st?.state === 'done' ? st.result : null;
  useEffect(() => {
    if (onResult) onResult(res);
  }, [res, onResult]);

  const flagged = useMemo(() => (res ? res.episodes.filter((e) => e.issues.length) : []), [res]);

  if (!path) return null;
  return (
    <div className="grid gap-3 grid-cols-[minmax(0,1fr)]" data-health>
      <div className="flex flex-wrap items-center gap-3">
        <div className="label">Dataset health</div>
        {res && (
          <div className="flex gap-1.5">
            <span className="chip-ok">{res.summary.ok} ok</span>
            {res.summary.warn > 0 && <span className="chip-warn">{res.summary.warn} with warnings</span>}
            {res.summary.error > 0 && <span className="chip-err">{res.summary.error} with errors</span>}
          </div>
        )}
        <div className="ml-auto flex items-center gap-3">
          <Toggle checked={video} onChange={setVideo} label={<span className="text-[12px]">check video frames</span>} />
          <button className="btn-ghost btn-sm" onClick={() => start(true)} disabled={st?.state === 'running'}>
            Re-analyse
          </button>
        </div>
      </div>
      {err && <Callout tone="err">{err}</Callout>}
      {st?.state === 'running' && (
        <div className="rounded-2xl bg-paper px-4 py-3 grid gap-2">
          <div className="flex items-center gap-2 text-[12.5px]">
            <Spinner /> Analysing {st.dataset} in {st.env} — {st.text}
          </div>
          <ProgressBar value={st.progress} total={100} tone="sky" />
        </div>
      )}
      {st?.state === 'failed' && (
        <Callout tone="err" title="Analysis failed">
          <span className="num break-all">{st.error}</span>
        </Callout>
      )}
      {res && (
        <>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="rounded-2xl bg-paper px-4 py-3">
              <div className="label mb-2">
                Episode length · median {res.summary.duration_median_s}s ({res.summary.episodes} episodes)
              </div>
              <Durations values={res.summary.durations_s} />
            </div>
            <div className="rounded-2xl bg-paper px-4 py-3 text-[12px]">
              <div className="label mb-1">Gripper ({res.gripper_joint})</div>
              {(() => {
                const c = {};
                res.episodes.forEach((e) => {
                  const k = e.gripper_changes >= 2 ? '2+' : String(e.gripper_changes ?? '—');
                  c[k] = (c[k] || 0) + 1;
                });
                return (
                  <div className="flex gap-4 mt-1">
                    <div>
                      <div className="text-[22px] font-light">{c['2+'] || 0}</div>
                      <div className="text-ink-3">close + release</div>
                    </div>
                    <div>
                      <div className={clsx('text-[22px] font-light', c['1'] && 'text-signal-warn')}>{c['1'] || 0}</div>
                      <div className="text-ink-3">one change</div>
                    </div>
                    <div>
                      <div className={clsx('text-[22px] font-light', c['0'] && 'text-signal-warn')}>{c['0'] || 0}</div>
                      <div className="text-ink-3">never moved</div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
          {res.recommendations.map((r) => (
            <Callout key={r} tone="info">
              {r}
            </Callout>
          ))}
          {!compact && (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl bg-paper px-4 py-3">
                <div className="label mb-1">Joint ranges (1st–99th percentile)</div>
                <table className="w-full text-[11.5px] num">
                  <tbody>
                    {res.joints.map((j) => (
                      <tr key={j.name}>
                        <td className="py-0.5 pr-2 font-sans text-ink-2">{j.name}</td>
                        <td className="text-right">{j.p1}</td>
                        <td className="text-right text-ink-4">…</td>
                        <td className="text-right">{j.p99}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rounded-2xl bg-paper px-4 py-3">
                <div className="label mb-1">Cameras</div>
                {res.video_checked ? (
                  res.cameras.map((c) => (
                    <div key={c.key} className="text-[12px] py-0.5">
                      <span className="font-medium">{c.key.split('.').pop()}</span>{' '}
                      <span className="num text-ink-3">
                        {c.sizes.map((s) => s.join('×')).join(', ')} · brightness {c.brightness_mean ?? '—'} ±{' '}
                        {c.brightness_spread ?? '—'}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="text-[12px] text-ink-3">Video frames not checked.</div>
                )}
              </div>
            </div>
          )}
          {flagged.length > 0 && (
            <div className="rounded-2xl border border-rule">
              <button
                className="w-full flex items-center justify-between px-4 py-2.5 text-[12.5px]"
                onClick={() => setOpen(!open)}
              >
                <span>
                  <b>{flagged.length}</b> episode{flagged.length > 1 ? 's' : ''} flagged
                </span>
                <span className="text-ink-3">{open ? 'Hide' : 'Show'}</span>
              </button>
              {open && (
                <div className="max-h-[320px] overflow-auto scroll-thin border-t border-rule">
                  {flagged.map((e) => (
                    <div key={e.episode} className="px-4 py-2 border-b border-rule last:border-0 text-[12px] flex gap-3">
                      <span className="num w-10 shrink-0">#{e.episode}</span>
                      <span className="num w-14 shrink-0 text-ink-3">{e.duration_s}s</span>
                      <div className="flex flex-wrap gap-1.5">
                        {e.issues.map((i, k) => (
                          <span key={k} className={LEVEL[i.level]}>
                            {i.text}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <p className="text-[11px] text-ink-3">
            Heuristics from the recorded joint data{res.video_checked ? ' and video frames' : ''}; flags are hints to check in
            Data, not verdicts. Analysed in {res.elapsed_s}s; the dataset was only read.
          </p>
        </>
      )}
    </div>
  );
}
