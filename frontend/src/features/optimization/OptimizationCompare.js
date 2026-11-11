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

// Optimization comparison dashboard: the original run next to its alternatives.
// Two kinds of evidence are always shown in separate blocks:
//   * training metrics (loss, validation loss, time, memory) - how well the model copies the demos
//   * robot results (Evaluate trials) - whether it actually picks and places
// Takes either a list of run ids (from an optimisation session) or lets the user pick runs.

import React, { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useTrainer } from '../../hooks/useTrainer';
import { fmt } from '../training/LineChart';
import MultiLineChart, { SERIES } from '../training/MultiLineChart';
import { Callout, Empty, Sheet, Spinner, formatBytes, formatDuration } from '../../components/ui';

function Row({ label, cells, strong }) {
  return (
    <tr className="border-t border-ink/10">
      <th className="text-left font-normal text-ink-3 text-[12px] py-1.5 pr-3 whitespace-nowrap">{label}</th>
      {cells.map((c, i) => (
        <td key={i} className={clsx('py-1.5 pr-3 num text-[12.5px] align-top', strong && c.best && 'text-signal-ok font-semibold')}>
          {c.v ?? '—'}
        </td>
      ))}
    </tr>
  );
}

function bestIdx(vals, low = true) {
  const ok = vals.map((v, i) => [v, i]).filter(([v]) => v != null && Number.isFinite(v));
  if (ok.length < 2) return -1;
  return (low ? ok.sort((a, b) => a[0] - b[0]) : ok.sort((a, b) => b[0] - a[0]))[0][1];
}

