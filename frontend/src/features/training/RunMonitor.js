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

// Live view of one training run: controls, metrics from the real log,
// GPU/CPU/RAM samples, the terminal output and the checkpoints it produced.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useTrainer } from '../../hooks/useTrainer';
import LineChart, { fmt } from './LineChart';
import { Callout, Modal, ProgressBar, Sheet, Spinner, TextInput, formatBytes, formatDuration } from '../../components/ui';
import { setPolicyPath } from '../tasks/taskSlice';
import { setRolloutTarget } from '../planning/planningSlice';
import { moveToPage } from '../ui/uiSlice';
import PageType from '../../constants/pageType';

const STATUS = {
  starting: ['chip-sky', 'Starting'],
  copying: ['chip-sky', 'Copying dataset'],
  converting: ['chip-sky', 'Converting copy'],
  training: ['chip-sky', 'Training'],
  paused: ['chip-warn', 'Paused'],
  stopping: ['chip-warn', 'Stopping'],
  succeeded: ['chip-ok', 'Finished'],
  failed: ['chip-err', 'Failed'],
  stopped: ['chip', 'Stopped'],
  interrupted: ['chip-err', 'Interrupted'],
};
const ACTIVE = ['starting', 'copying', 'converting', 'training', 'paused', 'stopping'];

export function StatusChip({ status }) {
  const [cls, text] = STATUS[status] || ['chip', status];
  return (
    <span className={cls}>
      {ACTIVE.includes(status) && status !== 'paused' && (
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulsedot" />
      )}
      {text}
    </span>
  );
}

function cleanLog(text) {
  // keep only the final state of carriage-return progress bars
  return text
    .split('\n')
    .map((l) => {
      const parts = l.split('\r');
      return parts[parts.length - 1] || parts[parts.length - 2] || '';
    })
    .join('\n');
}

function Tile({ label, value, sub, tone }) {
  return (
    <div className="rounded-2xl bg-white shadow-card px-4 py-3 min-w-0">
      <div className="label truncate">{label}</div>
      <div className={clsx('text-[24px] font-light tracking-tight leading-tight mt-0.5 tabular-nums truncate', tone)}>
        {value}
      </div>
      {sub && <div className="text-[11.5px] text-ink-3 truncate">{sub}</div>}
    </div>
  );
}

