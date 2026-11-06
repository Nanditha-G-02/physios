// MODULE 2: Planning Studio. The planning engine (physical_ai_server/planning, behind
// /planning/command) does generation, validation and approval; this page edits and previews.
import { useEffect, useMemo, useState } from 'react';
import { planning, ros } from '@/api/gateway';
import { Link, useRouter } from '@/app/router';
import { useSystem } from '@/app/system';
import { BarChart } from '@/design/charts';
import { I } from '@/design/icons';
import {
  Badge, Button, Callout, Confirm, Empty, ErrorState, Field, Input, Loading, Modal, NumberInput, Panel,
  Select, StatusBadge, Switch, Tabs, TextArea, fmt, useToast,
} from '@/design/ui';
import { useLoad } from '@/hooks/data';
import { Page, Requires } from '../shared';
import { WorkspaceView } from './WorkspaceView';
import { SequenceEditor, StrategyEditor } from './StrategyEditor';

type Full = { plan: any; summary: any; versions: any[]; progress: any; events: any[]; dataset_id: string | null };

export default function PlanningStudio({ planId }: { planId?: string }) {
  return (
    <Page intro="Design how demonstrations are collected: what to manipulate, where things start, how episodes vary. The planning engine on the robot side generates, validates and versions every plan; recording uses only approved plans.">
      <Requires service="ros" what="The Planning Studio"><Studio planId={planId} /></Requires>
    </Page>
  );
}

function Studio({ planId }: { planId?: string }) {
  const { go } = useRouter();
  const [showArchived, setShowArchived] = useState(false);
  const list = useLoad(() => planning('plan.list', { include_archived: showArchived }), [showArchived], 15000);
  const meta = useLoad(() => planning('meta'), []);
  const [creating, setCreating] = useState(false);
  const plans: any[] = list.data?.plans || [];
  return (
    <div className="grid g-side-l">
      <Panel title="Plans" sub={`${plans.length} plan(s)`} flush actions={<Button size="sm" variant="primary" icon={<I.plus />} onClick={() => setCreating(true)} data-action="new-plan">New</Button>}>
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <div style={{ padding: 16 }}><Loading rows={4} /></div> : plans.length ? (
          <div className="list">{plans.map((p) => (
            <button key={p.id} className="list-item" aria-selected={p.id === planId} onClick={() => go(`/planning/${p.id}`)} data-plan={p.id}>
              <div className="grow">
                <div className="row-between"><b className="ellipsis" style={{ fontWeight: 600 }}>{p.name || p.id}</b><StatusBadge status={p.status} /></div>
                <div className="tiny muted">{p.strategy} · {p.episodes} ep · v{p.version}{p.id === list.data?.active_plan_id ? ' · active for recording' : ''}</div>
                {p.progress && (p.progress.validated + p.progress.recorded > 0) && <div className="progress" style={{ marginTop: 6 }}><span style={{ width: `${(100 * (p.progress.validated + p.progress.recorded)) / Math.max(1, p.episodes)}%` }} /></div>}
              </div>
            </button>
          ))}</div>
        ) : <Empty icon={<I.planning />} title="No plans yet" action={<Button size="sm" onClick={() => setCreating(true)}>Create the first plan</Button>} />}
        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--line)' }}><Switch checked={showArchived} onChange={setShowArchived} label="Show archived" /></div>
      </Panel>
      {planId ? <PlanEditor key={planId} planId={planId} meta={meta.data} activeId={list.data?.active_plan_id} onChanged={list.reload} />
        : <Panel><Empty icon={<I.planning />} title="Select or create a plan">Plans define items, workspace, strategy and every episode before recording starts.</Empty></Panel>}
      <NewPlanModal open={creating} onClose={() => setCreating(false)} meta={meta.data} onCreated={(id) => { setCreating(false); list.reload(); go(`/planning/${id}`); }} />
    </div>
  );
}

