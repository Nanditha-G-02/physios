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

// Real-robot evaluation log: record what happened when a checkpoint ran on the
// robot, see success rates per checkpoint, and turn failure positions into a
// targeted re-collection plan (Planning service: plan.targeted).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch } from 'react-redux';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useTrainer } from '../../hooks/useTrainer';
import { usePlanningService } from '../../hooks/usePlanningService';
import WorkspaceCanvas from '../planning/WorkspaceCanvas';
import { setEditingPlanId } from '../planning/planningSlice';
import { moveToPage } from '../ui/uiSlice';
import PageType from '../../constants/pageType';
import { Callout, Empty, Field, Modal, NumberInput, Select, Sheet, Spinner, TextInput } from '../../components/ui';

// fixed categorical order (validated palette); success keeps slot 3 (aqua)
export const OUTCOME_COLOR = {
  success: '#2457E6',
  failed_grasp: '#0B0C0E',
  missed_place: '#5E636C',
  collision: '#9B9FA7',
  timeout: '#A9C1FF',
  other: '#7E848D',
};

function cluster(points, radius = 40) {
  const out = [];
  points.forEach((p) => {
    const c = out.find((k) => Math.hypot(k.x_mm - p.x_mm, k.y_mm - p.y_mm) <= radius);
    if (c) {
      c.members.push(p);
      c.x_mm = c.members.reduce((a, m) => a + m.x_mm, 0) / c.members.length;
      c.y_mm = c.members.reduce((a, m) => a + m.y_mm, 0) / c.members.length;
    } else out.push({ x_mm: p.x_mm, y_mm: p.y_mm, members: [p] });
  });
  return out.sort((a, b) => b.members.length - a.members.length);
}

