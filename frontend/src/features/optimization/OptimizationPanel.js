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

// Training Optimization: live metrics of one run, problems detected from the logged
// values, and recommendations limited to what the installed lerobot-train accepts.
// Training metrics are kept visibly apart from robot results.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { useTrainer } from '../../hooks/useTrainer';
import LineChart, { fmt } from '../training/LineChart';
import MultiLineChart from '../training/MultiLineChart';
import { StatusChip } from '../training/RunMonitor';
import { Callout, Empty, KeyValue, Sheet, Spinner, Stat, formatDuration } from '../../components/ui';
import WatchControl from './WatchControl';
import { NewSessionModal } from './OptimizationSessions';

const ACTIVE = ['starting', 'copying', 'converting', 'training', 'paused', 'stopping'];
const SEV = { critical: 'chip-err', warning: 'chip-warn', info: 'chip-sky' };

export function SeverityChip({ severity }) {
  return (
    <span className={SEV[severity] || 'chip'} data-severity={severity}>
      {severity}
    </span>
  );
}

function evidenceRows(ev) {
  return Object.entries(ev || {})
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => [k.replace(/_/g, ' '), Array.isArray(v) ? v.join(', ') : typeof v === 'number' ? fmt(v, 4) : String(v)]);
}

export function IssueCard({ issue }) {
  return (
    <div className="rounded-2xl bg-white shadow-card p-4 grid gap-2" data-issue={issue.id}>
      <div className="flex items-center gap-2 flex-wrap">
        <SeverityChip severity={issue.severity} />
        <div className="text-[14px] font-semibold">{issue.title}</div>
      </div>
      <p className="text-[12.5px] text-ink-2">{issue.detail}</p>
      <div className="rounded-xl bg-paper px-3 py-2">
        <div className="label mb-1">Supporting values</div>
        <KeyValue rows={evidenceRows(issue.evidence)} />
      </div>
      <div className="text-[12.5px]">
        <span className="label mr-2">Suggested action</span>
        {issue.action}
      </div>
    </div>
  );
}

function patchRows(patch, cfg) {
  const rows = [];
  Object.entries(patch || {}).forEach(([section, kv]) =>
    Object.entries(kv).forEach(([k, v]) => {
      const key = k.replace(/^policy\./, '');
      const was = (cfg?.[section] || {})[k] ?? (cfg?.advanced || {})[k];
      rows.push([`${section === 'train' ? '' : `${section.replace('_', ' ')}: `}${key}`, `${was ?? 'preset default'} → ${v}`]);
    }),
  );
  return rows;
}

export function CandidateCard({ c, cfg, inTrial, children }) {
  return (
    <div
      className={clsx('rounded-2xl p-4 grid gap-2', c.supported ? 'bg-white shadow-card' : 'bg-paper-2/60')}
      data-candidate={c.id}
      data-supported={c.supported}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <div className="text-[14px] font-semibold">{c.title}</div>
        {c.supported ? (
          inTrial && <span className="chip-ok">in the trial set</span>
        ) : (
          <span className="chip">not available here</span>
        )}
        {c.kind === 'selection' && <span className="chip-sky">no new run needed</span>}
      </div>
      <p className="text-[12.5px] text-ink-2">{c.why}</p>
      {c.supported && c.kind === 'config' && <KeyValue rows={patchRows(c.patch, cfg)} />}
      {!c.supported && <p className="text-[12px] text-ink-3">{c.unsupported_reason}</p>}
      <div className="text-[11.5px] text-ink-3">
        <span className="label mr-1">Risk</span>
        {c.risk}
      </div>
      {children}
    </div>
  );
}

export function CapabilityList({ caps }) {
  return (
    <div className="grid gap-1.5 md:grid-cols-2" data-capabilities>
      {(caps || []).map((c) => (
        <div key={c.id} className="rounded-xl bg-paper px-3 py-2 text-[12.5px]" data-cap={c.id} data-supported={c.supported}>
          <div className="flex items-center gap-2">
            <span className={c.supported ? 'chip-ok' : 'chip'}>{c.supported ? 'supported' : 'unavailable'}</span>
            <span className="font-medium">{c.label}</span>
          </div>
          <div className="text-[11.5px] text-ink-3 mt-1 num break-all">
            {c.supported ? (c.flags || []).map((f) => `--${f}`).join('  ') || 'detected' : c.reason}
          </div>
          {c.manual_only && <div className="text-[11.5px] text-ink-3 mt-1">{c.manual_only}</div>}
        </div>
      ))}
    </div>
  );
}