function NewPlanModal({ open, onClose, meta, onCreated }: { open: boolean; onClose: () => void; meta: any; onCreated: (id: string) => void }) {
  const { robotType } = useSystem();
  const toast = useToast();
  const types = useLoad(() => ros.robotTypes(), [open], 0, open);
  const [f, setF] = useState({ name: '', user_id: '', robot_type: '', strategy_type: 'dynamic' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setF((x) => ({ ...x, robot_type: x.robot_type || robotType })); }, [open, robotType]);
  const valid = /^[A-Za-z0-9_.-]+$/.test(f.name) && /^[A-Za-z0-9_.-]+$/.test(f.user_id) && f.robot_type;
  return (
    <Modal open={open} onClose={onClose} title="New collection plan" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid} busy={busy} data-action="create-plan" onClick={async () => {
      setBusy(true);
      try { const r = await planning('plan.new', f); onCreated(r.plan.id); toast.ok('Plan created'); } catch (e) { toast.error(e); } finally { setBusy(false); }
    }}>Create</Button></>}>
      <div className="stack">
        <div className="grid g2">
          <Field label="Task name" hint="Becomes part of the dataset name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="red_cube" data-field="plan-name" /></Field>
          <Field label="Hugging Face user / owner" hint="Dataset owner (folder name)"><Input value={f.user_id} onChange={(e) => setF({ ...f, user_id: e.target.value })} placeholder="NandithaaaG" data-field="plan-user" /></Field>
        </div>
        <Field label="Robot type"><Select value={f.robot_type} onChange={(v) => setF({ ...f, robot_type: v })} options={types.data?.robot_types || (f.robot_type ? [f.robot_type] : [])} placeholder="Select…" /></Field>
        <Field label="Planning strategy" hint={meta?.strategy_info?.[f.strategy_type]}>
          <Select value={f.strategy_type} onChange={(v) => setF({ ...f, strategy_type: v })} options={(meta?.strategy_types || ['dynamic']).map((s: string) => ({ value: s, label: s.replace('_', ' ') }))} />
        </Field>
      </div>
    </Modal>
  );
}

type TabId = 'scene' | 'strategy' | 'episodes' | 'preview' | 'validation' | 'history';

