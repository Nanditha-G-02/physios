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

// One recorded episode: synced camera videos (served read-only by nginx at
// /lerobot-data), optional processed playback, state/action timelines, the
// plan configuration it was recorded for, file checks and the review form.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import TimelineChart from './TimelineChart';
import ProcessedCameraView from '../record/ProcessedCameraView';
import WorkspaceCanvas from '../planning/WorkspaceCanvas';
import { Callout, KeyValue, Sheet, Spinner, TextInput, formatDuration } from '../../components/ui';

const FAILURE_LABELS = {
  missed_grasp: 'Missed grasp',
  dropped_object: 'Dropped object',
  wrong_target: 'Wrong target',
  collision: 'Collision',
  incomplete_task: 'Incomplete',
  operator_error: 'Operator error',
  camera_issue: 'Camera issue',
  robot_fault: 'Robot fault',
  timing: 'Timing',
  setup_mismatch: 'Setup ≠ plan',
  other: 'Other',
};

export function videoUrl(datasetId, rel) {
  return `/lerobot-data/${datasetId}/${rel}`;
}

export default function EpisodeViewer({ datasetId, episodeIndex, call, onReviewed, onDelete, onRecollect, planItems }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [processed, setProcessed] = useState(false);
  const [videoErrors, setVideoErrors] = useState({});
  const [masterEl, setMasterEl] = useState(null);
  const videos = useRef({});

  const [status, setStatus] = useState(null);
  const [comment, setComment] = useState('');
  const [cats, setCats] = useState([]);
  const [meta, setMeta] = useState([]);
  const [saving, setSaving] = useState(false);
  const [markers, setMarkersState] = useState(null);
  const [markersDirty, setMarkersDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    setTime(0);
    setPlaying(false);
    setVideoErrors({});
    call('data.episode', { dataset_id: datasetId, episode_index: episodeIndex })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        const r = d.review || {};
        setStatus(r.status || null);
        setComment(r.comment || '');
        setCats(r.failure_categories || []);
        setMeta(Object.entries(r.metadata || {}));
        setMarkersState(d.phases ? (d.phases.manual || d.phases.auto).map(({ phase, t }) => ({ phase, t })) : null);
        setMarkersDirty(false);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [datasetId, episodeIndex, call]);

  const keys = data ? Object.keys(data.videos || {}) : [];
  const phasesManual = !!data?.phases?.manual;
  const markerList = (markers || [])
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((m, i) => ({ ...m, n: i + 1, label: data?.phases?.labels?.[m.phase] || m.phase }));
  const setMarkers = (m) => {
    setMarkersState(m);
    setMarkersDirty(true);
  };
  const withPhase = (ph, t) => {
    const rest = (markers || []).filter((m) => m.phase !== ph);
    return t == null ? rest : [...rest, { phase: ph, t: Math.round(t * 1000) / 1000 }];
  };
  const saveMarkers = async (m) => {
    try {
      await call('data.set_markers', { dataset_id: datasetId, episode_index: episodeIndex, markers: m });
      const d = await call('data.episode', { dataset_id: datasetId, episode_index: episodeIndex });
      setData(d);
      setMarkersState((d.phases.manual || d.phases.auto).map(({ phase, t }) => ({ phase, t })));
      setMarkersDirty(false);
      toast.success(m ? 'Phases saved with the episode review' : 'Back to automatic phases');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const each = (fn) => Object.values(videos.current).forEach((v) => v && fn(v));
  const offset = (k) => data?.videos?.[k]?.from_s || 0;

  const seek = useCallback(
    (t) => {
      Object.entries(videos.current).forEach(([k, v]) => {
        if (v) v.currentTime = t + (data?.videos?.[k]?.from_s || 0);
      });
      setTime(t);
    },
    [data],
  );

  const toggle = () => {
    if (playing) {
      each((v) => v.pause());
      setPlaying(false);
    } else {
      each((v) => v.play().catch(() => {}));
      setPlaying(true);
    }
  };

  const save = async (patch = {}) => {
    setSaving(true);
    try {
      const rec = await call('data.review', {
        dataset_id: datasetId,
        episode_index: episodeIndex,
        status: patch.status !== undefined ? patch.status : status,
        comment,
        failure_categories: cats,
        metadata: Object.fromEntries(meta.filter(([k]) => k.trim())),
      });
      setStatus(rec.status || null);
      onReviewed && onReviewed(episodeIndex, rec);
      toast.success(`Episode ${episodeIndex} ${rec.status ? `marked ${rec.status.replace('_', ' ')}` : 'saved'}`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <Callout tone="err" title={`Episode ${episodeIndex}`}>
        {error}
      </Callout>
    );
  }
  if (!data) {
    return (
      <div className="grid place-items-center h-40">
        <Spinner />
      </div>
    );
  }
  const duration = data.timestamp.length ? data.timestamp[data.timestamp.length - 1] - data.timestamp[0] : 0;
  const plan = data.plan;
  const cfg = plan?.config;
  const itemsForView = planItems && planItems.length ? planItems : plan?.items || [];

  return (
    <div className="grid gap-4 grid-cols-[minmax(0,1fr)]">
      <Sheet
        title={`Episode ${episodeIndex}`}
        code="F2"
        actions={
          <>
            <span className="num text-[12px] text-ink-3">
              {data.frames} frames · {formatDuration(duration)}
            </span>
            <button
              className={processed ? 'btn-primary btn-sm' : 'btn btn-sm'}
              onClick={() => setProcessed(!processed)}
              disabled={!keys.length}
            >
              {processed ? 'Original' : 'Processed playback'}
            </button>
          </>
        }
      >
        {!keys.length && <Callout tone="warn">This dataset has no video features.</Callout>}
        {/* compact feeds: side by side, 16:9 frame (video letterboxed), at most 26vh tall */}
        <div className="flex gap-2">
          {keys.map((k, i) => (
            <figure key={k} className="relative min-w-0 flex-1 max-w-[clamp(267px,46vh,444px)] overflow-hidden rounded-lg border border-ink bg-black">
              <video
                ref={(el) => {
                  videos.current[k] = el;
                  if (i === 0 && el && el !== masterEl) setMasterEl(el);
                }}
                src={videoUrl(datasetId, data.videos[k].path)}
                crossOrigin="anonymous"
                muted
                playsInline
                preload="auto"
                className={clsx(
                  'block w-full aspect-video object-contain bg-black',
                  processed && i === 0 && 'hidden'
                )}
                onLoadedMetadata={(e) => {
                  e.currentTarget.currentTime = offset(k);
                }}
                onTimeUpdate={
                  i === 0
                    ? (e) => {
                        const t = e.currentTarget.currentTime - offset(k);
                        setTime(t);
                        const to = data.videos[k].to_s;
                        if (to && e.currentTarget.currentTime >= to) {
                          each((v) => v.pause());
                          setPlaying(false);
                        }
                      }
                    : undefined
                }
                onEnded={() => setPlaying(false)}
                onError={() => setVideoErrors((s) => ({ ...s, [k]: true }))}
              />
              {processed && i === 0 && masterEl && (
                <div className="w-full aspect-video">
                  <ProcessedCameraView
                    sourceEl={masterEl}
                    items={itemsForView}
                    settingsKey={`pam.processing.playback.${k}`}
                    compact
                    active
                  />
                </div>
              )}
              <figcaption className="absolute left-1.5 top-1.5 chip-ink">{k.replace('observation.images.', '')}</figcaption>
              {videoErrors[k] && (
                <div className="absolute inset-0 grid place-items-center p-4 text-center bg-white/90 text-[12px]">
                  Video not reachable at /lerobot-data. The UI container needs the read-only dataset mount (see docker-compose).
                </div>
              )}
            </figure>
          ))}
        </div>
        <div className="flex items-center gap-3 mt-3">
          <button className="btn-primary btn-sm w-20" onClick={toggle} disabled={!keys.length}>
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <input
            type="range"
            className="flex-1 accent-ink"
            min={0}
            max={duration || 0}
            step={0.01}
            value={Math.min(time, duration)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Episode time"
          />
          <span className="num text-[12px] w-24 text-right">
            {time.toFixed(2)} / {duration.toFixed(2)} s
          </span>
        </div>
        <div className="mt-3">
          <TimelineChart data={data} time={(data.timestamp[0] || 0) + time} onSeek={seek} markers={markerList} />
        </div>
      </Sheet>

      {data.phases && (
        <Sheet
          title="Grasp phases"
          code="F2b"
          actions={<span className={phasesManual ? 'chip-sky' : 'chip'}>{phasesManual ? 'adjusted by hand' : 'automatic'}</span>}
        >
          <div className="grid gap-3" data-phases>
            <div className="flex flex-wrap gap-1.5">
              {data.phases.order.map((ph) => {
                const m = markerList.find((x) => x.phase === ph);
                return (
                  <div
                    key={ph}
                    className={clsx(
                      'flex items-center rounded-pill text-[12px] overflow-hidden',
                      m ? 'bg-sky-50' : 'bg-paper text-ink-4',
                    )}
                  >
                    <button
                      className="px-2.5 py-1 flex items-center gap-1.5"
                      disabled={!m}
                      onClick={() => m && seek(m.t)}
                      title="Jump here"
                    >
                      {m && (
                        <span className="grid place-items-center h-4 w-4 rounded-full bg-sky-ink text-white num text-[9px]">
                          {m.n}
                        </span>
                      )}
                      {data.phases.labels[ph]}
                      <span className="num text-ink-3">{m ? `${m.t.toFixed(2)}s` : '—'}</span>
                    </button>
                    <button
                      className="px-2 py-1 border-l border-white hover:bg-sky-100"
                      title="Set to the current playback time"
                      data-set-phase={ph}
                      onClick={() => setMarkers(withPhase(ph, time))}
                    >
                      ⌖
                    </button>
                    {m && (
                      <button
                        className="px-2 py-1 border-l border-white hover:bg-sky-100"
                        title="Remove"
                        onClick={() => setMarkers(withPhase(ph, null))}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {!phasesManual &&
              data.phases.notes.map((n) => (
                <Callout key={n} tone="warn">
                  {n}
                </Callout>
              ))}
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="btn-primary btn-sm"
                disabled={!markersDirty}
                onClick={() => saveMarkers(markers)}
                data-save-phases
              >
                Save phases
              </button>
              {phasesManual && (
                <button className="btn-ghost btn-sm" onClick={() => saveMarkers(null)}>
                  Back to automatic
                </button>
              )}
              <span className="text-[11.5px] text-ink-3">
                Found from the {data.phases.gripper_joint || 'gripper'} joint and arm motion. Play to a moment and press ⌖ to move
                a marker there.
              </span>
            </div>
          </div>
        </Sheet>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Sheet title="Review" code="F3">
          <div className="grid gap-3 grid-cols-[minmax(0,1fr)]">
            <div className="flex flex-wrap gap-2">
              {[
                ['accepted', 'Accept', 'btn'],
                ['needs_review', 'Pending review', 'btn'],
                ['rejected', 'Reject', 'btn'],
              ].map(([s, l]) => (
                <button
                  key={s}
                  className={clsx(
                    'btn btn-sm',
                    status === s && s === 'accepted' && 'bg-signal-ok text-white border-signal-ok',
                    status === s && s === 'rejected' && 'bg-signal-err text-white border-signal-err',
                    status === s && s === 'needs_review' && 'bg-signal-warn text-white border-signal-warn',
                  )}
                  disabled={saving}
                  onClick={() => save({ status: s })}
                >
                  {l}
                </button>
              ))}
            </div>
            {data.review?.updated_at && (
              <p className="text-[11.5px] text-ink-3">
                Last decision {data.review.source === 'record' ? 'in Record' : 'in Data'} ·{' '}
                {new Date(data.review.updated_at).toLocaleString()}
              </p>
            )}
            <div>
              <div className="label mb-1">Failure categories</div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(FAILURE_LABELS).map(([k, l]) => {
                  const on = cats.includes(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={on}
                      className={on ? 'chip-err cursor-pointer' : 'chip cursor-pointer'}
                      onClick={() => setCats(on ? cats.filter((c) => c !== k) : [...cats, k])}
                    >
                      {l}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="label mb-1">Comment</div>
              <textarea className="input min-h-[64px]" value={comment} onChange={(e) => setComment(e.target.value)} />
            </div>
            <div>
              <div className="label mb-1">Metadata</div>
              {meta.map(([k, v], i) => (
                <div key={i} className="grid grid-cols-[1fr_1.5fr_28px] gap-2 mb-1">
                  <TextInput
                    value={k}
                    placeholder="key"
                    onChange={(nk) => setMeta(meta.map((m, j) => (j === i ? [nk, m[1]] : m)))}
                  />
                  <TextInput
                    value={v}
                    placeholder="value"
                    onChange={(nv) => setMeta(meta.map((m, j) => (j === i ? [m[0], nv] : m)))}
                  />
                  <button className="btn-ghost btn-sm px-1.5" onClick={() => setMeta(meta.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </div>
              ))}
              <button className="btn btn-sm" onClick={() => setMeta([...meta, ['', '']])}>
                + Field
              </button>
            </div>
            <div className="flex flex-wrap gap-2 justify-between pt-1">
              <div className="flex gap-2">
                <button className="btn-danger btn-sm" onClick={() => onDelete(episodeIndex)}>
                  Delete episode…
                </button>
                {plan && !plan.superseded && (
                  <button className="btn btn-sm" onClick={() => onRecollect(plan)}>
                    Recollect in Record
                  </button>
                )}
              </div>
              <button className="btn-primary btn-sm" onClick={() => save()} disabled={saving}>
                Save review
              </button>
            </div>
          </div>
        </Sheet>

        <Sheet title="Episode details" code="F4">
          <KeyValue
            rows={[
              ['Index', <span className="num">{episodeIndex}</span>],
              ['Duration', formatDuration(duration)],
              ['Frames', <span className="num">{data.frames}</span>],
              ['Plan', plan ? `${plan.plan_name} · ${plan.episode_id} · v${plan.plan_version}` : 'Not recorded from a plan'],
              plan && plan.superseded && ['Note', 'Superseded by a later retake of the same plan episode.'],
              cfg && ['Instruction', cfg.instruction],
              cfg && ['Scenario', `${cfg.scenario?.name} (${cfg.scenario?.kind})`],
              ['File check', data.check?.ok ? 'OK' : (data.check?.problems || []).join('; ') || '—'],
              (data.check?.warnings || []).length > 0 && ['Warnings', data.check.warnings.join('; ')],
            ]}
          />
          {cfg && (
            <div className="mt-3">
              <div className="label mb-1">Planned setup</div>
              <table className="w-full text-[12px]">
                <tbody>
                  {cfg.placements.map((p) => (
                    <tr key={p.item_id} className="border-t border-rule">
                      <td className="py-1">{itemsForView.find((i) => i.id === p.item_id)?.name || p.item_id}</td>
                      <td className="py-1">
                        <span className="chip">{p.region || '–'}</span>
                      </td>
                      <td className="py-1 num text-right">
                        x {Math.round(p.x_mm)} · y {Math.round(p.y_mm)} · {p.yaw_deg}°
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Sheet>
      </div>
    </div>
  );
}

export { FAILURE_LABELS, WorkspaceCanvas };
