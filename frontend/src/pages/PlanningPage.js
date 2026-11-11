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

// Planning session: define task -> planning type -> configure -> generate ->
// review & edit -> validate -> approve. Every action is persisted on the server
// through /planning/command; nothing here is UI-only.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { usePlanningService } from '../hooks/usePlanningService';
import { useRosServiceCaller } from '../hooks/useRosServiceCaller';
import { setEditingPlanId, setRecordMode } from '../features/planning/planningSlice';
import { moveToPage } from '../features/ui/uiSlice';
import PageType from '../constants/pageType';
import WorkspaceCanvas from '../features/planning/WorkspaceCanvas';
import StrategyConfig, { combinationCount } from '../features/planning/StrategyConfig';
import {
  ItemsEditor,
  SequenceBuilder,
  STRATEGIES,
  StrategyPicker,
  WorkspaceEditor,
  PERTURBATION_LABELS,
} from '../features/planning/editors';
import {
  Callout,
  Empty,
  Field,
  Modal,
  NumberInput,
  Select,
  Sheet,
  Spinner,
  Stat,
  TextInput,
} from '../components/ui';

const STAGES = [
  { id: 'define', label: 'Define task' },
  { id: 'strategy', label: 'Planning type' },
  { id: 'configure', label: 'Configure' },
  { id: 'plan', label: 'Plan & edit' },
  { id: 'validate', label: 'Validate & approve' },
];

const DEMO_TYPES = ['standard', 'variation', 'recovery', 'failure', 'slow', 'fast'];

const STATUS_CHIP = {
  draft: 'chip',
  validated: 'chip-sky',
  approved: 'chip-ok',
  archived: 'chip',
};