export default function OptimizationCompare({ runs, runIds, originalId, labels = {} }) {
  const { get } = useTrainer();
  const [sel, setSel] = useState(runIds || []);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const fixed = !!runIds;
  const usable = (runs || []).filter((r) => r.progress?.step);
  useEffect(() => {
    if (runIds) setSel(runIds);
  }, [runIds && runIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const orig = originalId || sel[0];
  const colorOf = (id) => SERIES[Math.max(0, sel.indexOf(id)) % SERIES.length];
  const nameOf = (r) => labels[r.id] || r.job_name;
  const cols = data?.runs || [];

  const robot = (r) => {
    const g = (r.evaluations || []).filter((x) => x.n >= 1);
    if (!g.length) return null;
    const top = [...g].sort((a, b) => b.rate - a.rate)[0];
    return `${Math.round(top.rate * 100)}% (step ${top.step}, ${top.n} trials)`;
  };

  const changed = useMemo(() => (data?.config_diff || []).filter((d) => d.differs), [data]);
  const best = data?.best;
  const bestRun = cols.find((r) => r.id === best?.run_id);
  const robotBased = !!best && best.basis.startsWith('robot');

  return (
    <div className="grid gap-5" data-opt-compare>
      {!fixed && (
        <div className="grid gap-2">
          <div className="label">Choose 2–6 runs — the first one you tick is the original</div>
          <div className="flex flex-wrap gap-2">
            {usable.map((r) => {
              const on = sel.includes(r.id);
              return (
                <label
                  key={r.id}
                  data-opt-pick={r.id}
                  className={clsx('flex items-center gap-2 rounded-pill px-3 py-1.5 text-[12.5px] cursor-pointer', on ? 'bg-ink text-white' : 'bg-white shadow-card')}
                >
                  <input
                    type="checkbox"
                    className="hidden"
                    checked={on}
                    disabled={!on && sel.length >= 6}
                    onChange={() => setSel(on ? sel.filter((x) => x !== r.id) : [...sel, r.id])}
                  />
                  {r.job_name}
                </label>
              );
            })}
            {!usable.length && <span className="text-[12.5px] text-ink-3">No runs with metrics yet.</span>}
          </div>
        </div>
      )}
      {sel.length < 2 && <Empty title="Pick at least two runs">The original run and one or more alternatives.</Empty>}
      {busy && !data && <Spinner />}

      {data && (
        <>
          <Sheet title="Configurations" code="1">
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full text-left" data-config-table>
                <thead>
                  <tr>
                    <th />
                    {cols.map((r) => (
                      <th key={r.id} className="pr-3 pb-2 text-[12.5px] font-semibold whitespace-nowrap">
                        <span className="inline-block h-2 w-2 rounded-full mr-1.5" style={{ background: colorOf(r.id) }} />
                        {nameOf(r)}
                        {r.id === orig && <span className="chip ml-2">original</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {changed.length ? (
                    changed.map((d) => <Row key={d.key} label={d.key} cells={d.values.map((v) => ({ v: v == null ? 'default' : String(v) }))} />)
                  ) : (
                    <Row label="Differences" cells={cols.map(() => ({ v: 'none' }))} />
                  )}
                  <Row label="Model / dataset" cells={cols.map((r) => ({ v: `${r.policy} · ${r.dataset}` }))} />
                </tbody>
              </table>
            </div>
          </Sheet>

          <Sheet title="Training metrics" code="2">
            <Callout tone="info" className="mb-3">
              These numbers describe how well each run copies the recorded demonstrations. A lower loss does <b>not</b> mean a better
              grasp.
            </Callout>
            <div className="grid gap-5 lg:grid-cols-2 mb-4">
              <div>
                <div className="label mb-1">Training loss</div>
                <MultiLineChart log series={cols.map((r) => ({ id: r.id, label: nameOf(r), color: colorOf(r.id), points: r.loss }))} />
              </div>
              <div>
                <div className="label mb-1">Validation loss (held-out episodes)</div>
                {cols.some((r) => r.eval_loss.length) ? (
                  <MultiLineChart
                    log
                    series={cols.filter((r) => r.eval_loss.length).map((r) => ({ id: r.id, label: nameOf(r), color: colorOf(r.id), points: r.eval_loss }))}
                  />
                ) : (
                  <div className="h-[170px] grid place-items-center rounded-2xl bg-paper text-[12.5px] text-ink-3 text-center px-4">
                    None of these runs held out episodes. Turn validation on in New training → Configure.
                  </div>
                )}
              </div>
            </div>
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full" data-metric-table>
                <tbody>
                  <Row
                    strong
                    label="Final training loss"
                    cells={cols.map((r, i) => ({ v: fmt(r.final_loss), best: i === bestIdx(cols.map((x) => x.final_loss)) }))}
                  />
                  <Row label="Lowest training loss" cells={cols.map((r) => ({ v: fmt(r.min_loss) }))} />
                  <Row
                    strong
                    label="Best validation loss"
                    cells={cols.map((r, i) => ({ v: r.eval_best != null ? fmt(r.eval_best) : null, best: i === bestIdx(cols.map((x) => x.eval_best)) }))}
                  />
                  <Row label="Last validation loss" cells={cols.map((r) => ({ v: r.eval_last != null ? fmt(r.eval_last) : null }))} />
                  <Row label="Steps done" cells={cols.map((r) => ({ v: r.steps_done }))} />
                  <Row
                    strong
                    label="Training time"
                    cells={cols.map((r, i) => ({ v: r.duration_s ? formatDuration(r.duration_s) : null, best: i === bestIdx(cols.map((x) => x.duration_s)) }))}
                  />
                  <Row label="Time per step" cells={cols.map((r) => ({ v: r.step_time_s ? `${fmt(r.step_time_s)} s` : null }))} />
                  <Row
                    strong
                    label="Peak GPU memory"
                    cells={cols.map((r, i) => ({ v: r.gpu_peak_mb ? `${(r.gpu_peak_mb / 1024).toFixed(2)} GB` : null, best: i === bestIdx(cols.map((x) => x.gpu_peak_mb)) }))}
                  />
                  <Row label="Stability" cells={cols.map((r) => ({ v: r.stability }))} />
                </tbody>
              </table>
            </div>
          </Sheet>

          <Sheet title="Checkpoints" code="3">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {cols.map((r) => (
                <div key={r.id} className="rounded-2xl bg-white shadow-card p-3">
                  <div className="text-[13px] font-semibold truncate">{nameOf(r)}</div>
                  {r.checkpoints.length ? (
                    <ul className="mt-1 grid gap-0.5 text-[12px] num">
                      {r.checkpoints.map((c) => {
                        const ev = (r.evaluations || []).find((g) => g.step === c.step);
                        return (
                          <li key={c.step} className="flex justify-between gap-2">
                            <span>
                              step {c.step}
                              {c.is_last ? ' · last' : ''}
                            </span>
                            <span className="text-ink-3">
                              {formatBytes(c.size_bytes)}
                              {ev ? ` · robot ${Math.round(ev.rate * 100)}% (${ev.n})` : ''}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="text-[12px] text-ink-3 mt-1">No checkpoint written yet.</p>
                  )}
                </div>
              ))}
            </div>
          </Sheet>

          <Sheet title="Robot results" code="4">
            <table className="w-full" data-robot-table>
              <tbody>
                <Row label="Best success rate on the robot" cells={cols.map((r) => ({ v: robot(r) || 'not evaluated' }))} />
              </tbody>
            </table>
            <p className="text-[11.5px] text-ink-3 mt-2">
              From Evaluate trials you recorded. This is the evidence that matters; three or more trials per checkpoint are needed before it
              is used to pick a winner.
            </p>
          </Sheet>

          <Sheet title="Recommendation" code="5">
            {bestRun ? (
              <div className="grid gap-2" data-recommendation>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={robotBased ? 'chip-ok' : 'chip-warn'}>{robotBased ? 'based on robot trials' : 'based on training metrics only'}</span>
                  <b className="text-[14px]">
                    {nameOf(bestRun)}
                    {best.step != null ? `, step ${best.step}` : ''}
                  </b>
                  {bestRun.id === orig && <span className="chip">the original</span>}
                </div>
                <p className="text-[12.5px] text-ink-2">{best.basis}</p>
                {bestRun.id !== orig && changed.length > 0 && (
                  <div className="rounded-xl bg-paper px-3 py-2 text-[12.5px]">
                    <div className="label mb-1">Settings for the next run</div>
                    {changed.map((d) => {
                      const v = d.values[cols.findIndex((r) => r.id === bestRun.id)];
                      const o = d.values[cols.findIndex((r) => r.id === orig)];
                      return (
                        <div key={d.key} className="num">
                          {d.key}: {o == null ? 'default' : String(o)} → <b>{v == null ? 'default' : String(v)}</b>
                        </div>
                      );
                    })}
                  </div>
                )}
                {!robotBased && (
                  <Callout tone="warn">
                    No robot trials decide this yet. Evaluate the best checkpoint of each run on the robot before relying on it.
                  </Callout>
                )}
              </div>
            ) : (
              <p className="text-[13px] text-ink-2">Not enough finished data to recommend anything yet.</p>
            )}
          </Sheet>
        </>
      )}
    </div>
  );
}
