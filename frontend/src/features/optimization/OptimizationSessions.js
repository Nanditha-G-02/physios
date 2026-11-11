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

// Optimisation sessions: create (review every command first), follow, compare, and plan the
// next run. Nothing here touches the running job; trials are separate runs started from a
// checkpoint with a fresh optimiser.

import React, { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useTrainer } from '../../hooks/useTrainer';
import { fmt } from '../training/LineChart';
import OptimizationCompare from './OptimizationCompare';
import {
  Callout,
  Empty,
  Field,
  KeyValue,
  Modal,
  NumberInput,
  ProgressBar,
  Segmented,
  Sheet,
  Spinner,
  Toggle,
  formatDuration,
} from '../../components/ui';

const TRIAL_CHIP = {
  pending: 'chip',
  running: 'chip-sky',
  finished: 'chip-ok',
  diverged: 'chip-err',
  failed: 'chip-err',
  stopped: 'chip-warn',
  skipped: 'chip',
};
const SESSION_ACTIVE = ['running', 'ready'];

function Command({ argv }) {
  if (!argv?.length) return null;
  return (
    <pre className="rounded-xl bg-ink text-white/90 text-[11px] leading-relaxed p-3 overflow-x-auto num whitespace-pre-wrap break-all">
      {argv.map((a, i) => (i ? `  ${a}` : a)).join(' \\\n')}
    </pre>
  );
}