function PlanEditor({ planId, meta, activeId, onChanged }: { planId: string; meta: any; activeId?: string; onChanged: () => void }) {
  const toast = useToast();
  const { go } = useRouter();
  const full = useLoad<Full>(() => planning('plan.get', { plan_id: planId }), [planId]);
  const [draft, setDraft] = useState<any>(null);
  const [tab, setTab] = useState<TabId>('scene');
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState<'' | 'delete' | 'archive'>('');
  useEffect(() => { if (full.data) setDraft({ task: structuredClone(full.data.plan.task), strategy: structuredClone(full.data.plan.strategy) }); }, [full.data]);
  const dirty = useMemo(() => !!(full.data && draft && JSON.stringify({ task: full.data.plan.task, strategy: full.data.plan.strategy }) !== JSON.stringify(draft)), [full.data, draft]);

  const act = async (label: string, command: string, payload: Record<string, unknown>, ok?: string) => {
    setBusy(label);
    try {
      const r = await planning(command, payload);
      if (r?.plan) full.setData(r);
      onChanged();
      if (ok) toast.ok(ok);
      return r;
    } catch (e) { toast.error(e); return null; } finally { setBusy(''); }
  };
  if (full.error) return <Panel><ErrorState error={full.error} onRetry={full.reload} /></Panel>;
  if (!full.data || !draft) return <Panel><Loading /></Panel>;
  const { plan, summary, progress } = full.data;
  const v = plan.validation;
  const approved = plan.status === 'approved';
  const save = (regenerate: boolean) => act('save', 'plan.save', { plan: { id: plan.id, task: draft.task, strategy: draft.strategy }, regenerate }, regenerate ? 'Saved and regenerated' : 'Saved');
  const setTask = (patch: any) => setDraft((d: any) => ({ ...d, task: { ...d.task, ...patch } }));

  return (
    <div className="stack" data-plan-editor={plan.id}>
      <div className="panel" style={{ padding: '14px 16px' }}>
        <div className="row-between">
          <div>
            <div className="row"><h2 style={{ margin: 0, fontSize: 18 }}>{plan.task.name || plan.id}</h2><StatusBadge status={plan.status} /><Badge>v{plan.version}</Badge>{plan.id === activeId && <Badge tone="accent" dot>active for recording</Badge>}</div>
            <div className="small muted" style={{ marginTop: 4 }}>{plan.task.robot_type} · {plan.strategy.type} · {plan.episodes.length} episodes · dataset <span className="mono">{full.data.dataset_id || '— (set name and owner)'}</span></div>
          </div>
          <div className="row">
            {dirty && <><Badge tone="warn">unsaved changes</Badge><Button size="sm" onClick={() => setDraft({ task: structuredClone(plan.task), strategy: structuredClone(plan.strategy) })}>Discard</Button>
              <Button size="sm" variant="primary" busy={busy === 'save'} onClick={() => save(true)} data-action="save-plan">Save &amp; regenerate</Button></>}
            {!dirty && <>
              <Button size="sm" icon={<I.refresh />} busy={busy === 'gen'} onClick={() => act('gen', 'plan.generate', { plan_id: plan.id, keep_edited: true }, 'Episodes regenerated (edited episodes kept)')} disabled={plan.status === 'archived'}>Regenerate</Button>
              <Button size="sm" icon={<I.shield />} busy={busy === 'val'} onClick={async () => { const r = await act('val', 'plan.validate', { plan_id: plan.id }); if (r) setTab('validation'); }} data-action="validate">Validate</Button>
              {!approved ? <Button size="sm" variant="primary" icon={<I.check />} busy={busy === 'approve'} onClick={() => act('approve', 'plan.approve', { plan_id: plan.id }, 'Plan approved')} data-action="approve" disabled={plan.status === 'archived'}>Approve</Button>
                : plan.id !== activeId ? <Button size="sm" variant="primary" icon={<I.record />} busy={busy === 'active'} onClick={() => act('active', 'plan.set_active', { plan_id: plan.id }, 'Plan is now active in the Recording Studio')} data-action="set-active">Use for recording</Button>
                : <Link to="/recording" className="btn btn-sm btn-primary"><I.record />Open Recording</Link>}
            </>}
            <Button size="sm" variant="ghost" iconOnly icon={<I.copy />} title="Duplicate" onClick={async () => { const r = await act('dup', 'plan.duplicate', { plan_id: plan.id }, 'Duplicated'); if (r?.plan) go(`/planning/${r.plan.id}`); }} />
            <Button size="sm" variant="ghost" iconOnly icon={<I.layers />} title="Archive" onClick={() => setConfirm('archive')} disabled={plan.status === 'archived'} />
            <Button size="sm" variant="ghost" iconOnly icon={<I.trash />} title="Delete" onClick={() => setConfirm('delete')} data-action="delete-plan" />
          </div>
        </div>
        {approved && dirty && <div style={{ marginTop: 10 }}><Callout tone="info">This plan is approved. Saving creates draft version {plan.version + 1}; the approved version stays recorded with its episodes.</Callout></div>}
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'scene', label: 'Task & scene' }, { id: 'strategy', label: 'Strategy' },
        { id: 'episodes', label: 'Episodes', badge: <Badge>{plan.episodes.length}</Badge> }, { id: 'preview', label: 'Preview' },
        { id: 'validation', label: 'Validation', badge: v ? <Badge tone={v.ok ? 'ok' : 'danger'}>{v.ok ? 'ok' : v.errors}</Badge> : undefined },
        { id: 'history', label: 'History' },
      ]} />

      {tab === 'scene' && <SceneEditor task={draft.task} setTask={setTask} />}
      {tab === 'strategy' && (
        <div className="stack">
          <StrategyEditor meta={meta} task={draft.task} strategy={draft.strategy} onChange={(s) => setDraft((d: any) => ({ ...d, strategy: s }))}
            onType={async (t) => { const r = await planning('plan.defaults', { strategy_type: t, task: draft.task }).catch((e) => { toast.error(e); return null; }); if (r) setDraft((d: any) => ({ ...d, strategy: { ...d.strategy, type: t, params: r.params } })); }} />
          <Panel title="Action sequence" sub="Steps the operator demonstrates in each episode">
            <SequenceEditor meta={meta} task={draft.task} sequence={draft.strategy.params?.sequence || []} onChange={(seq) => setDraft((d: any) => ({ ...d, strategy: { ...d.strategy, params: { ...d.strategy.params, sequence: seq } } }))} />
          </Panel>
        </div>
      )}
      {tab === 'episodes' && <EpisodesEditor full={full.data} meta={meta} act={act} busy={busy} />}
      {tab === 'preview' && <Preview plan={plan} summary={summary} />}
      {tab === 'validation' && <ValidationView plan={plan} act={act} />}
      {tab === 'history' && <History full={full.data} />}

      <Confirm open={confirm === 'delete'} onClose={() => setConfirm('')} danger title="Delete plan" confirmLabel="Delete" typeToConfirm={plan.task.name || 'delete'}
        onConfirm={async () => { setConfirm(''); const r = await act('del', 'plan.delete', { plan_id: plan.id }, 'Plan deleted'); if (r !== null) go('/planning'); }}>
        Deletes the plan and its versions. Recorded episodes stay in the dataset. {progress && Object.keys(progress.episodes || {}).length ? <b>This plan has recording progress.</b> : null}
      </Confirm>
      <Confirm open={confirm === 'archive'} onClose={() => setConfirm('')} title="Archive plan" confirmLabel="Archive"
        onConfirm={() => { setConfirm(''); act('arch', 'plan.archive', { plan_id: plan.id }, 'Archived'); }}>Archived plans are read-only and hidden from the list. Duplicate one to work on it again.</Confirm>
    </div>
  );
}