function RateBar({ g }) {
  const pct = (v) => `${Math.round((v || 0) * 100)}%`;
  return (
    <div className="grid gap-1">
      <div
        className="relative h-2.5 rounded-pill bg-paper-2 overflow-hidden"
        title={`95% interval ${pct(g.ci[0])}–${pct(g.ci[1])}`}
      >
        <div
          className="absolute inset-y-0 bg-sky-100"
          style={{ left: pct(g.ci[0]), width: `${((g.ci[1] || 0) - (g.ci[0] || 0)) * 100}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 rounded-pill"
          style={{ width: pct(g.rate), background: OUTCOME_COLOR.success }}
        />
      </div>
      <div className="flex h-1.5 rounded-pill overflow-hidden gap-[2px]">
        {Object.entries(g.outcomes)
          .filter(([, n]) => n)
          .map(([k, n]) => (
            <div key={k} style={{ width: `${(n / g.n) * 100}%`, background: OUTCOME_COLOR[k] }} title={`${k}: ${n}`} />
          ))}
      </div>
    </div>
  );
}

export default function EvaluationPanel({ initialRunId, compact }) {
  const dispatch = useDispatch();
  const { get, post } = useTrainer();
  const { call } = usePlanningService();
  const [runs, setRuns] = useState(null);
  const [runId, setRunId] = useState(initialRunId || '');
  const [ckpts, setCkpts] = useState([]);
  const [step, setStep] = useState('');
  const [ov, setOv] = useState(null);
  const [plans, setPlans] = useState([]);
  const [planId, setPlanId] = useState('');
  const [plan, setPlan] = useState(null);
  const [form, setForm] = useState({ outcome: 'success', object: null, target: null, notes: '', conditions: '' });
  const [pickTarget, setPickTarget] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filterAll, setFilterAll] = useState(false);
  const [targeted, setTargeted] = useState(null);

  const load = useCallback(async () => {
    try {
      const [r, e] = await Promise.all([get('/runs'), get('/evaluations')]);
      setRuns(r.runs.filter((x) => x.progress?.step));
      setOv(e);
    } catch (err) {
      toast.error(err.message);
    }
  }, [get]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!runId && runs?.length) setRunId(runs.find((r) => r.status === 'succeeded')?.id || runs[0].id);
  }, [runs, runId]);
  useEffect(() => {
    if (!runId) return;
    get(`/runs/${runId}/checkpoints`).then(
      (c) => {
        setCkpts(c.checkpoints);
        setStep((s) => (c.checkpoints.some((k) => String(k.step) === String(s)) ? s : String(c.checkpoints.at(-1)?.step ?? '')));
      },
      (e) => toast.error(e.message),
    );
  }, [runId, get]);

  // plans (for the workspace map and targeted re-collection); optional
  useEffect(() => {
    call('plan.list', {}).then(
      (r) => setPlans(r.plans || []),
      () => setPlans([]),
    );
  }, [call]);
  const run = (runs || []).find((r) => r.id === runId);
  useEffect(() => {
    if (planId || !plans.length) return;
    const byDs = run && plans.find((p) => p.dataset_id === run.dataset);
    setPlanId((byDs || plans.find((p) => p.status === 'approved') || plans[0]).id);
  }, [plans, run, planId]);
  useEffect(() => {
    if (!planId) return;
    call('plan.get', { plan_id: planId }).then(
      (r) => setPlan(r.plan),
      () => setPlan(null),
    );
  }, [planId, call]);

  const trials = useMemo(
    () => (ov?.trials || []).filter((t) => filterAll || (t.run_id === runId && String(t.step) === String(step))),
    [ov, runId, step, filterAll],
  );
  const failures = useMemo(() => trials.filter((t) => t.outcome !== 'success' && t.object?.x_mm != null), [trials]);

  const save = async () => {
    setSaving(true);
    try {
      await post('/evaluations', {
        run_id: runId,
        step: Number(step),
        outcome: form.outcome,
        object: form.object,
        target: form.target,
        notes: form.notes,
        conditions: form.conditions,
        plan_id: planId || null,
      });
      toast.success('Trial saved');
      setForm({ ...form, outcome: 'success', object: null, target: null, notes: '' });
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!runs || !ov) return <Spinner />;
  if (!runs.length)
    return <Empty title="No trained runs yet">Train a model first; its checkpoints can then be evaluated on the robot.</Empty>;

  const objItem = plan?.task?.items?.find((i) => i.role === 'object');
  const tgtItem = plan?.task?.items?.find((i) => i.role === 'target');
  const marks = [];
  if (form.object && objItem) marks.push({ item_id: objItem.id, ...form.object, yaw_deg: 0 });
  if (form.target && tgtItem) marks.push({ item_id: tgtItem.id, ...form.target, yaw_deg: 0 });
  const summary = ov.summary.filter((g) => filterAll || g.run_id === runId);

  return (
    <div className={clsx('grid gap-5', compact ? 'grid-cols-[minmax(0,1fr)]' : 'xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]')}>
      <div className="grid gap-4 content-start min-w-0">
        <Sheet title="Log a robot trial">
          <div className="grid gap-3">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Run">
                <Select
                  value={runId}
                  onChange={setRunId}
                  options={runs.map((r) => ({ value: r.id, label: `${r.job_name} (${r.policy})` }))}
                  data-eval-run
                />
              </Field>
              <Field label="Checkpoint">
                <Select
                  value={step}
                  onChange={setStep}
                  options={ckpts.map((c) => ({
                    value: String(c.step),
                    label: `step ${c.step.toLocaleString()}${c.is_last ? ' (last)' : ''}${c.evaluation ? ` · ${Math.round(c.evaluation.rate * 100)}% of ${c.evaluation.n}` : ''}`,
                  }))}
                  data-eval-step
                />
              </Field>
            </div>
            <div>
              <div className="label mb-1.5">Outcome</div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(ov.outcomes).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    data-outcome={k}
                    onClick={() => setForm({ ...form, outcome: k })}
                    className={clsx(
                      'rounded-pill px-3 py-1.5 text-[12.5px] flex items-center gap-1.5 transition-all',
                      form.outcome === k ? 'bg-ink text-white' : 'bg-paper hover:bg-paper-2',
                    )}
                  >
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: OUTCOME_COLOR[k] }} />
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Object position (mm)" hint="Click the map, or type">
                <div className="flex gap-2">
                  <NumberInput
                    value={form.object?.x_mm ?? ''}
                    onChange={(v) => setForm({ ...form, object: { x_mm: v, y_mm: form.object?.y_mm ?? 0 } })}
                    suffix="x"
                  />
                  <NumberInput
                    value={form.object?.y_mm ?? ''}
                    onChange={(v) => setForm({ ...form, object: { x_mm: form.object?.x_mm ?? 0, y_mm: v } })}
                    suffix="y"
                  />
                </div>
              </Field>
              <Field label="Conditions" hint="lighting, cube colour, distractors…">
                <TextInput value={form.conditions} onChange={(v) => setForm({ ...form, conditions: v })} placeholder="optional" />
              </Field>
            </div>
            <Field label="Notes / what went wrong">
              <TextInput
                value={form.notes}
                onChange={(v) => setForm({ ...form, notes: v })}
                placeholder="e.g. closed 1 cm too early, cube slipped"
                data-eval-notes
              />
            </Field>
            <div className="flex items-center gap-3">
              <button className="btn-primary" disabled={!step || saving} onClick={save} data-eval-save>
                {saving && <Spinner />}Save trial
              </button>
              <span className="text-[11.5px] text-ink-3">Stored on this PC with the training runs.</span>
            </div>
          </div>
        </Sheet>

        <Sheet
          title="Success rate by checkpoint"
          actions={
            <label className="flex items-center gap-1.5 text-[12px] text-ink-3">
              <input type="checkbox" checked={filterAll} onChange={(e) => setFilterAll(e.target.checked)} /> all runs
            </label>
          }
        >
          {!summary.length ? (
            <p className="text-[12.5px] text-ink-3">No trials logged yet.</p>
          ) : (
            <div className="grid gap-3">
              {summary.map((g, i) => (
                <div key={`${g.run_id}-${g.step}`} className="grid grid-cols-[minmax(0,1fr)_120px] gap-3 items-center">
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-medium truncate">
                      {g.job_name} · step {g.step.toLocaleString()}{' '}
                      {i === 0 && g.n >= 3 && <span className="chip-ok ml-1">best so far</span>}
                    </div>
                    <RateBar g={g} />
                  </div>
                  <div className="text-right">
                    <div className="text-[22px] font-light tabular-nums">{Math.round(g.rate * 100)}%</div>
                    <div className="num text-[11px] text-ink-3">
                      {g.success}/{g.n} trials
                    </div>
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-3">
                {Object.entries(ov.outcomes).map(([k, l]) => (
                  <span key={k} className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full" style={{ background: OUTCOME_COLOR[k] }} />
                    {l}
                  </span>
                ))}
                <span>· light band: 95% interval</span>
              </div>
            </div>
          )}
        </Sheet>
      </div>

      <div className="grid gap-4 content-start min-w-0">
        <Sheet
          title="Where it succeeds and fails"
          actions={
            plans.length > 0 && (
              <Select
                value={planId}
                onChange={setPlanId}
                options={plans.map((p) => ({ value: p.id, label: `map: ${p.name}` }))}
                className="!py-1 !text-[12px] max-w-[220px]"
              />
            )
          }
        >
          {plan ? (
            <>
              <WorkspaceCanvas
                workspace={plan.task.workspace}
                regions={plan.task.regions}
                items={plan.task.items}
                placements={marks}
                height={360}
                dots={trials
                  .filter((t) => t.object?.x_mm != null)
                  .map((t) => ({
                    x_mm: t.object.x_mm,
                    y_mm: t.object.y_mm,
                    color: OUTCOME_COLOR[t.outcome],
                    title: `${ov.outcomes[t.outcome]} · ${t.notes || ''}`,
                  }))}
                onPick={(x, y) =>
                  pickTarget
                    ? setForm({ ...form, target: { x_mm: x, y_mm: y } })
                    : setForm({ ...form, object: { x_mm: x, y_mm: y } })
                }
                caption={pickTarget ? 'Click to set the target position' : 'Click to set where the object was'}
              />
              <div className="flex flex-wrap items-center gap-3 mt-2 text-[12px]">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={pickTarget} onChange={(e) => setPickTarget(e.target.checked)} /> clicking sets
                  the target
                </label>
                <button
                  className="btn-sky btn-sm ml-auto"
                  disabled={!failures.length}
                  onClick={() => {
                    const cl = cluster(failures.map((t) => ({ id: t.id, x_mm: t.object.x_mm, y_mm: t.object.y_mm })));
                    setTargeted({
                      clusters: cl.map((c) => ({ ...c, on: true })),
                      extra: [],
                      episodes: Math.min(30, Math.max(6, failures.length * 3)),
                      spread: 25,
                      notes: '',
                      instruction: '',
                    });
                  }}
                  data-targeted
                  title={failures.length ? '' : 'Log failed trials with an object position first'}
                >
                  Re-collect where it fails →
                </button>
              </div>
            </>
          ) : (
            <Callout tone="info">
              {plans.length
                ? 'Loading the plan…'
                : 'Planning service not reachable or no plans — positions can still be typed in mm.'}
            </Callout>
          )}
        </Sheet>

        <Sheet title={`Trials${filterAll ? '' : ' of this checkpoint'} (${trials.length})`}>
          {!trials.length ? (
            <p className="text-[12.5px] text-ink-3">None yet.</p>
          ) : (
            <div className="max-h-[320px] overflow-auto scroll-thin grid gap-1">
              {[...trials].reverse().map((t) => (
                <div key={t.id} className="flex items-center gap-3 rounded-xl bg-paper px-3 py-2 text-[12px]">
                  <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: OUTCOME_COLOR[t.outcome] }} />
                  <span className="w-28 shrink-0 font-medium">{ov.outcomes[t.outcome]}</span>
                  <span className="num w-28 shrink-0 text-ink-3">
                    {t.object?.x_mm != null ? `${t.object.x_mm}, ${t.object.y_mm}` : '—'}
                  </span>
                  <span className="flex-1 truncate text-ink-2">{t.notes || t.conditions}</span>
                  {filterAll && (
                    <span className="num text-ink-4 truncate max-w-[120px]">
                      {t.job_name}@{t.step}
                    </span>
                  )}
                  <button
                    className="btn-ghost btn-sm !px-2"
                    aria-label="Remove trial"
                    onClick={async () => {
                      try {
                        await post(`/evaluations/${t.id}/delete`);
                        load();
                      } catch (e) {
                        toast.error(e.message);
                      }
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </Sheet>
      </div>

      <Modal
        open={!!targeted}
        title="Targeted re-collection plan"
        onClose={() => setTargeted(null)}
        width="max-w-3xl"
        footer={
          <>
            <button className="btn" onClick={() => setTargeted(null)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              data-targeted-create
              disabled={!targeted || ![...targeted.clusters.filter((c) => c.on), ...targeted.extra].length}
              onClick={async () => {
                const pts = [
                  ...targeted.clusters.filter((c) => c.on).map((c) => ({ x_mm: c.x_mm, y_mm: c.y_mm, weight: c.members.length })),
                  ...targeted.extra.map((p) => ({ ...p, weight: 1 })),
                ];
                try {
                  const r = await call('plan.targeted', {
                    source_plan_id: planId,
                    points: pts,
                    episodes: targeted.episodes,
                    spread_mm: targeted.spread,
                    notes: targeted.notes,
                    instruction: targeted.instruction || null,
                    origin: { run_id: runId, step: Number(step), trials: failures.map((f) => f.id) },
                  });
                  toast.success(`Draft plan "${r.plan.task.name}" created — review and approve it in Planning`);
                  setTargeted(null);
                  dispatch(setEditingPlanId(r.plan.id));
                  dispatch(moveToPage(PageType.PLANNING));
                } catch (e) {
                  toast.error(e.message);
                }
              }}
            >
              Create draft plan
            </button>
          </>
        }
      >
        {targeted && plan && (
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="grid gap-3 content-start">
              <div className="label">Failure areas (from {failures.length} failed trials)</div>
              {targeted.clusters.map((c, i) => (
                <label key={i} className="flex items-center gap-2 rounded-xl bg-paper px-3 py-2 text-[12.5px]">
                  <input
                    type="checkbox"
                    checked={c.on}
                    onChange={() =>
                      setTargeted({ ...targeted, clusters: targeted.clusters.map((k, j) => (j === i ? { ...k, on: !k.on } : k)) })
                    }
                  />
                  <span className="num">
                    x {Math.round(c.x_mm)} · y {Math.round(c.y_mm)}
                  </span>
                  <span className="ml-auto text-ink-3">
                    {c.members.length} failure{c.members.length > 1 ? 's' : ''}
                  </span>
                </label>
              ))}
              {targeted.extra.map((p, i) => (
                <div key={`e${i}`} className="flex items-center gap-2 rounded-xl bg-sky-50 px-3 py-2 text-[12.5px]">
                  <span className="num">
                    x {p.x_mm} · y {p.y_mm}
                  </span>
                  <span className="text-ink-3">added by you</span>
                  <button
                    className="ml-auto btn-ghost btn-sm !px-2"
                    onClick={() => setTargeted({ ...targeted, extra: targeted.extra.filter((_, j) => j !== i) })}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Episodes">
                  <NumberInput
                    value={targeted.episodes}
                    min={1}
                    max={200}
                    onChange={(v) => setTargeted({ ...targeted, episodes: v })}
                  />
                </Field>
                <Field label="Spread around each point" hint="mm">
                  <NumberInput
                    value={targeted.spread}
                    min={0}
                    max={200}
                    onChange={(v) => setTargeted({ ...targeted, spread: v })}
                  />
                </Field>
              </div>
              <Field label="Instruction (optional)" hint="Leave empty to keep the plan's instruction">
                <TextInput value={targeted.instruction} onChange={(v) => setTargeted({ ...targeted, instruction: v })} />
              </Field>
              <Field label="Note for the operator">
                <TextInput
                  value={targeted.notes}
                  onChange={(v) => setTargeted({ ...targeted, notes: v })}
                  placeholder="e.g. approach slowly, centre the gripper"
                />
              </Field>
              <p className="text-[11.5px] text-ink-3">
                Copies task, targets and settings from plan “{plan.task.name}”; only the object position is targeted. The new plan
                is a draft — validate and approve it in Planning before recording.
              </p>
            </div>
            <WorkspaceCanvas
              workspace={plan.task.workspace}
              regions={plan.task.regions}
              items={plan.task.items}
              height={340}
              dots={[
                ...failures.map((t) => ({ x_mm: t.object.x_mm, y_mm: t.object.y_mm, color: OUTCOME_COLOR[t.outcome], r: 4 })),
                ...targeted.clusters
                  .filter((c) => c.on)
                  .map((c) => ({ x_mm: c.x_mm, y_mm: c.y_mm, color: '#2457E6', ring: true, r_mm: targeted.spread || 0 })),
                ...targeted.extra.map((p) => ({ ...p, color: '#2457E6', ring: true, r_mm: targeted.spread || 0 })),
              ]}
              onPick={(x, y) => setTargeted({ ...targeted, extra: [...targeted.extra, { x_mm: x, y_mm: y }] })}
              caption="Click to add a position"
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
