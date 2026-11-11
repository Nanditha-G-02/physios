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

// Review of the episode that was just saved: preview the recorded videos,
// then Approve (accepted), Reject (rejected, optional reason) or Decide later
// (needs review). Nothing is deleted - a rejected episode stays in the dataset.
//
// docked=false: blocking dialog (plan mode - the next take waits for it)
// docked=true : panel in the corner (free recording keeps running)

import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { usePlanningService } from '../../hooks/usePlanningService';
import { videoUrl, FAILURE_LABELS } from '../data/EpisodeViewer';
import { Spinner, formatDuration } from '../../components/ui';

export default function EpisodeReviewDialog({ item, waiting = 0, onDecide, docked }) {
  const { call } = usePlanningService();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [cats, setCats] = useState([]);
  const [busy, setBusy] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const reasonRef = useRef(null);
  const key = item ? `${item.dataset_id}:${item.episode_index}` : '';

  useEffect(() => {
    if (!item) return undefined;
    let cancelled = false;
    setData(null);
    setLoadError('');
    setRejecting(false);
    setReason('');
    setCats([]);
    call('data.episode', { dataset_id: item.dataset_id, episode_index: item.episode_index, max_points: 50 })
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
    };
  }, [key, item, call]);

  const decide = async (status) => {
    setBusy(status);
    try {
      await onDecide(item, status, status === 'rejected' ? { comment: reason.trim(), categories: cats } : {});
    } finally {
      setBusy('');
    }
  };

  // keyboard: A approve, R reject, L later (only when not typing)
  useEffect(() => {
    if (!item || (docked && collapsed)) return undefined;
    const onKey = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || busy) return;
      if (e.key === 'a' || e.key === 'A') decide('accepted');
      else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        setRejecting(true);
        setTimeout(() => reasonRef.current && reasonRef.current.focus(), 30);
      } else if (e.key === 'l' || e.key === 'L') decide('needs_review');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  if (!item) return null;
  const keys = data ? Object.keys(data.videos || {}) : [];
  const plan = data?.plan;

  const body = (
    <div className="grid gap-3 grid-cols-[minmax(0,1fr)]">
      <div className={clsx('grid gap-2', keys.length > 1 && !docked ? 'grid-cols-2' : 'grid-cols-1')}>
        {!data && !loadError && (
          <div className="aspect-video grid place-items-center bg-paper-2 border border-rule">
            <Spinner />
          </div>
        )}
        {loadError && <div className="text-[12.5px] text-signal-err">{loadError}</div>}
        {keys.slice(0, docked ? 1 : 2).map((k) => (
          <figure key={k} className="relative border border-ink bg-black">
            <video
              src={videoUrl(item.dataset_id, data.videos[k].path)}
              className="w-full aspect-video"
              autoPlay
              muted
              loop
              playsInline
              controls={!docked}
              onLoadedMetadata={(e) => {
                e.currentTarget.currentTime = data.videos[k].from_s || 0;
              }}
            />
            <figcaption className="absolute left-1.5 top-1.5 chip-ink">{k.replace('observation.images.', '')}</figcaption>
          </figure>
        ))}
      </div>
      {data && (
        <div className="flex flex-wrap gap-1.5 text-[12px]">
          <span className="chip num">{data.frames} frames</span>
          <span className="chip num">{formatDuration(item.duration_s)}</span>
          <span className={data.check?.ok ? 'chip-ok' : 'chip-err'}>{data.check?.ok ? 'files OK' : 'file problems'}</span>
          {plan && <span className="chip-sky">{plan.episode_id}</span>}
          {(data.check?.warnings || []).map((w) => (
            <span key={w} className="chip-warn">
              {w}
            </span>
          ))}
        </div>
      )}
      {(item.tasks || [])[0] && <div className="text-[12.5px] text-ink-2">“{item.tasks[0]}”</div>}
      {rejecting && (
        <div className="grid gap-2 border border-signal-err/40 bg-signal-errbg p-2.5">
          <div className="flex flex-wrap gap-1">
            {Object.entries(FAILURE_LABELS).map(([k, l]) => {
              const on = cats.includes(k);
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  className={on ? 'chip-err cursor-pointer bg-white' : 'chip cursor-pointer'}
                  onClick={() => setCats(on ? cats.filter((c) => c !== k) : [...cats, k])}
                >
                  {l}
                </button>
              );
            })}
          </div>
          <textarea
            ref={reasonRef}
            className="input min-h-[56px]"
            placeholder="Reason (optional) — e.g. cube slipped during transport"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary bg-signal-ok border-signal-ok hover:bg-signal-ok/90" disabled={!!busy || !data} onClick={() => decide('accepted')}>
          {busy === 'accepted' ? <Spinner className="border-paper border-t-transparent" /> : '✓'} Approve
          <span className="font-mono text-[10px] opacity-70">A</span>
        </button>
        {rejecting ? (
          <button className="btn-danger bg-white" disabled={!!busy} onClick={() => decide('rejected')}>
            {busy === 'rejected' ? <Spinner /> : '✕'} Confirm reject
          </button>
        ) : (
          <button className="btn-danger bg-white" disabled={!!busy || !data} onClick={() => setRejecting(true)}>
            ✕ Reject <span className="font-mono text-[10px] opacity-70">R</span>
          </button>
        )}
        <button className="btn-ghost ml-auto" disabled={!!busy} onClick={() => decide('needs_review')} title="Keep it as pending review in Data">
          Decide later <span className="font-mono text-[10px] opacity-60">L</span>
        </button>
      </div>
      <p className="text-[11px] text-ink-3">
        Rejected episodes stay in the dataset, marked rejected, so you can recollect or remove them later in Data.
        {plan && !plan.superseded && ' Rejecting a plan take puts its plan episode back in the queue.'}
      </p>
    </div>
  );

  if (docked) {
    return (
      <aside
        className="fixed right-4 bottom-[190px] z-40 w-[360px] sheet shadow-xl animate-rise"
        role="dialog"
        aria-label="Review recorded episode"
      >
        <header className="sheet-head py-2">
          <div className="min-w-0">
            <div className="label">Review · episode {item.episode_index}</div>
            <div className="text-[12px] num truncate text-ink-3">{item.dataset_id}</div>
          </div>
          <div className="flex items-center gap-1.5">
            {waiting > 1 && <span className="chip-warn num">{waiting} waiting</span>}
            <button className="btn-ghost btn-sm" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand' : 'Collapse'}>
              {collapsed ? '▴' : '▾'}
            </button>
          </div>
        </header>
        {!collapsed && <div className="p-3">{body}</div>}
      </aside>
    );
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-ink/35 p-4">
      <div className="sheet w-full max-w-[860px] animate-rise" role="dialog" aria-label="Review recorded episode">
        <header className="sheet-head">
          <div className="min-w-0">
            <div className="label">Episode review · saved just now</div>
            <h2 className="sheet-title truncate">
              {plan ? `${plan.episode_id} · ` : ''}dataset episode {item.episode_index}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {waiting > 1 && <span className="chip-warn num">{waiting} waiting</span>}
            <span className="num text-[11.5px] text-ink-3 truncate max-w-[260px]">{item.dataset_id}</span>
          </div>
        </header>
        <div className="p-4 max-h-[78vh] overflow-auto scroll-thin">{body}</div>
      </div>
    </div>
  );
}