function SceneEditor({ task, setTask }: { task: any; setTask: (p: any) => void }) {
  const ws = task.workspace || {};
  const rec = task.recording || {};
  const setWs = (p: any) => setTask({ workspace: { ...ws, ...p } });
  const setRec = (p: any) => setTask({ recording: { ...rec, ...p } });
  const setItem = (i: number, p: any) => setTask({ items: task.items.map((it: any, j: number) => (j === i ? { ...it, ...p } : it)) });
  return (
    <div className="grid g2">
      <div className="stack">
        <Panel title="Task">
          <div className="stack">
            <Field label="Instruction" hint="Stored with every episode; language-conditioned policies (SmolVLA) read it."><TextArea value={task.instruction || ''} onChange={(e) => setTask({ instruction: e.target.value })} rows={2} data-field="instruction" /></Field>
            <Field label="Description"><Input value={task.description || ''} onChange={(e) => setTask({ description: e.target.value })} /></Field>
            <div className="grid g3">
              <Field label="Task name"><Input value={task.name || ''} onChange={(e) => setTask({ name: e.target.value })} /></Field>
              <Field label="Owner"><Input value={task.user_id || ''} onChange={(e) => setTask({ user_id: e.target.value })} /></Field>
              <Field label="Episodes"><NumberInput value={task.episode_count} min={1} max={2000} onChange={(v) => setTask({ episode_count: v ?? 1 })} data-field="episode-count" /></Field>
            </div>
          </div>
        </Panel>
        <Panel title="Items" sub="Things the robot manipulates (object) and places it acts on (target)" actions={<Button size="sm" icon={<I.plus />} onClick={() => setTask({ items: [...task.items, { id: `item${task.items.length + 1}`, name: 'Item', role: 'object', size_mm: 30, color: '#4FA3D9', track_color: '#4FA3D9' }] })}>Add</Button>}>
          <div className="stack">{task.items.map((it: any, i: number) => (
            <div key={it.id} className="row" style={{ alignItems: 'flex-end' }}>
              <Field label="Name"><Input value={it.name} onChange={(e) => setItem(i, { name: e.target.value })} /></Field>
              <Field label="Role"><Select value={it.role} onChange={(v) => setItem(i, { role: v })} options={['object', 'target']} /></Field>
              <Field label="Size mm"><NumberInput value={it.size_mm} onChange={(v) => setItem(i, { size_mm: v ?? 10 })} style={{ width: 80 }} /></Field>
              <Field label="Colour"><input type="color" value={it.color || '#888888'} onChange={(e) => setItem(i, { color: e.target.value, track_color: e.target.value })} style={{ width: 44, height: 34, border: 0, background: 'none' }} /></Field>
              <Button variant="ghost" iconOnly icon={<I.trash />} disabled={task.items.length <= 1} onClick={() => setTask({ items: task.items.filter((_: any, j: number) => j !== i) })} />
            </div>
          ))}</div>
        </Panel>
        <Panel title="Recording settings">
          <div className="grid g4">
            <Field label="FPS"><NumberInput value={rec.fps} onChange={(v) => setRec({ fps: v ?? 30 })} /></Field>
            <Field label="Warm-up s"><NumberInput value={rec.warmup_s} onChange={(v) => setRec({ warmup_s: v ?? 0 })} /></Field>
            <Field label="Episode s"><NumberInput value={rec.episode_s} onChange={(v) => setRec({ episode_s: v ?? 20 })} /></Field>
            <Field label="Reset s"><NumberInput value={rec.reset_s} onChange={(v) => setRec({ reset_s: v ?? 0 })} /></Field>
          </div>
          <div style={{ marginTop: 12 }}><Switch checked={rec.use_optimized_save !== false} onChange={(v) => setRec({ use_optimized_save: v })} label="Optimised save mode" /></div>
        </Panel>
      </div>
      <div className="stack">
        <Panel title="Workspace" sub="Robot base at the origin; x forward, y left (mm)" actions={<Switch checked={!!ws.verified} onChange={(v) => setWs({ verified: v })} label="Verified on the table" />}>
          <WorkspaceView task={task} />
          <div className="grid g4 mt">
            {(['x_min_mm', 'x_max_mm', 'y_min_mm', 'y_max_mm', 'reach_min_mm', 'reach_max_mm', 'base_keepout_mm', 'margin_mm'] as const).map((k) => (
              <Field key={k} label={k.replace('_mm', '').replace(/_/g, ' ')}><NumberInput value={ws[k]} onChange={(v) => setWs({ [k]: v ?? 0 })} /></Field>
            ))}
          </div>
          {!ws.verified && <div className="mt"><Callout tone="warn">Workspace limits are robot defaults. Measure them on your table, then mark them verified.</Callout></div>}
        </Panel>
        <Panel title="Regions" sub="Named areas used by dynamic strategies">
          <div className="table-wrap"><table className="table"><thead><tr><th>Region</th><th>x min</th><th>x max</th><th>y min</th><th>y max</th></tr></thead>
            <tbody>{(task.regions || []).map((r: any, i: number) => (
              <tr key={r.id}><td>{r.name} <span className="muted mono tiny">{r.id}</span></td>
                {(['x_min_mm', 'x_max_mm', 'y_min_mm', 'y_max_mm'] as const).map((k) => (
                  <td key={k}><NumberInput value={r[k]} style={{ width: 80, height: 28 }} onChange={(v) => setTask({ regions: task.regions.map((x: any, j: number) => (j === i ? { ...x, [k]: v ?? 0 } : x)) })} /></td>
                ))}</tr>
            ))}</tbody></table></div>
        </Panel>
      </div>
    </div>
  );
}