function patchRows(patch) {
  const rows = [];
  Object.entries(patch || {}).forEach(([sec, kv]) =>
    Object.entries(kv).forEach(([k, v]) => rows.push([`${sec === 'train' ? '' : `${sec.replace('_', ' ')}: `}${k.replace(/^policy\./, '')}`, String(v)])),
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Create a session: choose levers and limits, then review the exact commands.
export function NewSessionModal({ open, onClose, diag, runId, onCreated }) {
  const { post } = useTrainer();
  const trialSet = diag?.trial_set || [];
  const [picked, setPicked] = useState(trialSet);
  const [mode, setMode] = useState('manual');
  const [s, setS] = useState({
    max_trials: 3,
    gpu_min: 60,
    trial_min: 30,
    trial_steps: '',
    target_on: false,
    target_metric: 'loss',
    target_value: '',
    patience: 0,
    stop_on_divergence: true,
    auto_restart: false,
    min_gain_pct: 5,
  });
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ack, setAck] = useState(false);

  useEffect(() => {
    if (open) {
      setPicked(diag?.trial_set || []);
      setDraft(null);
      setErr('');
      setAck(false);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const request = () => ({
    run_id: runId,
    mode,
    candidate_ids: picked,
    settings: {
      max_trials: s.max_trials,
      gpu_budget_s: Math.round(s.gpu_min * 60),
      max_trial_s: Math.round(s.trial_min * 60),
      trial_steps: s.trial_steps === '' ? null : s.trial_steps,
      target: s.target_on && s.target_value !== '' ? { metric: s.target_metric, value: Number(s.target_value) } : null,
      patience: s.patience,
      stop_on_divergence: s.stop_on_divergence,
      auto_restart: s.auto_restart,
      min_gain_pct: s.min_gain_pct,
    },
  });

  const review = async () => {
    setBusy(true);
    setErr('');
    try {
      setDraft(await post('/optimization/propose', { request: request() }, { timeoutMs: 120000 }));
      setAck(false);
    } catch (e) {
      setErr(e.message);
      setDraft(null);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      const r = await post('/optimization/sessions', { request: request(), confirm_token: draft.token }, { timeoutMs: 120000 });
      toast.success(mode === 'auto' ? 'Optimisation started' : 'Session created');
      onCreated && onCreated(r.id);
      onClose();
    } catch (e) {
      setErr(e.message);
      if (/changed/i.test(e.message)) setDraft(null);
    } finally {
      setBusy(false);
    }
  };

  const cands = (diag?.candidates || []).filter((c) => c.kind === 'config');
  return (
    <Modal
      open={open}
      title="Compare alternatives from a checkpoint"
      onClose={onClose}
      width="max-w-3xl"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          {!draft ? (
            <button className="btn-primary" disabled={busy || !picked.length} onClick={review} data-review-session>
              {busy ? <Spinner /> : 'Review the commands'}
            </button>
          ) : (
            <button className="btn-primary" disabled={busy || !draft.ok || !ack} onClick={create} data-create-session>
              {mode === 'auto' ? 'Create and start automatically' : 'Create session'}
            </button>
          )}
        </>
      }
    >
      <div className="grid gap-4">
        <Callout tone="info">
          Each alternative runs as its own short training that loads the <b>weights</b> of a checkpoint from before the problem and starts a fresh
          optimiser. The original run, its checkpoints and its optimiser state are never changed. A control run with the original settings is
          always included, because only a same-checkpoint baseline makes the comparison fair.
        </Callout>
        <div>
          <div className="label mb-1">Alternatives to try</div>
          <div className="grid gap-1.5">
            {cands.map((c) => (
              <label
                key={c.id}
                className={clsx('flex items-start gap-2 rounded-xl px-3 py-2 text-[12.5px]', c.supported ? 'bg-paper cursor-pointer' : 'bg-paper-2/50 opacity-60')}
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={!c.supported}
                  checked={picked.includes(c.id)}
                  onChange={() => setPicked(picked.includes(c.id) ? picked.filter((x) => x !== c.id) : [...picked, c.id])}
                  data-pick={c.id}
                />
                <span>
                  <b>{c.title}</b>
                  <span className="block text-ink-3">{c.supported ? c.why : c.unsupported_reason}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <div className="label mb-1">Mode</div>
          <Segmented
            size="sm"
            value={mode}
            onChange={(v) => {
              setMode(v);
              setDraft(null);
            }}
            options={[
              { value: 'manual', label: 'Manual — I start each trial' },
              { value: 'auto', label: 'Automatic — run them within the budget' },
            ]}
          />
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Most alternatives" hint="Plus the control">
            <NumberInput value={s.max_trials} onChange={(v) => setS({ ...s, max_trials: v })} min={1} max={8} />
          </Field>
          <Field label="GPU time budget (min)" hint="All trials together">
            <NumberInput value={s.gpu_min} onChange={(v) => setS({ ...s, gpu_min: v })} min={1} />
          </Field>
          <Field label="Longest single trial (min)">
            <NumberInput value={s.trial_min} onChange={(v) => setS({ ...s, trial_min: v })} min={1} />
          </Field>
          <Field label="Steps per trial" hint="Empty = 10 % of the run">
            <NumberInput value={s.trial_steps} onChange={(v) => setS({ ...s, trial_steps: v })} min={10} />
          </Field>
          <Field label="Early stop after N flat log points" hint="0 = off">
            <NumberInput value={s.patience} onChange={(v) => setS({ ...s, patience: v })} min={0} />
          </Field>
          <Field label="Needed gain to recommend (%)" hint="Else: keep the original">
            <NumberInput value={s.min_gain_pct} onChange={(v) => setS({ ...s, min_gain_pct: v })} min={0} max={100} />
          </Field>
        </div>
        <div className="grid gap-2">
          <Toggle checked={s.target_on} onChange={(v) => setS({ ...s, target_on: v })} label="Stop when a performance target is reached" />
          {s.target_on && (
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Metric">
                <select className="input" value={s.target_metric} onChange={(e) => setS({ ...s, target_metric: e.target.value })}>
                  <option value="loss">training loss</option>
                  <option value="eval_loss">validation loss</option>
                </select>
              </Field>
              <Field label="At or below">
                <NumberInput value={s.target_value} onChange={(v) => setS({ ...s, target_value: v })} step={0.001} />
              </Field>
            </div>
          )}
          <Toggle checked={s.stop_on_divergence} onChange={(v) => setS({ ...s, stop_on_divergence: v })} label="Stop a trial as soon as its loss diverges" />
          <Toggle
            checked={s.auto_restart}
            onChange={(v) => setS({ ...s, auto_restart: v })}
            label="Allow resuming a trial once if it crashes (never after divergence or out-of-memory)"
          />
        </div>
        {err && <Callout tone="err">{err}</Callout>}
        {draft && (
          <div className="grid gap-3" data-draft>
            <div className="rounded-2xl bg-paper px-4 py-3 text-[12.5px] grid gap-1">
              <div>
                <span className="label mr-2">Start from</span>
                {draft.checkpoint ? `step ${draft.checkpoint.step} — ${draft.checkpoint.reason}` : 'the original starting weights'}
              </div>
              <div>
                <span className="label mr-2">Each trial</span>
                {draft.trial_steps} steps · estimated {draft.estimate_s ? formatDuration(draft.estimate_s) : 'unknown'} in total
              </div>
              {draft.notes.map((n) => (
                <div key={n} className="text-signal-warn">
                  {n}
                </div>
              ))}
            </div>
            {draft.trials.map((t) => (
              <div key={t.id} className="grid gap-1.5">
                <div className="text-[13px] font-semibold">
                  {t.title} {t.role === 'control' && <span className="chip ml-1">baseline</span>}
                </div>
                {t.role !== 'control' && <KeyValue rows={patchRows(t.patch)} />}
                {t.errors.map((e) => (
                  <Callout key={e} tone="err">
                    {e}
                  </Callout>
                ))}
                <Command argv={t.argv} />
              </div>
            ))}
            <label className="flex items-start gap-2 text-[12.5px]">
              <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} data-ack />
              <span>
                I have read these {draft.trials.length} commands.
                {mode === 'auto'
                  ? ' They may start without further confirmation, one at a time, within the limits above. Nothing moves the robot.'
                  : ' Nothing starts until I press Start on each trial.'}
              </span>
            </label>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function TrialRow({ t, session, onLaunch, busy, onOpenRun }) {
  const [show, setShow] = useState(false);
  const running = session.trials.some((x) => x.status === 'running');
  return (
    <div className="rounded-2xl bg-white shadow-card p-4 grid gap-2" data-trial={t.id} data-status={t.status}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={TRIAL_CHIP[t.status] || 'chip'}>{t.status}</span>
        <div className="text-[14px] font-semibold">{t.title}</div>
        {t.role === 'control' && <span className="chip">baseline</span>}
        {t.run_id && (
          <button className="btn-ghost btn-sm ml-auto" onClick={() => onOpenRun(t.run_id)}>
            Open run
          </button>
        )}
      </div>
      {t.role !== 'control' && <KeyValue rows={patchRows(t.patch)} />}
      {t.result && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-[12px] num">
          <div>
            <span className="label block">final loss</span>
            {t.result.nonfinite ? 'NaN' : fmt(t.result.final_loss)}
          </div>
          <div>
            <span className="label block">validation</span>
            {t.result.eval_best != null ? fmt(t.result.eval_best) : '—'}
          </div>
          <div>
            <span className="label block">steps</span>
            {t.result.steps}
          </div>
          <div>
            <span className="label block">time</span>
            {t.gpu_s != null ? formatDuration(t.gpu_s) : '—'}
          </div>
          <div>
            <span className="label block">GPU peak</span>
            {t.result.gpu_peak_mb ? `${(t.result.gpu_peak_mb / 1024).toFixed(1)} GB` : '—'}
          </div>
        </div>
      )}
      {(t.stop_reason || t.error) && <p className="text-[12px] text-ink-3">{t.stop_reason || t.error}</p>}
      {t.status === 'pending' && session.mode === 'manual' && SESSION_ACTIVE.includes(session.status) && (
        <div className="grid gap-2">
          <button className="text-[12px] text-sky-ink text-left" onClick={() => setShow(!show)}>
            {show ? 'Hide' : 'Show'} the command
          </button>
          {show && <Command argv={t.argv} />}
          <div>
            <button className="btn-primary btn-sm" disabled={busy || running} onClick={() => onLaunch(t)} data-launch={t.id}>
              {running ? 'Another trial is running' : 'Start this trial'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SessionView({ sid, runs, onOpenRun, onChanged }) {
  const { get, post } = useTrainer();
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [next, setNext] = useState(null);
  const [ack, setAck] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await get(`/optimization/sessions/${sid}`);
      setS(r);
      setErr('');
    } catch (e) {
      setErr(e.message);
    }
  }, [get, sid]);
  useEffect(() => {
    setS(null);
    setNext(null);
    load();
  }, [load]);
  const active = s && SESSION_ACTIVE.includes(s.status);
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [active, load]);

  const act = async (fn, okMsg) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast.success(okMsg);
      await load();
      onChanged && onChanged();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const planNext = async () => {
    setBusy(true);
    try {
      setNext(await get(`/optimization/sessions/${sid}/next-plan`, { timeoutMs: 120000 }));
      setAck(false);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const startNext = async () => {
    setBusy(true);
    try {
      const r = await post('/runs', { config: next.config, confirm_token: next.plan.token }, { timeoutMs: 120000 });
      toast.success('Training started');
      onOpenRun(r.id);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (err) return <Callout tone="err">{err}</Callout>;
  if (!s) return <Spinner />;
  const used = s.budget?.used_s || 0;
  const rec = s.recommendation;
  const runIds = [s.source_run_id, ...s.trials.filter((t) => t.run_id && t.result).map((t) => t.run_id)];
  const labels = { [s.source_run_id]: 'original run' };
  s.trials.forEach((t) => {
    if (t.run_id) labels[t.run_id] = t.role === 'control' ? 'control (same checkpoint)' : t.title;
  });
  const srcName = (runs || []).find((r) => r.id === s.source_run_id)?.job_name || s.source_run_id;

  return (
    <div className="grid gap-5" data-session={s.id} data-session-status={s.status}>
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-[20px] font-light">{s.name}</h2>
        <span className={s.status === 'running' ? 'chip-sky' : s.status === 'ready' ? 'chip' : s.status === 'stopped' ? 'chip-warn' : 'chip-ok'} data-sstatus>
          {s.status.replace('_', ' ')}
        </span>
        <span className="chip">{s.mode}</span>
        <div className="ml-auto flex gap-2">
          {s.mode === 'manual' && active && !s.trials.some((t) => t.status === 'running') && (
            <button className="btn btn-sm" disabled={busy} onClick={() => act(() => post(`/optimization/sessions/${sid}/conclude`, {}), 'Concluded')}>
              Conclude now
            </button>
          )}
          {active && (
            <button className="btn-danger btn-sm" disabled={busy} onClick={() => act(() => post(`/optimization/sessions/${sid}/stop`, {}), 'Stopped')} data-stop-session>
              Stop session
            </button>
          )}
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl bg-white shadow-card px-4 py-3 text-[12.5px]">
          <div className="label">Started from</div>
          {s.checkpoint ? `${srcName}, step ${s.checkpoint.step}` : `${srcName}: original starting weights`}
          <div className="text-ink-3 mt-1">{s.checkpoint?.reason}</div>
        </div>
        <div className="rounded-2xl bg-white shadow-card px-4 py-3 text-[12.5px]">
          <div className="label">GPU time budget</div>
          <ProgressBar value={used} total={s.budget?.limit_s || 1} tone={used >= (s.budget?.limit_s || 1) ? 'err' : 'ink'} />
          <div className="mt-1 num">
            {formatDuration(used)} of {formatDuration(s.budget?.limit_s || 0)}
          </div>
        </div>
        <div className="rounded-2xl bg-white shadow-card px-4 py-3 text-[12.5px]">
          <div className="label">Limits</div>
          <div className="num">
            ≤ {s.settings.max_trials} alternatives · {s.trial_steps} steps · ≤ {formatDuration(s.settings.max_trial_s)} each
          </div>
          <div className="text-ink-3 mt-1">
            {s.settings.stop_on_divergence ? 'stops diverging trials' : 'lets diverging trials finish'}
            {s.settings.auto_restart ? ' · may resume a crashed trial once' : ''}
            {s.settings.target ? ` · target ${s.settings.target.metric} ≤ ${s.settings.target.value}` : ''}
          </div>
        </div>
      </div>
      {s.notes?.map((n) => (
        <Callout key={n} tone="warn">
          {n}
        </Callout>
      ))}

      <Sheet title="Trials" code="A">
        <div className="grid gap-3 lg:grid-cols-2">
          {s.trials.map((t) => (
            <TrialRow
              key={t.id}
              t={t}
              session={s}
              busy={busy}
              onOpenRun={onOpenRun}
              onLaunch={(tr) => act(() => post(`/optimization/sessions/${sid}/trials/${tr.id}/launch`, { confirm_token: tr.token }), 'Trial started')}
            />
          ))}
        </div>
      </Sheet>

      {rec && (
        <Sheet title="Recommendation" code="B">
          <div className="grid gap-3" data-session-rec>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={rec.robot_based ? 'chip-ok' : 'chip-warn'}>{rec.robot_based ? 'based on robot trials' : 'based on training metrics only'}</span>
              <b className="text-[14px]">{rec.headline}</b>
            </div>
            {rec.patch && Object.keys(rec.patch).length > 0 && (
              <div className="rounded-xl bg-paper px-3 py-2">
                <div className="label mb-1">Recommended settings</div>
                <KeyValue rows={patchRows(rec.patch)} />
              </div>
            )}
            {rec.ranking?.length > 0 && (
              <table className="w-full text-left text-[12.5px]">
                <thead>
                  <tr className="label">
                    <th>Trial</th>
                    <th>{rec.metric}</th>
                    <th>Stability</th>
                    <th>Robot</th>
                  </tr>
                </thead>
                <tbody>
                  {rec.ranking.map((r) => (
                    <tr key={r.trial_id} className="border-t border-ink/10">
                      <td className="py-1">{r.title}</td>
                      <td className="num">{fmt(r.value, 4)}</td>
                      <td>{r.stability}</td>
                      <td>{r.robot_rate != null ? `${Math.round(r.robot_rate * 100)}%` : 'not evaluated'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-[11.5px] text-ink-3">{rec.noise_note}</p>
            {rec.winner && !next && (
              <div>
                <button className="btn-primary btn-sm" disabled={busy} onClick={planNext} data-plan-next>
                  Plan the next training with these settings
                </button>
              </div>
            )}
            {next && (
              <div className="grid gap-2" data-next-plan>
                <Callout tone="info">
                  Continues from the {rec.winner && next.start_step != null ? `weights at step ${next.start_step}` : 'checkpoint'} for {next.steps} more steps, with a fresh
                  optimiser, in a new output folder.
                </Callout>
                {next.plan.errors.map((e) => (
                  <Callout key={e} tone="err">
                    {e}
                  </Callout>
                ))}
                <Command argv={next.plan.stages[next.plan.stages.length - 1].argv} />
                <label className="flex items-start gap-2 text-[12.5px]">
                  <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} data-ack-next />
                  I have read this command.
                </label>
                <div>
                  <button className="btn-primary btn-sm" disabled={busy || !ack || !next.plan.ok} onClick={startNext} data-start-next>
                    Start training
                  </button>
                </div>
              </div>
            )}
          </div>
        </Sheet>
      )}

      <Sheet title="Events" code="C">
        <ul className="grid gap-1 text-[12px]">
          {[...(s.events || [])].reverse().map((e, i) => (
            <li key={i} className={clsx(e.level === 'error' && 'text-signal-err', e.level === 'warn' && 'text-signal-warn')}>
              <span className="num text-ink-3 mr-2">{new Date(e.t).toLocaleTimeString()}</span>
              {e.msg}
            </li>
          ))}
        </ul>
      </Sheet>

      {runIds.length >= 2 && (
        <div>
          <h3 className="text-[16px] font-medium mb-2">Comparison</h3>
          <OptimizationCompare runs={runs} runIds={runIds} originalId={s.source_run_id} labels={labels} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function OptimizationSessions({ runs, selected, setSelected, onOpenRun }) {
  const { get } = useTrainer();
  const [list, setList] = useState(null);
  const load = useCallback(() => get('/optimization/sessions').then(setList, () => setList({ sessions: [], watches: {} })), [get]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  const sessions = list?.sessions || [];
  useEffect(() => {
    if (!selected && sessions.length) setSelected(sessions[0].id);
  }, [sessions.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list) return <Spinner />;
  if (!sessions.length)
    return (
      <Empty title="No optimisation sessions yet">
        When a run shows a problem, open it under <b>Monitor &amp; recommend</b> and choose “Compare alternatives from a checkpoint”.
      </Empty>
    );
  return (
    <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]" data-sessions>
      <div className="grid gap-2 content-start">
        <div className="label">History</div>
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => setSelected(s.id)}
            data-session-item={s.id}
            className={clsx('rounded-2xl px-3 py-2 text-left', selected === s.id ? 'bg-white shadow-lift' : 'bg-white/60 hover:bg-white')}
          >
            <div className="text-[13px] font-semibold truncate">{s.name}</div>
            <div className="flex items-center gap-2 mt-1">
              <span className={s.status === 'running' ? 'chip-sky' : s.status === 'stopped' ? 'chip-warn' : s.status === 'ready' ? 'chip' : 'chip-ok'}>{s.status.replace('_', ' ')}</span>
              <span className="text-[11px] text-ink-3">{s.mode}</span>
            </div>
            {s.recommendation && <div className="text-[11.5px] text-ink-3 mt-1 line-clamp-2">{s.recommendation}</div>}
          </button>
        ))}
      </div>
      <div className="min-w-0">{selected && <SessionView key={selected} sid={selected} runs={runs} onOpenRun={onOpenRun} onChanged={load} />}</div>
    </div>
  );
}