export default function RunMonitor({ runId, onNewFrom }) {
  const dispatch = useDispatch();
  const { get, post } = useTrainer();
  const [run, setRun] = useState(null);
  const [metrics, setMetrics] = useState({ train: [], eval: [] });
  const [res, setRes] = useState([]);
  const [ck, setCk] = useState(null);
  const [log, setLog] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [retry, setRetry] = useState(null);
  const [follow, setFollow] = useState(true);
  const [logY, setLogY] = useState(true);
  const [meta, setMeta] = useState({ name: '', notes: '' });
  const offset = useRef(-1);
  const logRef = useRef(null);
  const active = run && ACTIVE.includes(run.status);

  const refresh = useCallback(async () => {
    try {
      const r = await get(`/runs/${runId}`);
      setRun(r);
      setError('');
      return r;
    } catch (e) {
      setError(e.message);
      return null;
    }
  }, [get, runId]);

  const loadSide = useCallback(async () => {
    try {
      const [m, rr, c] = await Promise.all([
        get(`/runs/${runId}/metrics`),
        get(`/runs/${runId}/resources`),
        get(`/runs/${runId}/checkpoints`),
      ]);
      setMetrics(m);
      setRes(rr.rows || []);
      setCk(c);
    } catch (e) {
      /* shown via refresh */
    }
  }, [get, runId]);

  const loadLog = useCallback(async () => {
    try {
      const first = offset.current < 0;
      const r = await get(`/runs/${runId}/log?offset=${first ? -1 : offset.current}&limit=${first ? 120000 : 65536}`);
      offset.current = r.offset;
      if (r.text) setLog((prev) => (first ? r.text : prev + r.text).slice(-400000));
    } catch (e) {
      /* ignore */
    }
  }, [get, runId]);

  useEffect(() => {
    offset.current = -1;
    setLog('');
    setRun(null);
    setCk(null);
    refresh();
    loadSide();
    loadLog();
  }, [runId, refresh, loadSide, loadLog]);

  useEffect(() => {
    const fast = setInterval(
      () => {
        refresh();
        loadLog();
      },
      active ? 1500 : 6000,
    );
    const slow = setInterval(loadSide, active ? 4000 : 15000);
    return () => {
      clearInterval(fast);
      clearInterval(slow);
    };
  }, [active, refresh, loadLog, loadSide]);

  useEffect(() => {
    if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log, follow]);

  const act = async (what, body) => {
    setBusy(what);
    try {
      const r = await post(`/runs/${runId}/${what}`, body);
      if (r && r.id === runId) setRun(r);
      return r;
    } catch (e) {
      toast.error(e.message);
      return null;
    } finally {
      setBusy('');
    }
  };

  const openRetry = async (mode) => {
    setBusy('retry');
    try {
      const r = await post(`/runs/${runId}/retry`, { mode });
      setRetry({ mode, plan: r.preview, steps: '' });
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };
  const confirmRetry = async () => {
    setBusy('retry');
    try {
      let preview = retry.plan;
      if (retry.mode === 'resume' && retry.steps) {
        preview = (
          await post(`/runs/${runId}/retry`, {
            mode: 'resume',
            extra_steps: Number(retry.steps),
          })
        ).preview;
      }
      const r = await post(`/runs/${runId}/retry`, {
        mode: retry.mode,
        confirm_token: preview.token,
        extra_steps: retry.mode === 'resume' && retry.steps ? Number(retry.steps) : undefined,
      });
      toast.success('Started run ' + r.id);
      setRetry(null);
      onNewFrom(r.id);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };

  const lossPts = useMemo(() => metrics.train.filter((r) => r.loss != null).map((r) => ({ x: r.step, y: r.loss })), [metrics]);
  const lrPts = useMemo(() => metrics.train.filter((r) => r.lr != null).map((r) => ({ x: r.step, y: r.lr })), [metrics]);
  const evalPts = useMemo(() => metrics.eval.map((r) => ({ x: r.step, y: r.eval_loss })), [metrics]);
  const t0 = res.length ? res[0].t : 0;
  const gpuUtil = useMemo(() => res.filter((r) => r.gpu).map((r) => ({ x: r.t - t0, y: r.gpu.utilization_pct })), [res, t0]);
  const gpuMem = useMemo(() => res.filter((r) => r.gpu).map((r) => ({ x: r.t - t0, y: r.gpu.memory_used_mb / 1024 })), [res, t0]);
  const cpuPts = useMemo(() => res.filter((r) => r.cpu_pct != null).map((r) => ({ x: r.t - t0, y: r.cpu_pct })), [res, t0]);

  if (!run) {
    return <div className="grid place-items-center h-60">{error ? <Callout tone="err">{error}</Callout> : <Spinner />}</div>;
  }

  const prog = run.progress || {};
  const step = prog.step || 0;
  const total = prog.total || (run.config?.train?.steps ?? null);
  const pct = total ? Math.min(100, (step / total) * 100) : 0;
  const started = run.started_at ? new Date(run.started_at).getTime() : null;
  const ended = run.finished_at ? new Date(run.finished_at).getTime() : Date.now();
  const elapsed = started ? (ended - started) / 1000 : null;
  const last = prog.last || {};
  const now = run.resources_now;
  const stages = run.plan.stages;
  const stageIdx = run.stage_index ?? 0;
  const ckpts = ck?.checkpoints || [];
  const compat = ck?.compat;
  const lastCk = ckpts.find((c) => c.is_last) || ckpts[ckpts.length - 1];
  const cleaned = cleanLog(log);

  return (
    <div className="grid gap-4 grid-cols-[minmax(0,1fr)]">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="label">Run {run.id}</div>
          <div className="flex items-center gap-2 mt-0.5">
            <h2 className="text-[22px] font-semibold tracking-tight truncate">{run.job_name}</h2>
            <StatusChip status={run.status} />
          </div>
          <div className="text-[12px] text-ink-3 mt-0.5 truncate">
            {run.plan.policy} · {run.plan.dataset?.id} · env {run.env?.name} (LeRobot {run.env?.lerobot})
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {run.status === 'training' && (
            <button
              className="btn"
              onClick={() => act('pause')}
              disabled={!!busy}
              title="Suspends the process (SIGSTOP); GPU memory stays allocated"
            >
              ❚❚ Pause
            </button>
          )}
          {run.status === 'paused' && (
            <button className="btn-primary" onClick={() => act('resume')} disabled={!!busy}>
              ▶ Resume
            </button>
          )}
          {active && run.status !== 'stopping' && (
            <button className="btn-danger" onClick={() => act('stop')} disabled={!!busy}>
              ■ Stop
            </button>
          )}
          {!active && (
            <>
              {lastCk && (
                <button
                  className="btn"
                  onClick={() => openRetry('resume')}
                  disabled={!!busy}
                  title="Continue from the last checkpoint"
                >
                  ↻ Resume from step {lastCk.step}
                </button>
              )}
              <button className="btn" onClick={() => openRetry('restart')} disabled={!!busy}>
                Retry from scratch
              </button>
            </>
          )}
        </div>
      </div>

      {run.error && (
        <Callout tone="err" title={run.status === 'interrupted' ? 'Interrupted' : 'Training failed'}>
          <span className="num break-all">{run.error}</span>
        </Callout>
      )}

      {/* stages */}
      <div className="flex flex-wrap gap-2">
        {stages.map((s, i) => {
          const done = i < stageIdx || (i === stageIdx && run.status === 'succeeded');
          const cur = i === stageIdx && active;
          const bad = i === stageIdx && ['failed', 'interrupted'].includes(run.status);
          return (
            <div
              key={i}
              className={clsx(
                'flex items-center gap-2 rounded-pill px-3 py-1.5 text-[12px]',
                done
                  ? 'bg-signal-okbg text-signal-ok'
                  : bad
                    ? 'bg-signal-errbg text-signal-err'
                    : cur
                      ? 'bg-ink text-white'
                      : 'bg-white text-ink-3 shadow-card',
              )}
            >
              <span className="num">{done ? '✓' : bad ? '✕' : i + 1}</span>
              {s.desc}
              {cur && run.status !== 'paused' && <Spinner className="h-3 w-3" />}
            </div>
          );
        })}
      </div>

      {/* progress + tiles */}
      <div className="sheet px-5 py-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="label">Training progress</div>
            <div className="text-[36px] font-light tracking-tight leading-none mt-1 tabular-nums">
              {total ? `${pct.toFixed(pct < 10 ? 1 : 0)}%` : '—'}
            </div>
          </div>
          <div className="text-right text-[13px] text-ink-3">
            <div className="num text-ink text-[15px]">
              {step.toLocaleString()} <span className="text-ink-4">/ {total ? total.toLocaleString() : '—'} steps</span>
            </div>
            <div>
              elapsed {formatDuration(elapsed)}
              {active && step > 0 && total && elapsed
                ? ` · ~${formatDuration(((total - step) * elapsed) / Math.max(1, step - (run.parser?.step_offset || 0)))} left (from current speed)`
                : ''}
            </div>
          </div>
        </div>
        <ProgressBar className="mt-3" value={pct} total={100} tone="sky" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        <Tile
          label="Loss"
          value={fmt(last.loss, 4)}
          sub={last.step ? `at step ${last.step.toLocaleString()}` : 'no log line yet'}
        />
        <Tile label="LR" value={fmt(last.lr, 2)} />
        <Tile label="Grad norm" value={fmt(last.grdn, 3)} />
        <Tile
          label="Step time"
          value={last.updt_s != null ? `${fmt(last.updt_s, 2)} s` : '—'}
          sub={last.data_s != null ? `data ${fmt(last.data_s, 2)} s` : ''}
        />
        <Tile
          label="GPU"
          value={now?.gpu ? `${now.gpu.utilization_pct}%` : '—'}
          sub={
            now?.gpu
              ? `${(now.gpu.memory_used_mb / 1024).toFixed(1)} / ${(now.gpu.memory_total_mb / 1024).toFixed(1)} GB`
              : active
                ? 'no NVIDIA GPU reported'
                : 'not running'
          }
        />
        <Tile label="CPU" value={now?.cpu_pct != null ? `${now.cpu_pct}%` : '—'} />
        <Tile
          label="RAM"
          value={now?.ram_used ? formatBytes(now.ram_used) : '—'}
          sub={now?.ram_total ? `of ${formatBytes(now.ram_total)}` : ''}
        />
      </div>

      {/* charts */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Sheet
          title="Training loss"
          actions={
            <label className="flex items-center gap-1.5 text-[12px] text-ink-3">
              <input type="checkbox" checked={logY} onChange={(e) => setLogY(e.target.checked)} /> log scale
            </label>
          }
        >
          <LineChart points={lossPts} yLabel="loss" log={logY} smooth />
          <p className="text-[11px] text-ink-3 mt-1">
            From lerobot-train log lines (every {run.config?.train?.log_freq} steps). Faint line: raw values; solid: smoothed.
          </p>
        </Sheet>
        <Sheet title="Learning rate">
          <LineChart points={lrPts} yLabel="lr" color="#C2410C" />
        </Sheet>
        <Sheet title="GPU memory">
          <LineChart
            points={gpuMem}
            xLabel="seconds"
            yLabel="GB"
            unit=" GB"
            yMin={0}
            empty={active ? 'Waiting for nvidia-smi samples (every 3 s)…' : 'No GPU samples for this run.'}
            xFormat={(v) => formatDuration(v)}
          />
        </Sheet>
        <Sheet title={gpuUtil.length ? 'GPU utilisation' : 'CPU utilisation'}>
          <LineChart
            points={gpuUtil.length ? gpuUtil : cpuPts}
            xLabel="seconds"
            yLabel="%"
            unit="%"
            yMin={0}
            yMax={100}
            color="#C2410C"
            empty="No samples for this run."
            xFormat={(v) => formatDuration(v)}
          />
        </Sheet>
        <Sheet title="Evaluation" className="xl:col-span-2">
          {evalPts.length ? (
            <LineChart points={evalPts} yLabel="eval loss" />
          ) : (
            <p className="text-[12.5px] text-ink-3">
              No evaluation metrics were reported. lerobot-train evaluates only with a simulation environment or a held-out split
              (eval steps); demonstrations from the real robot have neither, so judge the model with the training loss and a test
              on the robot.
            </p>
          )}
        </Sheet>
      </div>

      {/* terminal */}
      <section className="night-panel">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
            <span className="ml-2 text-[12px] text-white/60 font-mono">run.log · {run.env?.name}</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[12px] text-white/70">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
            </label>
            <button
              className="btn-sm rounded-pill bg-white/10 px-3 py-1 text-[12px] text-white hover:bg-white/20"
              onClick={() => {
                navigator.clipboard?.writeText(
                  stages
                    .filter((s) => s.kind !== 'copy')
                    .map((s) => s.argv.map(q).join(' '))
                    .join('\n\n'),
                );
                toast.success('Command copied');
              }}
            >
              Copy command
            </button>
          </div>
        </div>
        <pre
          ref={logRef}
          className="m-4 mt-3 h-[340px] overflow-auto scroll-thin rounded-2xl bg-black/30 p-4 text-[11.5px] leading-[1.55] text-[#cfe0ff] font-mono whitespace-pre-wrap break-all"
        >
          {cleaned || 'No output yet.'}
        </pre>
      </section>

      {/* outputs */}
      <Sheet
        title="Model output"
        actions={<span className="num text-[11.5px] text-ink-3 truncate max-w-[50%]">{ck?.output_dir}</span>}
      >
        {!ckpts.length ? (
          <p className="text-[12.5px] text-ink-3">
            No checkpoints yet — the first one is written at step {run.config?.train?.save_freq}.
          </p>
        ) : (
          <div className="grid gap-4 grid-cols-[minmax(0,1fr)]">
            {ck.train_config && (
              <div className="flex flex-wrap gap-1.5 text-[12px]">
                <span className="chip">policy {ck.train_config.policy}</span>
                <span className="chip">steps {ck.train_config.steps}</span>
                <span className="chip">batch {ck.train_config.batch_size}</span>
                {ck.train_config.lr && <span className="chip">lr {fmt(ck.train_config.lr, 2)}</span>}
                <span className="chip">seed {ck.train_config.seed}</span>
                <span className="chip truncate max-w-full">dataset {ck.train_config.dataset}</span>
              </div>
            )}
            {compat && (
              <Callout
                tone={compat.inference_ok ? 'ok' : 'info'}
                title={compat.inference_ok ? 'Loadable by the Inference session' : 'Runs on the robot as a host rollout'}
              >
                {compat.inference_ok
                  ? `The Inference container runs LeRobot ${compat.container_lerobot}, matching training.`
                  : compat.reasons.join(' ')}
                {!compat.inference_ok &&
                  ' Use “Run on robot”: it runs the checkpoint with the LeRobot of this training environment (Inference → Host rollout), with enforced motion limits.'}
              </Callout>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-left">
                    {['Step', 'Size', 'Robot success', 'Path', ''].map((h) => (
                      <th key={h} className="label font-medium pb-2 pr-3">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...ckpts].reverse().map((c) => (
                    <tr key={c.step} className="border-t border-rule">
                      <td className="py-2 pr-3 num whitespace-nowrap">
                        {c.step.toLocaleString()} {c.is_last && <span className="chip-ink ml-1">last</span>}
                      </td>
                      <td className="py-2 pr-3 num whitespace-nowrap">{formatBytes(c.model_bytes)}</td>
                      <td className="py-2 pr-3 num whitespace-nowrap">
                        {c.evaluation
                          ? `${Math.round(c.evaluation.rate * 100)}% (${c.evaluation.success}/${c.evaluation.n})`
                          : '—'}
                      </td>
                      <td className="py-2 pr-3 num text-ink-3 break-all">{c.path}</td>
                      <td className="py-2 whitespace-nowrap text-right space-x-1.5">
                        {!c.is_last && (
                          <button
                            className={c.keep ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'}
                            title="Kept checkpoints are never offered for cleanup in Storage"
                            onClick={async () => {
                              const r = await act('keep', { step: c.step, keep: !c.keep });
                              if (r) loadSide();
                            }}
                          >
                            {c.keep ? 'Kept' : 'Keep'}
                          </button>
                        )}
                        <button
                          className="btn btn-sm"
                          onClick={() => {
                            navigator.clipboard?.writeText(c.path);
                            toast.success('Path copied');
                          }}
                        >
                          Copy path
                        </button>
                        <button
                          className="btn btn-sm"
                          disabled={busy === 'export'}
                          onClick={async () => {
                            const r = await act('export', { step: c.step });
                            if (r) toast.success('Exporting to ' + r.path);
                          }}
                        >
                          Export
                        </button>
                        {!compat?.inference_ok && (
                          <button
                            className="btn-sky btn-sm"
                            title="Run this checkpoint on the robot through the training environment (Inference → Host rollout)"
                            onClick={() => {
                              dispatch(setRolloutTarget({ run_id: runId, step: c.step }));
                              dispatch(moveToPage(PageType.INFERENCE));
                            }}
                            data-run-on-robot={c.step}
                          >
                            Run on robot
                          </button>
                        )}
                        <button
                          className="btn-sky btn-sm"
                          disabled={!compat?.inference_ok || !c.container_path}
                          title={
                            compat?.inference_ok
                              ? 'Set this checkpoint as the policy path in Inference'
                              : compat?.reasons?.join(' ')
                          }
                          onClick={() => {
                            dispatch(setPolicyPath(c.container_path));
                            dispatch(moveToPage(PageType.INFERENCE));
                            toast.success('Policy path set in Inference');
                          }}
                        >
                          Use in Inference
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(run.exports || []).length > 0 && (
              <div className="text-[12px] space-y-0.5">
                {run.exports.map((x) => (
                  <div key={x.path} className="flex gap-2">
                    <span className={x.status === 'done' ? 'chip-ok' : x.status === 'failed' ? 'chip-err' : 'chip-sky'}>
                      {x.status}
                    </span>
                    <span className="num break-all text-ink-3">{x.path}</span>
                    {x.size_bytes && <span className="num">{formatBytes(x.size_bytes)}</span>}
                  </div>
                ))}
              </div>
            )}
            <div className="grid gap-2 md:grid-cols-[1fr_2fr_auto] items-end">
              <TextInput
                value={meta.name}
                onChange={(v) => setMeta({ ...meta, name: v })}
                placeholder={ck.metadata?.name || run.job_name}
                aria-label="Model name"
              />
              <TextInput
                value={meta.notes}
                onChange={(v) => setMeta({ ...meta, notes: v })}
                placeholder={ck.metadata?.notes || 'Notes (what changed, what to test)…'}
                aria-label="Model notes"
              />
              <button
                className="btn-primary"
                onClick={async () => {
                  const r = await act('metadata', meta);
                  if (r) {
                    toast.success('Saved pam_model.json next to the checkpoints');
                    loadSide();
                  }
                }}
              >
                Save model card
              </button>
            </div>
            {ck.metadata && (
              <p className="text-[11.5px] text-ink-3">Model card saved {new Date(ck.metadata.saved_at).toLocaleString()}.</p>
            )}
          </div>
        )}
      </Sheet>

      <Modal
        open={!!retry}
        title={retry?.mode === 'resume' ? 'Resume from the last checkpoint' : 'Retry from scratch'}
        onClose={() => setRetry(null)}
        width="max-w-2xl"
        footer={
          <>
            <button className="btn" onClick={() => setRetry(null)}>
              Cancel
            </button>
            <button className="btn-primary" onClick={confirmRetry} disabled={busy === 'retry'}>
              {busy === 'retry' && <Spinner />}Run this command
            </button>
          </>
        }
      >
        {retry && (
          <div className="grid gap-3 text-[13px]">
            {retry.mode === 'resume' && (
              <label className="grid gap-1">
                <span className="label">Total steps (optional — raise it to train longer)</span>
                <TextInput
                  value={retry.steps}
                  onChange={(v) => setRetry({ ...retry, steps: v.replace(/[^0-9]/g, '') })}
                  placeholder={String(run.config?.train?.steps || '')}
                />
              </label>
            )}
            <pre className="rounded-2xl bg-paper p-3 text-[11.5px] font-mono whitespace-pre-wrap break-all">
              {retry.plan.stages.map((s) => s.argv.map(q).join(' ')).join('\n\n')}
            </pre>
          </div>
        )}
      </Modal>
    </div>
  );
}

export function q(a) {
  return /^[A-Za-z0-9_./=:@,+-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`;
}
