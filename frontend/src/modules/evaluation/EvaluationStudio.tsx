// MODULE 8: Evaluation Studio. Two kinds of evidence, kept apart on purpose:
//  * offline: training/validation loss of each run (pam_trainer metrics, compare);
//  * on the robot: trials the operator observed (pam_trainer evaluations log), with success
//    rates and 95% confidence intervals. Robot trials are executed in the Rollout module.
import { useEffect, useState } from 'react';
import { trainer } from '@/api/trainer';
import { Link } from '@/app/router';
import { BarChart } from '@/design/charts';
import { I } from '@/design/icons';
import {
  Button, Callout, Confirm, Empty, ErrorState, Field, Input, Loading, NumberInput, Panel, Select, StatusBadge, Tabs,
  fmt, useToast,
} from '@/design/ui';
import { useLoad } from '@/hooks/data';
import { Compare } from '../optimization/OptimizationStudio';
import { Page, Requires } from '../shared';

export default function EvaluationStudio() {
  return (
    <Page intro="Judge trained models on evidence: offline metrics show how closely a model copies the demonstrations; robot trials show whether it actually grasps and places. Run a checkpoint on the robot from Robot Rollout, then record what happened here.">
      <Requires service="trainer" what="Evaluation"><Studio /></Requires>
    </Page>
  );
}

function Studio() {
  const [tab, setTab] = useState<'robot' | 'offline'>('robot');
  const runs = useLoad(() => trainer.runs(), [], 0);
  const ev = useLoad(() => trainer.evaluations(), [], 8000);
  const finished = (runs.data?.runs || []).filter((r: any) => ['succeeded', 'stopped', 'failed'].includes(r.status));
  return (
    <div className="stack">
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'robot', label: 'Robot evaluations' }, { id: 'offline', label: 'Offline metrics & comparison' }]} />
      {tab === 'robot' ? <RobotEvals runs={finished} ev={ev} /> : <Compare runs={finished} initial={finished.slice(0, 2).map((r: any) => r.id)} />}
    </div>
  );
}