function EpisodesEditor({ full, meta, act, busy }: { full: Full; meta: any; act: (l: string, c: string, p: any, ok?: string) => Promise<any>; busy: string }) {
  const { plan, progress } = full;
  const eps = [...plan.episodes].sort((a: any, b: any) => a.order - b.order);
  const [sel, setSel] = useState<string>(eps[0]?.id);
  const ep = eps.find((e: any) => e.id === sel) || eps[0];
  const [instr, setInstr] = useState('');
  const [notes, setNotes] = useState('');
  useEffect(() => { setInstr(ep?.instruction || ''); setNotes(ep?.operator_notes || ''); }, [ep?.id, ep?.instruction, ep?.operator_notes]);
  const status = (id: string) => progress?.episodes?.[id]?.status || 'pending';
  const move = (id: string, d: number) => {
    const order = eps.map((e: any) => e.id);
    const i = order.indexOf(id); const j = i + d;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    act('reorder', 'plan.reorder', { plan_id: plan.id, order });
  };
  if (!eps.length) return <Panel><Empty title="No episodes generated" action={<Button onClick={() => act('gen', 'plan.generate', { plan_id: plan.id })}>Generate episodes</Button>} /></Panel>;
  return (
    <div className="grid g-side">
      <Panel title="Episodes" sub="Click to edit · order is the recording order" flush>
        <div className="table-wrap" style={{ maxHeight: 620 }}><table className="table">
          <thead><tr><th>#</th><th>Episode</th><th>Placements</th><th>Scenario</th><th>Status</th><th /></tr></thead>
          <tbody>{eps.map((e: any) => (
            <tr key={e.id} className="clickable" aria-selected={e.id === ep?.id} onClick={() => setSel(e.id)} data-episode={e.id}>
              <td className="num muted">{e.order}</td>
              <td><span className="mono">{e.id}</span>{e.edited && <Badge tone="info">edited</Badge>}<div className="tiny muted ellipsis" style={{ maxWidth: 260 }}>{e.instruction || plan.task.instruction || 'no instruction'}</div></td>
              <td className="tiny mono">{e.placements.map((p: any) => `${p.item_id}@${p.region || '?'}`).join(' ')}</td>
              <td className="small">{e.scenario?.name}</td>
              <td><StatusBadge status={status(e.id)} /></td>
              <td className="nowrap"><Button size="sm" variant="ghost" iconOnly icon={<I.back style={{ transform: 'rotate(90deg)' }} />} onClick={(ev) => { ev.stopPropagation(); move(e.id, -1); }} aria-label="Move up" /><Button size="sm" variant="ghost" iconOnly icon={<I.back style={{ transform: 'rotate(-90deg)' }} />} onClick={(ev) => { ev.stopPropagation(); move(e.id, 1); }} aria-label="Move down" /></td>
            </tr>
          ))}</tbody>
        </table></div>
      </Panel>
      {ep && (
        <div className="stack">
          <Panel title={<>Episode <span className="mono">{ep.id}</span></>} sub="Drag items to change the start layout" actions={<StatusBadge status={status(ep.id)} />}>
            <WorkspaceView task={plan.task} placements={ep.placements}
              onMove={(itemId, x, y) => act('ep', 'plan.update_episode', { plan_id: plan.id, episode_id: ep.id, patch: { placements: ep.placements.map((p: any) => (p.item_id === itemId ? { ...p, x_mm: x, y_mm: y } : p)) } })} />
            <div className="stack mt">
              {ep.placements.map((p: any, i: number) => (
                <div key={p.item_id} className="row">
                  <span className="mono small" style={{ width: 60 }}>{p.item_id}</span>
                  {(['x_mm', 'y_mm', 'yaw_deg'] as const).map((k) => (
                    <NumberInput key={k} value={p[k]} style={{ width: 86 }} title={k} onChange={(val) => {
                      if (val == null) return;
                      act('ep', 'plan.update_episode', { plan_id: plan.id, episode_id: ep.id, patch: { placements: ep.placements.map((q: any, j: number) => (j === i ? { ...q, [k]: val } : q)) } });
                    }} />
                  ))}
                  <span className="tiny muted">region {p.region || '—'}</span>
                </div>
              ))}
              <Field label="Instruction (empty = task instruction)"><Input value={instr} onChange={(e) => setInstr(e.target.value)} /></Field>
              <Field label="Operator notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
              {ep.scenario?.perturbation && ep.scenario.perturbation !== 'none' && <Callout tone="info" title={ep.scenario.name}>{meta?.perturbations?.find?.((x: string) => x === ep.scenario.perturbation) || ep.scenario.perturbation}</Callout>}
            </div>
            <div className="row mt">
              <Button size="sm" variant="primary" disabled={instr === (ep.instruction || '') && notes === (ep.operator_notes || '')} busy={busy === 'ep'}
                onClick={() => act('ep', 'plan.update_episode', { plan_id: plan.id, episode_id: ep.id, patch: { instruction: instr, operator_notes: notes } }, 'Episode updated')}>Save episode</Button>
              <Button size="sm" icon={<I.copy />} onClick={() => act('add', 'plan.add_episode', { plan_id: plan.id, copy_from: ep.id }, 'Episode added')}>Duplicate</Button>
              <Button size="sm" variant="ghost" icon={<I.trash />} onClick={() => act('rm', 'plan.remove_episode', { plan_id: plan.id, episode_id: ep.id }, 'Episode removed')}>Remove</Button>
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

function Preview({ plan, summary }: { plan: any; summary: any }) {
  const ghosts = plan.episodes.flatMap((e: any) => e.placements);
  const combos = Object.entries(summary?.by_region_combo || {}).map(([label, value]) => ({ label, value: value as number }));
  const scen = Object.entries(summary?.by_scenario || {}).map(([label, value]) => ({ label, value: value as number }));
  const d = summary?.object_target_distance_mm;
  return (
    <div className="grid g2">
      <Panel title="All start positions" sub={`${plan.episodes.length} episodes overlaid`}><WorkspaceView task={plan.task} ghosts={ghosts} height={460} /></Panel>
      <div className="stack">
        <div className="grid g3">
          <div className="panel stat"><span className="label">Distinct setups</span><span className="stat-value">{summary?.distinct_setups ?? '—'}</span></div>
          <div className="panel stat"><span className="label">Obj→target mm</span><span className="stat-value" style={{ fontSize: 18 }}>{d ? `${d.min}–${d.max}` : '—'}</span><span className="stat-foot">mean {d?.mean ?? '—'}</span></div>
          <div className="panel stat"><span className="label">Edited</span><span className="stat-value">{summary?.edited ?? 0}</span></div>
        </div>
        <Panel title="Coverage by region combination"><BarChart data={combos} /></Panel>
        {scen.length > 1 && <Panel title="Scenarios"><BarChart data={scen} /></Panel>}
      </div>
    </div>
  );
}

function ValidationView({ plan, act }: { plan: any; act: (l: string, c: string, p: any, ok?: string) => Promise<any> }) {
  const v = plan.validation;
  if (!v) return <Panel><Empty icon={<I.shield />} title="Not validated yet" action={<Button onClick={() => act('val', 'plan.validate', { plan_id: plan.id })}>Validate now</Button>} /></Panel>;
  const groups: Record<string, any[]> = {};
  (v.issues || []).forEach((i: any) => { (groups[i.code + i.severity] ||= []).push(i); });
  return (
    <Panel title={v.ok ? 'Plan is valid' : `${v.errors} error(s), ${v.warnings} warning(s)`} sub={v.ran_at ? `checked ${fmt.ago(v.ran_at)}` : undefined}
      actions={<Button size="sm" icon={<I.refresh />} onClick={() => act('val', 'plan.validate', { plan_id: plan.id })}>Re-validate</Button>}>
      {v.ok && !v.issues?.length ? <Callout tone="ok" title="No issues">Approve the plan to record it.</Callout> : (
        <div className="stack">{Object.values(groups).map((g) => {
          const i = g[0];
          return (
            <div key={i.code + i.severity} className={`callout callout-${i.severity === 'error' ? 'danger' : 'warn'}`} data-issue={i.code}>
              <I.alert />
              <div className="grow"><div className="callout-title">{i.message}</div><div className="tiny text-2">{g.length > 1 ? `${g.length} occurrences` : i.episode_id ? `episode ${i.episode_id}` : i.code}</div></div>
              {i.fix && <Button size="sm" onClick={async () => { for (const x of g) { if (x.fix) await act('fix', 'plan.apply_fix', { plan_id: plan.id, fix: x.fix }); } }} data-fix={i.code}>{i.fix.label}{g.length > 1 ? ` (${g.length})` : ''}</Button>}
            </div>
          );
        })}</div>
      )}
    </Panel>
  );
}

function History({ full }: { full: Full }) {
  return (
    <div className="grid g2">
      <Panel title="Events"><div className="timeline">{(full.events || []).slice().reverse().map((e: any, i: number) => (
        <div key={i} className="timeline-item ok"><b>{e.event.replace(/_/g, ' ')}</b> <span className="muted">· {fmt.time(e.t)}</span><div className="tiny muted mono">{Object.entries(e).filter(([k]) => !['t', 'event'].includes(k)).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')}</div></div>
      ))}</div></Panel>
      <Panel title="Approved versions">{full.versions?.length ? <div className="list" style={{ margin: -16 }}>{full.versions.map((v: any) => (
        <div key={v.version ?? v} className="list-item"><Badge tone="ok">v{v.version ?? v}</Badge><span className="small muted">{v.approved_at ? fmt.time(v.approved_at) : ''}</span></div>
      ))}</div> : <Empty title="No approved versions yet" />}</Panel>
    </div>
  );
}