function useDebounced(fn, delay) {
  const t = useRef(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const cancel = useCallback(() => t.current && clearTimeout(t.current), []);
  const run = useCallback(
    (...args) => {
      cancel();
      t.current = setTimeout(() => fnRef.current(...args), delay);
    },
    [delay, cancel]
  );
  useEffect(() => cancel, [cancel]);
  return [run, cancel];
}

export default function PlanningPage() {
  const dispatch = useDispatch();
  const { call } = usePlanningService();
  const { getRegisteredHFUser } = useRosServiceCaller();
  const robotType = useSelector((s) => s.tasks.taskStatus.robotType);
  const editingPlanId = useSelector((s) => s.planning.editingPlanId);

  const [plans, setPlans] = useState(null);
  const [activePlanId, setActivePlanId] = useState(null);
  const [doc, setDoc] = useState(null); // {plan, summary, versions, progress, events}
  const [draft, setDraft] = useState(null); // {task, strategy, allow_skip}
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState('');
  const [stage, setStage] = useState('define');
  const [selected, setSelected] = useState(null);
  const [focusItem, setFocusItem] = useState(null);
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [showArchived, setShowArchived] = useState(false);

  const plan = doc?.plan;
  const locked = plan?.status === 'archived';

  // ---------------------------------------------------------------- data --
  const loadList = useCallback(async () => {
    try {
      const res = await call('plan.list', { include_archived: showArchived });
      setPlans(res.plans);
      setActivePlanId(res.active_plan_id);
      setError('');
    } catch (e) {
      setError(e.message);
      setPlans([]);
    }
  }, [call, showArchived]);

  const applyDoc = useCallback((d) => {
    setDoc(d);
    setDraft({ task: d.plan.task, strategy: d.plan.strategy, allow_skip: d.plan.allow_skip });
    setDirty(false);
  }, []);

  const open = useCallback(
    async (id) => {
      if (!id) return;
      try {
        const d = await call('plan.get', { plan_id: id });
        applyDoc(d);
        dispatch(setEditingPlanId(id));
        setSelected(d.plan.episodes?.[0]?.id || null);
        setStage(d.plan.episodes?.length ? 'plan' : 'define');
      } catch (e) {
        toast.error(e.message);
        dispatch(setEditingPlanId(null));
      }
    },
    [call, applyDoc, dispatch]
  );

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (editingPlanId && !doc) open(editingPlanId);
  }, [editingPlanId, doc, open]);

  useEffect(() => {
    getRegisteredHFUser()
      .then((r) => setUsers((r && r.user_id_list) || []))
      .catch(() => setUsers([]));
  }, [getRegisteredHFUser]);

  // ---------------------------------------------------------------- save --
  const save = useCallback(
    async (d = draft) => {
      if (!plan || !d) return null;
      setSaving(true);
      try {
        const res = await call('plan.save', { plan: { id: plan.id, ...d } });
        setDoc(res);
        setDirty(false);
        loadList();
        return res;
      } catch (e) {
        toast.error(`Save failed: ${e.message}`);
        return null;
      } finally {
        setSaving(false);
      }
    },
    [call, plan, draft, loadList]
  );
  const [saveSoon, cancelSave] = useDebounced(save, 900);

  const edit = (patch) => {
    if (locked) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    setDirty(true);
    saveSoon(next);
  };
  const editTask = (patch) => edit({ task: { ...draft.task, ...patch } });

  const flush = async () => {
    cancelSave();
    if (dirty) return save();
    return doc;
  };

  const run = async (label, fn) => {
    setBusy(label);
    try {
      await flush();
      const res = await fn();
      if (res && res.plan) {
        if (res.plan.id !== plan?.id) dispatch(setEditingPlanId(res.plan.id));
        setDoc(res);
        setDraft({ task: res.plan.task, strategy: res.plan.strategy, allow_skip: res.plan.allow_skip });
        setDirty(false);
      }
      loadList();
      return res;
    } catch (e) {
      toast.error(e.message);
      return null;
    } finally {
      setBusy('');
    }
  };

  // ------------------------------------------------------------- actions --
  const newPlan = async () => {
    setBusy('new');
    try {
      const res = await call('plan.new', {
        robot_type: robotType,
        user_id: users[0] || '',
        strategy_type: 'dynamic',
      });
      applyDoc(res);
      dispatch(setEditingPlanId(res.plan.id));
      setStage('define');
      setSelected(null);
      loadList();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };

  const changeStrategy = async (type) => {
    if (type === draft.strategy.type) {
      setStage('configure');
      return;
    }
    try {
      const res = await call('plan.defaults', { strategy_type: type, task: draft.task });
      edit({ strategy: { ...draft.strategy, type, params: res.params } });
      setStage('configure');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const generate = (keepEdited) =>
    run('generate', async () => {
      const res = await call('plan.generate', { plan_id: plan.id, keep_edited: keepEdited });
      setSelected(res.plan.episodes[0]?.id || null);
      setStage('plan');
      const v = res.plan.validation;
      if (v && v.errors) toast.error(`${res.plan.episodes.length} episodes generated · ${v.errors} issue(s) to fix`);
      else toast.success(`${res.plan.episodes.length} episodes generated`);
      return res;
    });

  const validate = () =>
    run('validate', async () => {
      const res = await call('plan.validate', { plan_id: plan.id });
      setStage('validate');
      return res;
    });

  const applyFix = (fix) => run('fix', () => call('plan.apply_fix', { plan_id: plan.id, fix }));

  const approve = () =>
    run('approve', async () => {
      const res = await call('plan.approve', { plan_id: plan.id });
      toast.success(`Version ${res.plan.version} approved — ready for Record`);
      return res;
    });

  const updateEpisode = (episodeId, patch) =>
    run('episode', () => call('plan.update_episode', { plan_id: plan.id, episode_id: episodeId, patch }));

  const goRecord = async () => {
    try {
      await call('plan.set_active', { plan_id: plan.id });
      dispatch(setRecordMode('plan'));
      dispatch(moveToPage(PageType.RECORD));
    } catch (e) {
      toast.error(e.message);
    }
  };

  // ------------------------------------------------------------- derived --
  const episodes = useMemo(() => plan?.episodes || [], [plan]);
  const selectedEp = episodes.find((e) => e.id === selected) || null;
  const [dragPlacements, setDragPlacements] = useState(null);
  useEffect(() => setDragPlacements(null), [selected, plan]);

  const issuesByEpisode = useMemo(() => {
    const m = {};
    (plan?.validation?.issues || []).forEach((i) => {
      if (i.episode_id) {
        m[i.episode_id] = m[i.episode_id] || { error: 0, warning: 0 };
        if (i.severity in m[i.episode_id]) m[i.episode_id][i.severity] += 1;
      }
    });
    return m;
  }, [plan]);

  // collection-order preview
  useEffect(() => {
    if (!previewing || !episodes.length) return undefined;
    let k = Math.max(0, episodes.findIndex((e) => e.id === selected));
    const id = setInterval(() => {
      k += 1;
      if (k >= episodes.length) {
        setPreviewing(false);
        return;
      }
      setSelected(episodes[k].id);
    }, 650);
    return () => clearInterval(id);
  }, [previewing, episodes]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- views --
  if (plans === null) {
    return (
      <div className="h-full grid place-items-center bp-grid">
        <Spinner />
      </div>
    );
  }

  const staleNote = plan && plan.status === 'draft' && plan.approved_version;

  return (
    <div className="h-full flex min-h-0 bp-grid">
      {/* plan library */}
      <aside className="w-[260px] shrink-0 border-r border-ink bg-white flex flex-col min-h-0">
        <div className="sheet-head">
          <div>
            <div className="label">Sheet 02</div>
            <div className="sheet-title">Collection plans</div>
          </div>
          <button className="btn-primary btn-sm" onClick={newPlan} disabled={!!busy || !!error}>
            + New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin">
          {error && (
            <div className="p-3">
              <Callout tone="err" title="Planning service unavailable">
                {error}
              </Callout>
            </div>
          )}
          {plans.map((p) => (
            <button
              key={p.id}
              onClick={async () => {
                await flush();
                open(p.id);
              }}
              className={clsx(
                'w-full text-left px-3 py-2.5 border-b border-rule transition-colors',
                plan?.id === p.id ? 'bg-sky-50' : 'hover:bg-paper'
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-[13px] truncate">{p.name || 'Untitled plan'}</span>
                <span className={STATUS_CHIP[p.status] || 'chip'}>{p.status}</span>
              </div>
              <div className="flex items-center gap-2 mt-1 text-[11.5px] text-ink-3">
                <span>{STRATEGIES.find((s) => s.type === p.strategy)?.title}</span>
                <span>·</span>
                <span className="num">{p.episodes} ep</span>
                <span>·</span>
                <span className="num">v{p.version}</span>
                {p.id === activePlanId && <span className="chip-ink ml-auto">REC</span>}
              </div>
              {p.progress?.total > 0 && p.approved_version && (
                <div className="mt-1.5 h-1 bg-paper-3">
                  <div className="h-1 bg-signal-ok" style={{ width: `${(p.progress.done / p.progress.total) * 100}%` }} />
                </div>
              )}
            </button>
          ))}
          {!plans.length && !error && (
            <div className="p-4 text-[12.5px] text-ink-3">No plans yet. Create one to start.</div>
          )}
        </div>
        <label className="flex items-center gap-2 border-t border-rule px-3 py-2 text-[12px] text-ink-3">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </aside>

      {/* editor */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {!plan || !draft ? (
          <div className="flex-1 grid place-items-center p-8">
            <Empty
              title="No plan open"
              action={
                <button className="btn-primary" onClick={newPlan} disabled={!!busy || !!error}>
                  Create a collection plan
                </button>
              }
            >
              A plan decides, episode by episode, where objects and targets go, which scenario is
              demonstrated and what the instruction is. Record then follows it.
            </Empty>
          </div>
        ) : (
          <>
            {/* title block + stepper */}
            <header className="bg-white border-b border-ink">
              <div className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="label">Plan</span>
                    <span className="label text-ink-4 num">{plan.id}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <h1 className="text-[20px] font-semibold tracking-tight truncate">
                      {draft.task.name || 'Untitled plan'}
                    </h1>
                    <span className={STATUS_CHIP[plan.status] || 'chip'}>
                      {plan.status} · v{plan.version}
                    </span>
                    <span className="text-[11.5px] text-ink-3">
                      {saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="btn btn-sm" onClick={() => run('dup', () => call('plan.duplicate', { plan_id: plan.id }))} disabled={!!busy}>
                    Duplicate
                  </button>
                  {plan.status !== 'archived' && (
                    <button
                      className="btn btn-sm"
                      disabled={!!busy}
                      onClick={() =>
                        setConfirm({
                          title: 'Archive plan?',
                          body: 'Archived plans are hidden and read-only. Recorded data is not touched.',
                          action: async () => {
                            await call('plan.archive', { plan_id: plan.id });
                            setDoc(null);
                            setDraft(null);
                            dispatch(setEditingPlanId(null));
                            loadList();
                          },
                        })
                      }
                    >
                      Archive
                    </button>
                  )}
                  {plan.approved_version && (
                    <button className="btn-sky btn-sm" onClick={goRecord}>
                      Record v{plan.approved_version} →
                    </button>
                  )}
                </div>
              </div>
              <nav className="flex overflow-x-auto border-t border-rule" aria-label="Planning steps">
                {STAGES.map((s, i) => {
                  const on = s.id === stage;
                  const reached =
                    s.id === 'plan' || s.id === 'validate' ? episodes.length > 0 : true;
                  return (
                    <button
                      key={s.id}
                      onClick={() => setStage(s.id)}
                      disabled={!reached}
                      className={clsx(
                        'flex items-center gap-2 px-4 py-2 text-[12.5px] border-r border-rule whitespace-nowrap disabled:text-ink-4',
                        on ? 'bg-ink text-paper' : 'hover:bg-paper'
                      )}
                    >
                      <span className={clsx('num text-[10.5px]', on ? 'text-sky' : 'text-ink-4')}>{String(i + 1).padStart(2, '0')}</span>
                      {s.label}
                    </button>
                  );
                })}
                <div className="flex-1" />
                <div className="flex items-center gap-2 px-3">
                  <button className="btn-primary btn-sm" onClick={() => generate(false)} disabled={!!busy || locked}>
                    {busy === 'generate' && <Spinner className="border-paper border-t-transparent" />}
                    {episodes.length ? 'Regenerate plan' : 'Generate plan'}
                  </button>
                </div>
              </nav>
            </header>

            <div className="flex-1 overflow-y-auto overflow-x-hidden scroll-thin p-5">
              {staleNote && (
                <Callout tone="info" className="mb-4" title={`Editing draft v${plan.version}`}>
                  Record keeps using approved v{plan.approved_version} until you approve this version.
                </Callout>
              )}
              {locked && (
                <Callout tone="warn" className="mb-4" title="Archived plan">
                  Read-only. Duplicate it to make changes.
                </Callout>
              )}

              {stage === 'define' && (
                <DefineStage
                  draft={draft}
                  users={users}
                  robotType={robotType}
                  editTask={editTask}
                  edit={edit}
                  disabled={locked}
                  call={call}
                />
              )}

              {stage === 'strategy' && (
                <Sheet title="Planning type" code="B">
                  <StrategyPicker value={draft.strategy.type} onChange={changeStrategy} disabled={locked} />
                  <p className="mt-3 text-[12.5px] text-ink-3">
                    {STRATEGIES.find((s) => s.type === draft.strategy.type)?.detail}
                  </p>
                </Sheet>
              )}

              {stage === 'configure' && (
                <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_520px]">
                  <Sheet
                    title={`Configure · ${STRATEGIES.find((s) => s.type === draft.strategy.type)?.title}`}
                    code="C"
                    actions={
                      <button className="btn btn-sm" onClick={() => setStage('strategy')}>
                        Change type
                      </button>
                    }
                  >
                    <StrategyConfig task={draft.task} strategy={draft.strategy} disabled={locked} onChange={(s) => edit({ strategy: s })} />
                  </Sheet>
                  <ConfigMap draft={draft} edit={edit} focusItem={focusItem} setFocusItem={setFocusItem} disabled={locked} />
                </div>
              )}

              {stage === 'plan' && (
                <PlanStage
                  plan={plan}
                  draft={draft}
                  summary={doc.summary}
                  episodes={episodes}
                  selected={selected}
                  setSelected={setSelected}
                  selectedEp={selectedEp}
                  dragPlacements={dragPlacements}
                  setDragPlacements={setDragPlacements}
                  updateEpisode={updateEpisode}
                  issuesByEpisode={issuesByEpisode}
                  previewing={previewing}
                  setPreviewing={setPreviewing}
                  busy={busy}
                  locked={locked}
                  onAdd={() => run('add', () => call('plan.add_episode', { plan_id: plan.id, copy_from: selected }))}
                  onRemove={() =>
                    selected &&
                    run('remove', async () => {
                      const res = await call('plan.remove_episode', { plan_id: plan.id, episode_id: selected });
                      setSelected(res.plan.episodes[0]?.id || null);
                      return res;
                    })
                  }
                  onMove={(d) => {
                    const ids = episodes.map((e) => e.id);
                    const i = ids.indexOf(selected);
                    const j = i + d;
                    if (i < 0 || j < 0 || j >= ids.length) return;
                    [ids[i], ids[j]] = [ids[j], ids[i]];
                    run('reorder', () => call('plan.reorder', { plan_id: plan.id, order: ids }));
                  }}
                  onRegenerateKeep={() => generate(true)}
                  onValidate={validate}
                />
              )}

              {stage === 'validate' && (
                <ValidateStage
                  plan={plan}
                  busy={busy}
                  locked={locked}
                  onValidate={validate}
                  onFix={applyFix}
                  onApprove={approve}
                  onSelectEpisode={(id) => {
                    setSelected(id);
                    setStage('plan');
                  }}
                  onRecord={goRecord}
                  events={doc.events}
                />
              )}
            </div>
          </>
        )}
      </div>

      <Modal
        open={!!confirm}
        title={confirm?.title}
        onClose={() => setConfirm(null)}
        footer={
          <>
            <button className="btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={async () => {
                try {
                  await confirm.action();
                } catch (e) {
                  toast.error(e.message);
                }
                setConfirm(null);
              }}
            >
              Confirm
            </button>
          </>
        }
      >
        <p className="text-[13px]">{confirm?.body}</p>
      </Modal>
    </div>
  );
}

// ------------------------------------------------------------ stage: define --
function DefineStage({ draft, users, robotType, editTask, edit, disabled, call }) {
  const t = draft.task;
  const rec = t.recording || {};
  const setRec = (patch) => editTask({ recording: { ...rec, ...patch } });
  const datasetPath = t.user_id && t.name ? `${t.user_id}/${t.robot_type}_${t.name}` : '—';
  const preview = (t.instruction || '')
    .replace('{object}', t.items.find((i) => i.role === 'object')?.name || 'object')
    .replace('{target}', t.items.find((i) => i.role === 'target')?.name || 'target')
    .replace('{object_region}', 'left')
    .replace('{target_region}', 'right');
  const resetWorkspace = async () => {
    try {
      const prof = await call('robot.profile', { robot_type: t.robot_type });
      editTask({ workspace: prof.workspace, regions: prof.regions });
      toast.success(`Workspace reset to ${prof.profile.label} defaults`);
    } catch (e) {
      toast.error(e.message);
    }
  };
  return (
    <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_520px]">
      <div className="grid gap-4 grid-cols-[minmax(0,1fr)]">
        <Sheet title="Task" code="A1">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Task name" hint={`Dataset folder: ${datasetPath}`}>
              <TextInput value={t.name} placeholder="red_cube_pick_place" disabled={disabled} onChange={(v) => editTask({ name: v })} />
            </Field>
            <Field label="Dataset owner (HF user)" hint="Registered Hugging Face users, or type a local owner name.">
              <div className="flex gap-2">
                <TextInput value={t.user_id} disabled={disabled} onChange={(v) => editTask({ user_id: v })} list="pam-users" />
                <datalist id="pam-users">
                  {users.map((u) => (
                    <option key={u} value={u} />
                  ))}
                </datalist>
              </div>
            </Field>
            <Field
              label="Task instruction"
              className="md:col-span-2"
              hint={
                <>
                  Stored with every episode. Tokens: <code>{'{object}'}</code> <code>{'{target}'}</code>{' '}
                  <code>{'{object_region}'}</code> <code>{'{target_region}'}</code>
                  {preview && <span className="block mt-0.5 text-ink-2">Preview: “{preview}”</span>}
                </>
              }
            >
              <TextInput
                value={t.instruction}
                disabled={disabled}
                placeholder="Pick up the {object} and place it in the {target}."
                onChange={(v) => editTask({ instruction: v })}
              />
            </Field>
            <Field label="Description" className="md:col-span-2">
              <textarea
                className="input min-h-[60px]"
                value={t.description || ''}
                disabled={disabled}
                onChange={(e) => editTask({ description: e.target.value })}
              />
            </Field>
            <Field label="Robot type" hint={t.robot_type !== robotType ? `Server robot is ${robotType || 'not set'}.` : 'Matches the selected robot.'}>
              <TextInput value={t.robot_type} disabled />
            </Field>
            <Field label="Total episodes">
              <NumberInput value={t.episode_count} min={1} max={2000} disabled={disabled} onChange={(v) => editTask({ episode_count: v })} />
            </Field>
            <Field label="Demonstration types" className="md:col-span-2">
              <div className="flex flex-wrap gap-1.5">
                {DEMO_TYPES.map((d) => {
                  const on = (t.demo_types || []).includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      disabled={disabled}
                      aria-pressed={on}
                      className={on ? 'chip-ink' : 'chip'}
                      onClick={() =>
                        editTask({
                          demo_types: on ? t.demo_types.filter((x) => x !== d) : [...(t.demo_types || []), d],
                        })
                      }
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            </Field>
          </div>
        </Sheet>
        <Sheet title="Objects and targets" code="A2">
          <ItemsEditor items={t.items} disabled={disabled} onChange={(items) => editTask({ items })} />
        </Sheet>
        <Sheet title="Recording settings (per episode)" code="A3">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Field label="FPS">
              <NumberInput value={rec.fps} min={1} max={60} disabled={disabled} onChange={(v) => setRec({ fps: v })} />
            </Field>
            <Field label="Warm-up">
              <NumberInput value={rec.warmup_s} suffix="s" disabled={disabled} onChange={(v) => setRec({ warmup_s: v })} />
            </Field>
            <Field label="Episode time">
              <NumberInput value={rec.episode_s} suffix="s" disabled={disabled} onChange={(v) => setRec({ episode_s: v })} />
            </Field>
            <Field label="Optimized save">
              <Select
                value={rec.use_optimized_save === false ? 'no' : 'yes'}
                disabled={disabled}
                onChange={(v) => setRec({ use_optimized_save: v === 'yes' })}
                options={[
                  { value: 'yes', label: 'On' },
                  { value: 'no', label: 'Off' },
                ]}
              />
            </Field>
            <Field label="Allow skipping">
              <Select
                value={draft.allow_skip === false ? 'no' : 'yes'}
                disabled={disabled}
                onChange={(v) => edit({ allow_skip: v === 'yes' })}
                options={[
                  { value: 'yes', label: 'With reason' },
                  { value: 'no', label: 'Never' },
                ]}
              />
            </Field>
          </div>
          <p className="mt-2 text-[12px] text-ink-3">
            Each planned episode is recorded as its own take (one episode per Start), so there is no reset timer — you
            set up the next episode at your own pace.
          </p>
        </Sheet>
      </div>
      <Sheet
        title="Workspace"
        code="A4"
        actions={
          <button className="btn btn-sm" onClick={resetWorkspace} disabled={disabled}>
            Robot defaults
          </button>
        }
      >
        <WorkspaceCanvas workspace={t.workspace} regions={t.regions} items={t.items} height={320} caption="Hatched: unreachable or keep-out." />
        <div className="mt-4">
          <WorkspaceEditor
            workspace={t.workspace}
            regions={t.regions}
            disabled={disabled}
            onChange={(ws) => editTask({ workspace: ws })}
            onRegionsChange={(regions) => editTask({ regions })}
          />
        </div>
      </Sheet>
    </div>
  );
}

// --------------------------------------------------- stage: configure map --
function ConfigMap({ draft, edit, focusItem, setFocusItem, disabled }) {
  const t = draft.task;
  const params = draft.strategy.params || {};
  const items = t.items || [];
  const focus = items.find((i) => i.id === focusItem) || items[0];
  const spec = focus ? params.items?.[focus.id] : null;
  const fixedMarkers = items
    .filter((it) => params.items?.[it.id]?.mode === 'fixed')
    .map((it) => {
      const f = params.items[it.id].fixed || {};
      return { item_id: it.id, x_mm: f.x_mm, y_mm: f.y_mm, yaw_deg: f.yaw_deg || params.items[it.id].yaw?.value || 0 };
    });
  const bounds = items
    .filter((it) => params.items?.[it.id]?.mode === 'random')
    .map((it) => ({ item_id: it.id, ...(params.items[it.id].bounds || t.workspace) }));
  const setSpec = (id, patch) =>
    edit({
      strategy: {
        ...draft.strategy,
        params: { ...params, items: { ...params.items, [id]: { ...params.items[id], ...patch } } },
      },
    });
  const combos = combinationCount(t, params);
  return (
    <Sheet title="Workspace map" code="C2" className="self-start 2xl:sticky 2xl:top-0">
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        <span className="label mr-1">Item</span>
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            className={focus?.id === it.id ? 'chip-ink' : 'chip'}
            onClick={() => setFocusItem(it.id)}
          >
            {it.name}
          </button>
        ))}
      </div>
      <WorkspaceCanvas
        workspace={t.workspace}
        regions={t.regions}
        items={items}
        placements={fixedMarkers}
        bounds={bounds}
        highlightRegions={spec?.mode === 'regions' ? spec.regions || [] : []}
        onRegionClick={
          !disabled && spec?.mode === 'regions'
            ? (rid) => {
                const on = (spec.regions || []).includes(rid);
                setSpec(focus.id, { regions: on ? spec.regions.filter((x) => x !== rid) : [...(spec.regions || []), rid] });
              }
            : undefined
        }
        onMove={
          disabled
            ? undefined
            : (id, x, y) => {
                const s = params.items[id];
                setSpec(id, { fixed: { ...(s.fixed || {}), x_mm: x, y_mm: y } });
              }
        }
        height={380}
        caption={
          spec?.mode === 'regions'
            ? `Click regions to toggle them for ${focus.name}.`
            : spec?.mode === 'fixed'
            ? 'Drag markers to set fixed positions.'
            : spec?.mode === 'random'
            ? 'Dashed rectangles: randomisation bounds.'
            : ''
        }
      />
      {draft.strategy.type === 'dynamic' && (
        <p className="mt-2 text-[12px] text-ink-3">
          {combos} combinations for {t.episode_count} episodes →{' '}
          {combos > t.episode_count
            ? 'not every combination will be demonstrated.'
            : `each about ${Math.floor(t.episode_count / combos)}–${Math.ceil(t.episode_count / combos)}×.`}
        </p>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------ stage: plan ---
function PlanStage({
  plan,
  draft,
  summary,
  episodes,
  selected,
  setSelected,
  selectedEp,
  dragPlacements,
  setDragPlacements,
  updateEpisode,
  issuesByEpisode,
  previewing,
  setPreviewing,
  busy,
  locked,
  onAdd,
  onRemove,
  onMove,
  onRegenerateKeep,
  onValidate,
}) {
  const t = plan.task;
  const items = t.items || [];
  const names = Object.fromEntries(items.map((i) => [i.id, i.name]));
  const ghosts = episodes.filter((e) => e.id !== selected).map((e) => ({ id: e.id, placements: e.placements }));
  const placements = dragPlacements || selectedEp?.placements || [];
  const v = plan.validation;
  const scen = summary?.by_scenario || {};
  const scenTotal = Object.values(scen).reduce((a, b) => a + b, 0) || 1;

  return (
    <div className="grid gap-4 grid-cols-[minmax(0,1fr)]">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
        <Stat label="Episodes" value={episodes.length} sub={`target ${t.episode_count}`} />
        <Stat label="Distinct setups" value={summary?.distinct_setups ?? '—'} />
        <Stat label="Edited by hand" value={summary?.edited ?? 0} tone={summary?.edited ? 'sky' : undefined} />
        <Stat
          label="Obj–target dist."
          value={summary?.object_target_distance_mm ? `${summary.object_target_distance_mm.min}–${summary.object_target_distance_mm.max}` : '—'}
          sub="mm"
        />
        <Stat label="Errors" value={v ? v.errors : '—'} tone={v && v.errors ? 'err' : v ? 'ok' : undefined} />
        <Stat label="Warnings" value={v ? v.warnings : '—'} tone={v && v.warnings ? 'warn' : undefined} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Sheet
          title={selectedEp ? `Episode ${selectedEp.order} · ${selectedEp.id}` : 'Workspace'}
          code="D1"
          actions={
            <button className="btn btn-sm" onClick={() => setPreviewing(!previewing)} disabled={!episodes.length}>
              {previewing ? '■ Stop preview' : '▶ Preview order'}
            </button>
          }
        >
          <WorkspaceCanvas
            workspace={t.workspace}
            regions={t.regions}
            items={items}
            placements={placements}
            ghosts={ghosts}
            height={400}
            onMove={
              locked || !selectedEp
                ? undefined
                : (id, x, y, done) => {
                    const next = (dragPlacements || selectedEp.placements).map((p) =>
                      p.item_id === id ? { ...p, x_mm: x, y_mm: y } : p
                    );
                    setDragPlacements(next);
                    if (done) updateEpisode(selectedEp.id, { placements: next });
                  }
            }
            caption="Faint markers: all other episodes. Drag to edit this episode only."
          />
          {Object.keys(scen).length > 1 && (
            <div className="mt-3">
              <div className="label mb-1">Scenario distribution</div>
              <div className="flex h-3 border border-ink">
                {Object.entries(scen).map(([k, n], i) => (
                  <div
                    key={k}
                    title={`${k}: ${n}`}
                    className={clsx('h-full border-r border-ink last:border-r-0', ['bg-ink', 'bg-sky', 'bg-signal-warn', 'bg-signal-err', 'bg-paper-3'][i % 5])}
                    style={{ width: `${(n / scenTotal) * 100}%` }}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-3 mt-1 text-[11.5px] text-ink-3">
                {Object.entries(scen).map(([k, n]) => (
                  <span key={k} className="num">
                    {k}: {n}
                  </span>
                ))}
              </div>
            </div>
          )}
        </Sheet>

        {selectedEp ? (
          <EpisodeEditor
            key={selectedEp.id + plan.version + (selectedEp.edited ? 'e' : '')}
            episode={selectedEp}
            items={items}
            names={names}
            locked={locked}
            onSave={(patch) => updateEpisode(selectedEp.id, patch)}
          />
        ) : (
          <Empty title="Select an episode" />
        )}
      </div>

      <Sheet
        title="Collection order"
        code="D2"
        bodyClassName="p-0"
        actions={
          <div className="flex flex-wrap gap-1.5">
            <button className="btn btn-sm" onClick={() => onMove(-1)} disabled={!selected || !!busy || locked}>
              ↑ Earlier
            </button>
            <button className="btn btn-sm" onClick={() => onMove(1)} disabled={!selected || !!busy || locked}>
              ↓ Later
            </button>
            <button className="btn btn-sm" onClick={onAdd} disabled={!!busy || locked}>
              + Duplicate
            </button>
            <button className="btn btn-sm" onClick={onRemove} disabled={!selected || !!busy || locked}>
              Remove
            </button>
            <button className="btn btn-sm" onClick={onRegenerateKeep} disabled={!!busy || locked} title="Regenerate, keeping episodes you edited by hand">
              Regenerate (keep edits)
            </button>
            <button className="btn-primary btn-sm" onClick={onValidate} disabled={!!busy}>
              {busy === 'validate' && <Spinner className="border-paper border-t-transparent" />}
              Validate →
            </button>
          </div>
        }
      >
        <div className="max-h-[360px] overflow-auto scroll-thin">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-paper-2 z-10">
              <tr className="text-left">
                {['#', 'Id', ...items.map((i) => i.name), 'Scenario', 'Instruction', ''].map((h, k) => (
                  <th key={`${h}${k}`} className="label font-normal px-3 py-1.5 whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {episodes.map((e) => {
                const iss = issuesByEpisode[e.id];
                return (
                  <tr
                    key={e.id}
                    onClick={() => setSelected(e.id)}
                    className={clsx(
                      'border-t border-rule cursor-pointer',
                      e.id === selected ? 'bg-sky-50' : 'hover:bg-paper'
                    )}
                  >
                    <td className="px-3 py-1.5 num text-ink-3">{e.order}</td>
                    <td className="px-3 py-1.5 num">{e.id}</td>
                    {items.map((it) => {
                      const p = e.placements.find((q) => q.item_id === it.id);
                      return (
                        <td key={it.id} className="px-3 py-1.5 num whitespace-nowrap">
                          {p ? (
                            <>
                              <span className="chip mr-1">{p.region || '–'}</span>
                              {Math.round(p.x_mm)},{Math.round(p.y_mm)}
                              {p.yaw_deg ? ` · ${p.yaw_deg}°` : ''}
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                      );
                    })}
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span className={e.scenario?.kind === 'success' ? 'chip' : e.scenario?.kind === 'failure' ? 'chip-err' : 'chip-warn'}>
                        {e.scenario?.name || 'Normal'}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 max-w-[280px] truncate" title={e.instruction}>
                      {e.instruction}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {e.edited && <span className="chip-sky mr-1">edited</span>}
                      {iss?.error > 0 && <span className="chip-err">{iss.error} err</span>}
                      {!iss?.error && iss?.warning > 0 && <span className="chip-warn">{iss.warning} warn</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Sheet>
    </div>
  );
}

function EpisodeEditor({ episode, items, names, locked, onSave }) {
  const [instruction, setInstruction] = useState(episode.instruction);
  const [placements, setPlacements] = useState(episode.placements);
  const [notes, setNotes] = useState(episode.operator_notes || '');
  const [sequence, setSequence] = useState(episode.sequence || []);
  const changed =
    instruction !== episode.instruction ||
    notes !== (episode.operator_notes || '') ||
    JSON.stringify(placements) !== JSON.stringify(episode.placements) ||
    JSON.stringify(sequence) !== JSON.stringify(episode.sequence || []);
  const setP = (id, k, v) => setPlacements(placements.map((p) => (p.item_id === id ? { ...p, [k]: v } : p)));
  return (
    <Sheet
      title="Episode configuration"
      code="D3"
      actions={
        <>
          {episode.edited && <span className="chip-sky">edited</span>}
          <span className={episode.scenario?.kind === 'success' ? 'chip' : 'chip-warn'}>{episode.scenario?.name}</span>
        </>
      }
    >
      <div className="grid gap-3 grid-cols-[minmax(0,1fr)]">
        <Field label="Instruction">
          <TextInput value={instruction} disabled={locked} onChange={setInstruction} />
        </Field>
        <div>
          <div className="label mb-1">Positions</div>
          <div className="grid gap-1.5">
            {placements.map((p) => (
              <div key={p.item_id} className="grid grid-cols-[110px_1fr_1fr_1fr] gap-2 items-center">
                <span className="text-[12.5px] truncate">{names[p.item_id] || p.item_id}</span>
                <NumberInput value={p.x_mm} suffix="x" disabled={locked} onChange={(v) => setP(p.item_id, 'x_mm', v)} />
                <NumberInput value={p.y_mm} suffix="y" disabled={locked} onChange={(v) => setP(p.item_id, 'y_mm', v)} />
                <NumberInput value={p.yaw_deg} suffix="°" disabled={locked} onChange={(v) => setP(p.item_id, 'yaw_deg', v)} />
              </div>
            ))}
          </div>
        </div>
        {episode.scenario?.perturbation && episode.scenario.perturbation !== 'none' && (
          <div className="text-[12px] text-ink-3">Condition: {PERTURBATION_LABELS[episode.scenario.perturbation]}</div>
        )}
        <Field label="Operator notes">
          <TextInput value={notes} disabled={locked} onChange={setNotes} />
        </Field>
        <div>
          <div className="label mb-1">Action sequence</div>
          <SequenceBuilder steps={sequence} items={items} disabled={locked} onChange={setSequence} />
        </div>
        <div className="flex justify-end gap-2">
          <button
            className="btn btn-sm"
            disabled={!changed}
            onClick={() => {
              setInstruction(episode.instruction);
              setPlacements(episode.placements);
              setNotes(episode.operator_notes || '');
              setSequence(episode.sequence || []);
            }}
          >
            Revert
          </button>
          <button
            className="btn-primary btn-sm"
            disabled={!changed || locked}
            onClick={() => onSave({ instruction, placements, operator_notes: notes, sequence })}
          >
            Save episode
          </button>
        </div>
        <p className="text-[11.5px] text-ink-3">Changes apply to this episode only.</p>
      </div>
    </Sheet>
  );
}

// -------------------------------------------------------- stage: validate ---
function ValidateStage({ plan, busy, locked, onValidate, onFix, onApprove, onSelectEpisode, onRecord, events }) {
  const v = plan.validation;
  const [limit, setLimit] = useState(40);
  const issues = v?.issues || [];
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity]);
  const approved = plan.status === 'approved';
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Sheet
        title="Validation"
        code="E1"
        actions={
          <button className="btn btn-sm" onClick={onValidate} disabled={!!busy}>
            {busy === 'validate' && <Spinner />}
            Run checks
          </button>
        }
      >
        {!v ? (
          <Empty title="Not validated yet" action={<button className="btn-primary" onClick={onValidate}>Run checks</button>}>
            Checks workspace bounds, reach, overlaps, completeness, distribution, coverage and sequence consistency.
          </Empty>
        ) : (
          <div className="grid gap-2 grid-cols-[minmax(0,1fr)]">
            <div className="flex flex-wrap gap-2 mb-1">
              <span className={v.errors ? 'chip-err' : 'chip-ok'}>{v.errors} errors</span>
              <span className={v.warnings ? 'chip-warn' : 'chip'}>{v.warnings} warnings</span>
              <span className="chip">{issues.filter((i) => i.severity === 'info').length} notes</span>
              {v.ran_at && <span className="text-[11.5px] text-ink-3 self-center">checked {new Date(v.ran_at).toLocaleString()}</span>}
            </div>
            {!issues.length && <Callout tone="ok" title="All checks passed" />}
            {sorted.slice(0, limit).map((i, k) => (
              <div
                key={k}
                className={clsx(
                  'flex items-start gap-3 border px-3 py-2',
                  i.severity === 'error' ? 'border-signal-err/40 bg-signal-errbg' : i.severity === 'warning' ? 'border-signal-warn/40 bg-signal-warnbg' : 'border-rule bg-white'
                )}
              >
                <span className="label pt-[2px] w-16 shrink-0">{i.severity}</span>
                <div className="flex-1 min-w-0 text-[12.5px]">
                  <div>{i.message}</div>
                  <div className="text-[11px] text-ink-3 num mt-0.5">
                    {i.code}
                    {i.episode_id && (
                      <>
                        {' · '}
                        <button className="underline" onClick={() => onSelectEpisode(i.episode_id)}>
                          {i.episode_id}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {i.fix && !locked && (
                  <button className="btn btn-sm shrink-0" onClick={() => onFix(i.fix)} disabled={!!busy}>
                    {i.fix.label}
                  </button>
                )}
              </div>
            ))}
            {sorted.length > limit && (
              <button className="btn btn-sm self-start" onClick={() => setLimit(limit + 60)}>
                Show {Math.min(60, sorted.length - limit)} more of {sorted.length - limit}
              </button>
            )}
          </div>
        )}
      </Sheet>
      <div className="grid gap-4 self-start">
        <Sheet title="Approval" code="E2">
          {approved ? (
            <div className="grid gap-3 grid-cols-[minmax(0,1fr)]">
              <div className="border-2 border-signal-ok text-signal-ok px-3 py-2 w-fit -rotate-2">
                <div className="font-mono text-[11px] tracking-widest">APPROVED</div>
                <div className="font-semibold">Version {plan.approved_version}</div>
                <div className="font-mono text-[10.5px]">{plan.approved_at && new Date(plan.approved_at).toLocaleString()}</div>
              </div>
              <p className="text-[12.5px] text-ink-3">
                This version is frozen. Record loads it episode by episode; editing creates a new draft version.
              </p>
              <button className="btn-sky" onClick={onRecord}>
                Proceed to recording →
              </button>
            </div>
          ) : (
            <div className="grid gap-3 grid-cols-[minmax(0,1fr)]">
              <p className="text-[12.5px] text-ink-3">
                Approving freezes version {plan.version} and makes it the input of the Record session.
                {v && v.warnings > 0 && ' Warnings do not block approval but are kept in the plan record.'}
              </p>
              <button className="btn-primary" disabled={!v || v.errors > 0 || !!busy || locked} onClick={onApprove}>
                {busy === 'approve' && <Spinner className="border-paper border-t-transparent" />}
                Approve version {plan.version}
              </button>
              {(!v || v.errors > 0) && <p className="text-[12px] text-signal-err">{!v ? 'Run checks first.' : 'Fix all errors to approve.'}</p>}
            </div>
          )}
        </Sheet>
        <Sheet title="History" code="E3" soft>
          <ul className="space-y-1 text-[12px] max-h-[220px] overflow-auto scroll-thin">
            {[...(events || [])].reverse().map((e, k) => (
              <li key={k} className="flex gap-2">
                <span className="num text-ink-3 shrink-0">{new Date(e.t).toLocaleTimeString()}</span>
                <span>
                  {e.event.replace(/_/g, ' ')}
                  {e.version ? ` v${e.version}` : ''}
                  {e.episode_id ? ` ${e.episode_id}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Sheet>
      </div>
    </div>
  );
}