function RobotEvals({ runs, ev }: { runs: any[]; ev: ReturnType<typeof useLoad<any>> }) {
  const toast = useToast();
  const [form, setForm] = useState<any>({ run_id: '', step: '', outcome: 'success', object: {}, target: {}, conditions: '', notes: '' });
  const [del, setDel] = useState<string | null>(null);
  const cks = useLoad(() => trainer.checkpoints(form.run_id), [form.run_id], 0, !!form.run_id);
  useEffect(() => { const last = (cks.data?.checkpoints || []).slice(-1)[0]; if (last && !form.step) setForm((f: any) => ({ ...f, step: String(last.step) })); }, [cks.data, form.step]);
  if (ev.error) return <ErrorState error={ev.error} onRetry={ev.reload} />;
  if (!ev.data) return <Loading />;
  const outcomes: Record<string, string> = ev.data.outcomes || {};
  const summary: any[] = ev.data.summary || [];
  const trials: any[] = ev.data.trials || [];
  const add = async () => {
    try { await trainer.addTrial({ ...form, step: Number(form.step) }); toast.ok('Trial recorded'); setForm({ ...form, notes: '', object: {}, target: {} }); ev.reload(); } catch (e) { toast.error(e); }
  };
  return (
    <div className="grid g-side">
      <div className="stack">
        <Panel title="Success rate by checkpoint" sub="95% Wilson interval; fewer than 10 trials is a rough indication only">
          {!summary.length ? <Empty icon={<I.evaluation />} title="No robot trials recorded" action={<Link to="/rollout" className="btn btn-sm">Run a checkpoint on the robot</Link>} /> : (
            <div className="stack">
              <BarChart data={summary.map((g) => ({ label: `${g.job_name} @${g.step}`, value: Math.round(100 * (g.rate || 0)) }))} format={(v) => `${v}%`} />
              <div className="table-wrap"><table className="table"><thead><tr><th>Model</th><th>Checkpoint</th><th className="right">Trials</th><th className="right">Success</th><th>95% CI</th><th>Failures</th></tr></thead>
                <tbody>{summary.map((g) => (
                  <tr key={g.run_id + g.step}><td><Link to={`/training/runs/${g.run_id}`}>{g.job_name}</Link></td><td className="num">{fmt.num(g.step)}</td><td className="right num">{g.n}</td>
                    <td className="right num"><b>{Math.round(100 * (g.rate || 0))}%</b></td><td className="small num">{g.ci?.[0] != null ? `${Math.round(100 * g.ci[0])}–${Math.round(100 * g.ci[1])}%` : '—'}</td>
                    <td className="small">{Object.entries(g.outcomes || {}).filter(([k, v]) => k !== 'success' && (v as number) > 0).map(([k, v]) => `${outcomes[k] || k} ${v}`).join(' · ') || '—'}</td></tr>
                ))}</tbody></table></div>
            </div>
          )}
        </Panel>
        <Panel title="Trial history" flush>
          {!trials.length ? <Empty title="No trials yet" /> : (
            <div className="table-wrap" style={{ maxHeight: 420 }}><table className="table"><thead><tr><th>When</th><th>Model</th><th>Outcome</th><th>Object</th><th>Target</th><th>Notes</th><th /></tr></thead>
              <tbody>{trials.slice().reverse().map((t) => (
                <tr key={t.id}><td className="small nowrap">{fmt.time(t.t)}</td><td className="small">{t.job_name} @{t.step}</td><td><StatusBadge status={t.outcome === 'success' ? 'success' : 'failed'} /> <span className="tiny muted">{outcomes[t.outcome]}</span></td>
                  <td className="mono tiny">{t.object?.x_mm != null ? `${t.object.x_mm}, ${t.object.y_mm}` : '—'}</td><td className="mono tiny">{t.target?.x_mm != null ? `${t.target.x_mm}, ${t.target.y_mm}` : '—'}</td>
                  <td className="small ellipsis" style={{ maxWidth: 200 }}>{t.notes}</td><td><Button size="sm" variant="ghost" iconOnly icon={<I.trash />} onClick={() => setDel(t.id)} /></td></tr>
              ))}</tbody></table></div>
          )}
        </Panel>
      </div>
      <Panel title="Record a robot trial" sub="What you observed when the checkpoint ran on the robot" footer={<Button variant="primary" onClick={add} disabled={!form.run_id || !form.step} data-action="add-trial">Save trial</Button>}>
        <div className="stack">
          <Field label="Model (training run)"><Select value={form.run_id} onChange={(v) => setForm({ ...form, run_id: v, step: '' })} options={runs.map((r: any) => ({ value: r.id, label: `${r.job_name} (${r.policy})` }))} placeholder="Select…" /></Field>
          <Field label="Checkpoint"><Select value={form.step} onChange={(v) => setForm({ ...form, step: v })} options={(cks.data?.checkpoints || []).map((c: any) => ({ value: String(c.step), label: `step ${c.step}${c.is_last ? ' (last)' : ''}` }))} placeholder="Select…" /></Field>
          <Field label="Outcome"><Select value={form.outcome} onChange={(v) => setForm({ ...form, outcome: v })} options={Object.entries(outcomes).map(([value, label]) => ({ value, label }))} /></Field>
          <div className="grid g2">
            <Field label="Object x mm"><NumberInput value={form.object.x_mm} onChange={(v) => setForm({ ...form, object: { ...form.object, x_mm: v } })} /></Field>
            <Field label="Object y mm"><NumberInput value={form.object.y_mm} onChange={(v) => setForm({ ...form, object: { ...form.object, y_mm: v } })} /></Field>
            <Field label="Target x mm"><NumberInput value={form.target.x_mm} onChange={(v) => setForm({ ...form, target: { ...form.target, x_mm: v } })} /></Field>
            <Field label="Target y mm"><NumberInput value={form.target.y_mm} onChange={(v) => setForm({ ...form, target: { ...form.target, y_mm: v } })} /></Field>
          </div>
          <Field label="Conditions" hint="e.g. lighting, camera position"><Input value={form.conditions} onChange={(e) => setForm({ ...form, conditions: e.target.value })} /></Field>
          <Field label="Notes"><Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          <Callout tone="info">Record failures too. A success rate from successes alone is meaningless.</Callout>
        </div>
      </Panel>
      <Confirm open={!!del} onClose={() => setDel(null)} danger title="Delete trial" confirmLabel="Delete" onConfirm={async () => { const id = del!; setDel(null); try { await trainer.deleteTrial(id); ev.reload(); } catch (e) { toast.error(e); } }}>This trial will no longer count in the success rate.</Confirm>
    </div>
  );
}