export default function OptimizationPanel({ runs, initialRunId, onOpenRun, onSession }) {
  const { get } = useTrainer();
  const [runId, setRunId] = useState(initialRunId || '');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [logY, setLogY] = useState(true);
  const [showCaps, setShowCaps] = useState(false);
  const [modal, setModal] = useState(false);

  const usable = useMemo(() => (runs || []).filter((r) => r.progress?.step || ACTIVE.includes(r.status)), [runs]);
  useEffect(() => {
    if (!runId && usable.length) {
      setRunId((usable.find((r) => ACTIVE.includes(r.status)) || usable[0]).id);
    }
  }, [usable, runId]);

  const load = useCallback(async () => {
    if (!runId) return null;
    try {
      const r = await get(`/runs/${runId}/diagnostics`);
      setD(r);
      setErr('');
      return r;
    } catch (e) {
      setErr(e.message);
      return null;
    }
  }, [get, runId]);

  useEffect(() => {
    setD(null);
    load();
  }, [load]);
  const active = d && ACTIVE.includes(d.run.status);
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [active, load]);

  const s = d?.summary;
  const worst = d?.issues?.[0]?.severity;

  return (
    <div className="grid gap-5" data-optimization>
      <div className="flex flex-wrap items-center gap-3">
        <div className="label">Run</div>
        <select
          className="input max-w-sm"
          value={runId}
          onChange={(e) => setRunId(e.target.value)}
          data-opt-run
          aria-label="Run to analyse"
        >
          {!usable.length && <option value="">No runs with metrics yet</option>}
          {usable.map((r) => (
            <option key={r.id} value={r.id}>
              {r.job_name} · {r.status}
            </option>
          ))}
        </select>
        {d && <StatusChip status={d.run.status} />}
        {d && (
          <span className={clsx(worst ? SEV[worst] : 'chip-ok')} data-health>
            {d.issues.length ? `${d.issues.length} problem${d.issues.length > 1 ? 's' : ''} detected` : 'no problems detected'}
          </span>
        )}
        {active && <span className="text-[11.5px] text-ink-3">live · refreshes every 5 s</span>}
        {d && (
          <button className="btn-ghost btn-sm ml-auto" onClick={() => onOpenRun && onOpenRun(runId)}>
            Open run
          </button>
        )}
      </div>

      {err && <Callout tone="err">{err}</Callout>}
      {!runId && !err && (
        <Empty title="Nothing to analyse yet">Start a training run, then come back: metrics are read from its log as they appear.</Empty>
      )}
      {runId && !d && !err && <Spinner />}

      {d && (
        <>
          <Callout tone="info" title="Training metrics are not robot performance">
            {d.caveats[0]} Use <b>Evaluate</b> to record real pick-and-place trials.
            {d.robot_evaluations?.length > 0 && (
              <>
                {' '}
                Robot results for this run:{' '}
                {d.robot_evaluations.map((g) => `step ${g.step}: ${Math.round(g.rate * 100)}% over ${g.n} trials`).join('; ')}.
              </>
            )}
          </Callout>

          <div className="grid gap-3 grid-cols-2 md:grid-cols-4 xl:grid-cols-8" data-stats>
            <Stat label="Train loss" value={fmt(s.loss_last)} sub={`min ${fmt(s.loss_min)}`} />
            <Stat
              label="Validation loss"
              value={d.validation.points ? fmt(s.eval_last) : '—'}
              sub={d.validation.points ? `best ${fmt(s.eval_min)}` : d.validation.enabled ? 'waiting' : 'off'}
            />
            <Stat label="Learning rate" value={fmt(s.lr_last, 2)} />
            <Stat
              label="Grad norm"
              value={fmt(s.grdn_last)}
              sub={`clip ${fmt(d.clip_norm)}${d.clip_norm_assumed ? ' (assumed)' : ''}`}
              tone={s.grdn_last > d.clip_norm ? 'warn' : undefined}
            />
            <Stat label="Step time" value={s.step_time_s ? `${fmt(s.step_time_s)} s` : '—'} sub={s.steps_per_s ? `${fmt(s.steps_per_s, 2)} steps/s` : null} />
            <Stat label="Epoch" value={s.epoch_duration_s ? formatDuration(s.epoch_duration_s) : '—'} sub={s.epochs_done != null ? `${fmt(s.epochs_done, 2)} done` : null} />
            <Stat
              label="GPU memory"
              value={s.gpu_peak_mb ? `${(s.gpu_peak_mb / 1024).toFixed(1)} GB` : '—'}
              sub={s.gpu_total_mb ? `of ${(s.gpu_total_mb / 1024).toFixed(1)} GB peak` : null}
            />
            <Stat
              label="Stability"
              value={s.stability.label}
              tone={s.stability.label === 'stable' ? 'ok' : s.stability.label === 'unstable' ? 'err' : s.stability.label === 'noisy' ? 'warn' : undefined}
              sub={s.stability.spikes != null ? `${s.stability.spikes} spikes` : null}
            />
          </div>

          {active && <WatchControl key={runId} runId={runId} />}

          <Sheet title="Detected problems" code="A">
            {d.issues.length ? (
              <div className="grid gap-3 lg:grid-cols-2">
                {d.issues.map((i) => (
                  <IssueCard key={i.id} issue={i} />
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-ink-2" data-no-issues>
                None of the checks fired on the {s.points} logged points: no NaN or explosion, no stagnation, no clipping pressure, no
                memory or speed problem
                {d.validation.points >= 3 ? ', and validation is not rising' : ''}. Short logs can hide problems — keep watching.
              </p>
            )}
          </Sheet>

          <Sheet title="Live metrics" code="B" actions={<button className="btn-ghost btn-sm" onClick={() => setLogY(!logY)}>{logY ? 'Log scale' : 'Linear scale'}</button>}>
            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <div className="label mb-1">Training and validation loss</div>
                <MultiLineChart
                  log={logY}
                  series={[
                    { id: 'train', label: 'training loss', color: '#2457E6', points: d.series.loss },
                    ...(d.series.eval_loss.length ? [{ id: 'val', label: 'validation loss (held-out episodes)', color: '#0B0C0E', points: d.series.eval_loss }] : []),
                  ]}
                />
                {!d.validation.enabled && (
                  <p className="text-[11.5px] text-ink-3 mt-1">
                    {d.validation.supported
                      ? 'Validation loss is off for this run. Turn it on in New training → Configure.'
                      : 'This lerobot-train cannot hold out validation episodes.'}
                  </p>
                )}
              </div>
              <div>
                <div className="label mb-1">Gradient norm (before clipping)</div>
                <MultiLineChart
                  log
                  series={[
                    { id: 'g', label: 'grad norm', color: '#2457E6', points: d.series.grad_norm },
                    { id: 'c', label: `clip ${fmt(d.clip_norm)}`, color: '#0B0C0E', dashed: true, points: d.series.grad_norm.map((p) => ({ x: p.x, y: d.clip_norm })) },
                  ]}
                />
              </div>
              <div>
                <div className="label mb-1">Learning rate</div>
                <LineChart points={d.series.lr} yLabel="learning rate" color="#2457E6" yMin={0} />
              </div>
              <div>
                <div className="label mb-1">Time per step (s)</div>
                <LineChart points={d.series.step_time} yLabel="seconds per step" color="#5E636C" yMin={0} />
              </div>
              <div>
                <div className="label mb-1">GPU memory in use (MB, whole GPU)</div>
                <LineChart
                  points={d.series.gpu_mb}
                  yLabel="MB"
                  color="#0B0C0E"
                  yMin={0}
                  yMax={s.gpu_total_mb || undefined}
                  empty="No GPU samples (no NVIDIA GPU, or the run was not sampled)."
                />
              </div>
            </div>
          </Sheet>

          <Sheet
            title="Recommendations"
            code="C"
            actions={
              <button className="btn-ghost btn-sm" onClick={() => setShowCaps(!showCaps)} data-toggle-caps>
                {showCaps ? 'Hide' : 'Show'} what this LeRobot supports
              </button>
            }
          >
            {showCaps && (
              <div className="mb-4">
                <Callout tone="info" className="mb-3">
                  Read from <span className="num">lerobot-train --help</span> of this run’s environment. A lever that is not listed
                  here is never suggested.
                </Callout>
                <CapabilityList caps={d.capabilities} />
              </div>
            )}
            {d.candidates.length ? (
              <div className="grid gap-3 lg:grid-cols-2">
                {d.candidates.map((c) => (
                  <CandidateCard key={c.id} c={c} cfg={d.run.config} inTrial={d.trial_set.includes(c.id)} />
                ))}
              </div>
            ) : (
              d.notes.slice(0, 1).map((n) => (
                <p key={n} className="text-[13px] text-ink-2">
                  {n}
                </p>
              ))
            )}
            {d.candidates.length > 0 && (
              <p className="text-[11.5px] text-ink-3 mt-3">
                Nothing here changes the running job. Each change is only ever applied to a <b>new</b> run (weights loaded from a
                checkpoint, a fresh optimiser), so the original run and its checkpoints stay as they are.
              </p>
            )}
            {d.trial_set.length > 0 && (
              <div className="mt-4 flex items-center gap-3 flex-wrap">
                <button className="btn-primary btn-sm" disabled={active} onClick={() => setModal(true)} data-open-session>
                  Compare alternatives from a checkpoint…
                </button>
                {active && <span className="text-[12px] text-ink-3">Available once the run has stopped or finished — stop it first (its checkpoints are kept).</span>}
              </div>
            )}
            <NewSessionModal
              open={modal}
              onClose={() => setModal(false)}
              diag={d}
              runId={runId}
              onCreated={(id) => onSession && onSession(id)}
            />
          </Sheet>
        </>
      )}
    </div>
  );
}
