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

// Queue, run comparison and storage panels of the Training session.

import React, { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useTrainer } from '../../hooks/useTrainer';
import MultiLineChart, { SERIES } from './MultiLineChart';
import { fmt } from './LineChart';
import { StatusChip, q } from './RunMonitor';
import { Callout, Empty, Modal, Sheet, Spinner, TextInput, formatBytes, formatDuration } from '../../components/ui';

const QSTATUS = {
  queued: ['chip-sky', 'Waiting'],
  started: ['chip-ok', 'Started'],
  needs_review: ['chip-warn', 'Needs review'],
  cancelled: ['chip', 'Cancelled'],
  start_failed: ['chip-err', 'Could not start'],
};

// ---------------------------------------------------------------------------
export function QueuePanel({ onOpenRun }) {
  const { get, post } = useTrainer();
  const [items, setItems] = useState(null);
  const [review, setReview] = useState(null);
  const load = useCallback(async () => {
    try {
      setItems((await get('/queue')).items);
    } catch (e) {
      toast.error(e.message);
    }
  }, [get]);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (path, body) => {
    try {
      await post(path, body);
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const openReview = async (it) => {
    try {
      setReview(await get(`/queue/${it.id}/preview`, { timeoutMs: 120000 }));
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (!items) return <Spinner />;
  const waiting = items.filter((i) => ['queued', 'needs_review'].includes(i.status));
  return (
    <div className="grid gap-4 grid-cols-[minmax(0,1fr)]">
      <Callout tone="info">
        Queued jobs start one after another when nothing else is training. Each keeps the exact command you confirmed; if that
        command would change when its turn comes (dataset re-recorded, LeRobot updated, folder taken), it waits as{' '}
        <b>Needs review</b> instead of running.
      </Callout>
      {!items.length ? (
        <Empty title="The queue is empty">In New training, use “Add to queue” on the review step.</Empty>
      ) : (
        <div className="grid gap-2">
          {items.map((it, i) => {
            const [cls, label] = QSTATUS[it.status] || ['chip', it.status];
            return (
              <div
                key={it.id}
                className="sheet px-4 py-3 grid gap-1 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
                data-queue-item={it.job_name}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="num text-[11px] text-ink-4">{i + 1}</span>
                    <span className="font-semibold text-[13.5px] truncate">{it.job_name}</span>
                    <span className={cls}>{label}</span>
                  </div>
                  <div className="num text-[11px] text-ink-3 truncate">
                    {it.policy} · {it.dataset} · {it.plan_summary?.stages?.join(' → ')} · added{' '}
                    {new Date(it.created_at).toLocaleString()}
                  </div>
                  {it.error && <div className="text-[12px] text-signal-warn mt-0.5">{it.error}</div>}
                </div>
                <div className="flex flex-wrap gap-1.5 justify-end">
                  {it.status === 'queued' && (
                    <>
                      <button
                        className="btn-ghost btn-sm"
                        onClick={() => act(`/queue/${it.id}/move`, { delta: -1 })}
                        aria-label="Move up"
                      >
                        ↑
                      </button>
                      <button
                        className="btn-ghost btn-sm"
                        onClick={() => act(`/queue/${it.id}/move`, { delta: 1 })}
                        aria-label="Move down"
                      >
                        ↓
                      </button>
                    </>
                  )}
                  {['needs_review', 'start_failed', 'cancelled'].includes(it.status) && (
                    <button className="btn btn-sm" onClick={() => openReview(it)}>
                      Review & re-queue
                    </button>
                  )}
                  {['queued', 'needs_review', 'start_failed'].includes(it.status) && (
                    <button className="btn-danger btn-sm" onClick={() => act(`/queue/${it.id}/cancel`)}>
                      Cancel
                    </button>
                  )}
                  {it.run_id && (
                    <button className="btn btn-sm" onClick={() => onOpenRun(it.run_id)}>
                      Open run →
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {items.length > waiting.length && (
            <button className="btn-ghost btn-sm justify-self-start" onClick={() => act('/queue/clear')}>
              Remove finished and cancelled entries
            </button>
          )}
        </div>
      )}
      <Modal
        open={!!review}
        title={`Review ${review?.item?.job_name || ''}`}
        onClose={() => setReview(null)}
        width="max-w-3xl"
        footer={
          <>
            <button className="btn" onClick={() => setReview(null)}>
              Close
            </button>
            <button
              className="btn-primary"
              disabled={!review?.preview?.ok}
              onClick={async () => {
                await act(`/queue/${review.item.id}/confirm`, { confirm_token: review.preview.token });
                setReview(null);
              }}
            >
              Confirm and queue again
            </button>
          </>
        }
      >
        {review && (
          <div className="grid gap-2 text-[12.5px]">
            {review.preview.errors.map((e) => (
              <Callout key={e} tone="err">
                {e}
              </Callout>
            ))}
            {review.preview.warnings.map((e) => (
              <Callout key={e} tone="warn">
                {e}
              </Callout>
            ))}
            <pre className="rounded-2xl bg-paper p-3 text-[11.5px] font-mono whitespace-pre-wrap break-all">
              {review.preview.stages.map((s) => s.argv.map(q).join(' ')).join('\n\n')}
            </pre>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function ComparePanel({ runs, onOpenRun }) {
  const { get } = useTrainer();
  const [sel, setSel] = useState([]);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [logY, setLogY] = useState(true);
  const usable = (runs || []).filter((r) => r.progress?.step);

  useEffect(() => {
    if (sel.length < 2) {
      setData(null);
      return;
    }
    setBusy(true);
    get(`/compare?ids=${sel.join(',')}`)
      .then(setData, (e) => toast.error(e.message))
      .finally(() => setBusy(false));
  }, [sel, get]);

  const color = (id) => SERIES[sel.indexOf(id) % SERIES.length];
  return (
    <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
      <div className="grid gap-2 content-start">
        <div className="label">Choose 2–6 runs</div>
        {usable.map((r) => {
          const on = sel.includes(r.id);
          return (
            <label
              key={r.id}
              className={clsx(
                'flex items-start gap-2 rounded-2xl px-3 py-2 cursor-pointer',
                on ? 'bg-white shadow-lift' : 'bg-white/60 hover:bg-white',
              )}
              data-compare={r.id}
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={on}
                disabled={!on && sel.length >= 6}
                onChange={() => setSel(on ? sel.filter((x) => x !== r.id) : [...sel, r.id])}
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  {on && <span className="h-2.5 w-2.5 rounded-full" style={{ background: color(r.id) }} />}
                  <span className="text-[13px] font-medium truncate">{r.job_name}</span>
                </span>
                <span className="block num text-[11px] text-ink-3 truncate">
                  {r.policy} · {r.progress.step} steps · {r.status}
                </span>
              </span>
            </label>
          );
        })}
        {!usable.length && <p className="text-[12px] text-ink-3">No runs with logged steps yet.</p>}
      </div>
      <div className="min-w-0 grid gap-4 content-start">
        {sel.length < 2 ? (
          <Empty title="Pick at least two runs">
            Loss curves are overlaid on one axis and the settings that differ are highlighted.
          </Empty>
        ) : busy && !data ? (
          <Spinner />
        ) : (
          data && (
            <>
              {data.best && (
                <Callout tone="ok" title="Best checkpoint so far">
                  {data.runs.find((r) => r.id === data.best.run_id)?.job_name} · step {data.best.step} — {data.best.basis}.{' '}
                  <button className="underline" onClick={() => onOpenRun(data.best.run_id)}>
                    Open run
                  </button>
                </Callout>
              )}
              <Sheet
                title="Training loss"
                actions={
                  <label className="flex items-center gap-1.5 text-[12px] text-ink-3">
                    <input type="checkbox" checked={logY} onChange={(e) => setLogY(e.target.checked)} /> log scale
                  </label>
                }
              >
                <MultiLineChart
                  log={logY}
                  series={data.runs.flatMap((r) => [
                    { id: r.id, label: r.job_name, color: color(r.id), points: r.loss },
                    ...(r.eval_loss.length
                      ? [
                          {
                            id: `${r.id}-e`,
                            label: `${r.job_name} (eval)`,
                            color: color(r.id),
                            points: r.eval_loss,
                            dashed: true,
                          },
                        ]
                      : []),
                  ])}
                />
              </Sheet>
              <Sheet title="Runs">
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="text-left">
                        {['', 'Run', 'Status', 'Steps', 'Duration', 'Final loss', 'Min loss', 'Checkpoints', 'Robot success'].map(
                          (h) => (
                            <th key={h} className="label font-medium pb-2 pr-3 whitespace-nowrap">
                              {h}
                            </th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {data.runs.map((r) => {
                        const ev = [...r.evaluations].sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))[0];
                        return (
                          <tr key={r.id} className="border-t border-rule">
                            <td className="py-2 pr-2">
                              <span className="block h-2.5 w-2.5 rounded-full" style={{ background: color(r.id) }} />
                            </td>
                            <td className="py-2 pr-3 font-medium">{r.job_name}</td>
                            <td className="py-2 pr-3">
                              <StatusChip status={r.status} />
                            </td>
                            <td className="py-2 pr-3 num">{r.steps_done}</td>
                            <td className="py-2 pr-3 num">{formatDuration(r.duration_s)}</td>
                            <td className="py-2 pr-3 num">{fmt(r.final_loss, 4)}</td>
                            <td className="py-2 pr-3 num">{fmt(r.min_loss, 4)}</td>
                            <td className="py-2 pr-3 num">{r.checkpoints.map((c) => c.step).join(', ') || '—'}</td>
                            <td className="py-2 pr-3 num">
                              {ev ? `${Math.round(ev.rate * 100)}% (${ev.success}/${ev.n}) @${ev.step}` : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Sheet>
              <Sheet title="Settings">
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="text-left">
                        <th className="label font-medium pb-2 pr-3">Setting</th>
                        {data.runs.map((r) => (
                          <th key={r.id} className="label font-medium pb-2 pr-3 truncate max-w-[160px]">
                            <span className="inline-block h-2 w-2 rounded-full mr-1" style={{ background: color(r.id) }} />
                            {r.job_name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { key: 'policy', values: data.runs.map((r) => r.policy) },
                        { key: 'dataset', values: data.runs.map((r) => r.dataset) },
                        { key: 'episodes', values: data.runs.map((r) => r.episodes) },
                        { key: 'LeRobot', values: data.runs.map((r) => r.lerobot) },
                        ...data.config_diff,
                      ].map((row) => {
                        const differs = row.differs ?? new Set(row.values.map(String)).size > 1;
                        return (
                          <tr key={row.key} className={clsx('border-t border-rule', differs && 'bg-sky-50')}>
                            <td className="py-1.5 pr-3 num">{row.key}</td>
                            {row.values.map((v, i) => (
                              <td key={i} className={clsx('py-1.5 pr-3 num', differs && 'font-semibold')}>
                                {v == null ? '—' : String(v)}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-ink-3 mt-2">Highlighted rows differ between the runs.</p>
              </Sheet>
            </>
          )
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function StoragePanel() {
  const { get, post } = useTrainer();
  const [inv, setInv] = useState(null);
  const [sel, setSel] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const [typed, setTyped] = useState('');
  const load = useCallback(async () => {
    try {
      setInv(await get('/storage', { timeoutMs: 120000 }));
    } catch (e) {
      toast.error(e.message);
    }
  }, [get]);
  useEffect(() => {
    load();
  }, [load]);

  if (!inv) return <Spinner />;
  const toggle = (p) => setSel(sel.includes(p) ? sel.filter((x) => x !== p) : [...sel, p]);
  const all = [...inv.copies, ...inv.checkpoints, ...inv.exports];
  const selBytes = all.filter((x) => sel.includes(x.path)).reduce((a, x) => a + x.bytes, 0);

  const Group = ({ title, rows, label }) => (
    <Sheet title={`${title} · ${formatBytes(rows.reduce((a, x) => a + x.bytes, 0))}`}>
      {!rows.length ? (
        <p className="text-[12px] text-ink-3">Nothing here.</p>
      ) : (
        <div className="grid gap-1">
          {rows.map((x) => (
            <label
              key={x.path}
              className={clsx(
                'flex items-center gap-3 rounded-xl px-3 py-2 text-[12.5px]',
                x.protected ? 'bg-paper/60' : 'bg-paper hover:bg-paper-2 cursor-pointer',
              )}
            >
              <input
                type="checkbox"
                disabled={x.protected}
                checked={sel.includes(x.path)}
                onChange={() => toggle(x.path)}
                data-storage={x.path}
              />
              <span className="flex-1 min-w-0">
                <span className="block truncate font-medium">{label(x)}</span>
                <span className="block num text-[11px] text-ink-3 truncate">{x.path}</span>
              </span>
              <span className={x.protected ? 'chip' : 'chip-sky'}>{x.protected ? `kept: ${x.reason}` : x.reason}</span>
              <span className="num w-20 text-right">{formatBytes(x.bytes)}</span>
            </label>
          ))}
        </div>
      )}
    </Sheet>
  );

  return (
    <div className="grid gap-4 grid-cols-[minmax(0,1fr)]">
      <div className="grid gap-3 md:grid-cols-3">
        {inv.disks.map((d) => (
          <div key={d.path} className="sheet px-5 py-4">
            <div className="label truncate">Disk · {d.path}</div>
            <div className="text-[30px] font-light mt-1">{formatBytes(d.free)} free</div>
            <div className="mt-2 h-2 rounded-pill bg-paper-2 overflow-hidden">
              <div
                className={clsx('h-full', d.free / d.total < 0.1 ? 'bg-signal-err' : 'bg-ink')}
                style={{ width: `${(d.used / d.total) * 100}%` }}
              />
            </div>
            <div className="num text-[11px] text-ink-3 mt-1">
              {formatBytes(d.used)} of {formatBytes(d.total)} used
            </div>
          </div>
        ))}
        <div className="sheet px-5 py-4">
          <div className="label">Written by training</div>
          <div className="text-[30px] font-light mt-1">{formatBytes(inv.total_bytes)}</div>
          <div className="num text-[11px] text-ink-3 mt-1">{formatBytes(inv.reclaimable_bytes)} can be freed safely</div>
        </div>
      </div>
      <Callout tone="info">
        Only files the training service created are listed. Recorded datasets never appear here and cannot be deleted from this
        page. The last checkpoint of every run, checkpoints with robot evaluations, checkpoints marked “keep”, and anything an
        active or queued run needs are protected.
      </Callout>
      <Group title="Converted dataset copies" rows={inv.copies} label={(x) => x.name} />
      <Group
        title="Checkpoints"
        rows={inv.checkpoints}
        label={(x) => `${x.job_name} · step ${x.step.toLocaleString()} (${x.policy})`}
      />
      <Group title="Exports" rows={inv.exports} label={(x) => x.name} />
      <div className="sticky bottom-3 sheet shadow-lift px-5 py-3 flex items-center gap-4">
        <span className="text-[13px] flex-1">
          {sel.length ? (
            <>
              <b>{sel.length}</b> selected · {formatBytes(selBytes)}
            </>
          ) : (
            'Select items to delete'
          )}
        </span>
        <button className="btn-danger" disabled={!sel.length} onClick={() => setConfirm(true)}>
          Delete selected…
        </button>
      </div>
      <Modal
        open={!!confirm}
        title="Delete files"
        onClose={() => {
          setConfirm(null);
          setTyped('');
        }}
        footer={
          <>
            <button className="btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="btn-danger"
              disabled={typed !== 'DELETE'}
              onClick={async () => {
                try {
                  const r = await post('/storage/cleanup', { paths: sel, confirm: typed });
                  toast.success(`Freed ${formatBytes(r.freed_bytes)}`);
                  r.refused.forEach((x) => toast.error(`Kept ${x.path.split('/').pop()}: ${x.reason}`));
                  setSel([]);
                  setConfirm(null);
                  setTyped('');
                  load();
                } catch (e) {
                  toast.error(e.message);
                }
              }}
            >
              Delete {sel.length} item(s)
            </button>
          </>
        }
      >
        <div className="grid gap-2 text-[13px]">
          <p>
            This permanently deletes {sel.length} item(s), {formatBytes(selBytes)}. Type <b>DELETE</b> to confirm.
          </p>
          <TextInput value={typed} onChange={setTyped} placeholder="DELETE" aria-label="Type DELETE" />
        </div>
      </Modal>
    </div>
  );
}
