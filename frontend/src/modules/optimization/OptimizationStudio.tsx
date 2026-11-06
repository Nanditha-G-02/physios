// MODULE 6: Optimization Studio. Diagnostics, recommendations and controlled trial sessions
// are pam_trainer's optimiser (diagnostics.py, tuning.py, optimizer.py). Each trial is a
// separate run from the same checkpoint; nothing changes a running training's optimiser.
import { useState } from 'react';
import { trainer, ACTIVE_RUN } from '@/api/trainer';
import { Link, useRouter } from '@/app/router';
import { LineChart } from '@/design/charts';
import { I } from '@/design/icons';
import {
  Badge, Button, Callout, Check, CodeBlock, Confirm, Empty, ErrorState, Field, KV, Loading, NumberInput, Panel,
  Segmented, StatusBadge, Tabs, fmt, toneOf, useToast,
} from '@/design/ui';
import { useLoad } from '@/hooks/data';
import { Page, Requires } from '../shared';

export default function OptimizationStudio({ runId, sessionId }: { runId?: string; sessionId?: string }) {
  return (
    <Page>
      <Requires service="trainer" what="Optimisation">
        {sessionId ? <SessionDetail id={sessionId} /> : runId ? <Diagnosis id={runId} /> : <Overview />}
      </Requires>
    </Page>
  );
}

function Overview() {
  const runs = useLoad(() => trainer.runs(), [], 6000);
  const sessions = useLoad(() => trainer.optSessions(), [], 6000);
  const [tab, setTab] = useState<'runs' | 'sessions' | 'compare'>('runs');
  const list: any[] = runs.data?.runs || [];
  const ss: any[] = sessions.data?.sessions || [];
  return (
    <div className="stack">
      <p className="page-intro" style={{ margin: 0 }}>Find what limits a training (divergence, clipping, over-fitting, slow data loading), see which changes this LeRobot actually supports, and test them in controlled trials: a control and each change, run separately from the same checkpoint.</p>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'runs', label: 'Diagnose a run' }, { id: 'sessions', label: 'Optimisation history', badge: <Badge>{ss.length}</Badge> }, { id: 'compare', label: 'Compare runs' }]} />
      {tab === 'runs' && (
        <Panel flush>
          {runs.error ? <ErrorState error={runs.error} /> : !runs.data ? <div style={{ padding: 16 }}><Loading rows={3} /></div> : !list.length ? <Empty icon={<I.training />} title="No runs to diagnose" /> : (
            <div className="table-wrap"><table className="table"><thead><tr><th>Run</th><th>Status</th><th>Policy</th><th className="right">Steps</th><th className="right">Loss</th><th>Monitor</th><th /></tr></thead>
              <tbody>{list.map((r) => {
                const w = sessions.data?.watches?.[r.id];
                return (
                  <tr key={r.id}><td><b style={{ fontWeight: 600 }}>{r.job_name}</b><div className="tiny muted">{fmt.ago(r.created_at)}</div></td><td><StatusBadge status={r.status} /></td><td>{r.policy}</td>
                    <td className="right num">{fmt.num(r.progress?.step)}</td><td className="right num">{fmt.sci(r.progress?.last?.loss)}</td>
                    <td>{w ? <Badge tone="info">{w.mode}</Badge> : <span className="muted small">off</span>}</td>
                    <td><Link to={`/optimization/runs/${r.id}`} className="btn btn-sm" data-diagnose={r.id}>Diagnose<I.chevron /></Link></td></tr>
                );
              })}</tbody></table></div>
          )}
        </Panel>
      )}
      {tab === 'sessions' && (
        <Panel flush>
          {!ss.length ? <Empty icon={<I.optimize />} title="No optimisation sessions yet">Diagnose a finished or stopped run and create a session from its recommendations.</Empty> : (
            <div className="table-wrap"><table className="table"><thead><tr><th>Session</th><th>Status</th><th>Mode</th><th>Trials</th><th>Budget</th><th>Result</th><th>Created</th></tr></thead>
              <tbody>{ss.map((s) => (
                <tr key={s.id}><td><Link to={`/optimization/sessions/${s.id}`}>{s.name}</Link></td><td><StatusBadge status={s.status} /></td><td>{s.mode}</td>
                  <td className="small">{(s.trials || []).map((t: any) => <span key={t.id} className="row" style={{ gap: 4, display: 'inline-flex', marginRight: 6 }}><span className={`dot dot-${toneOf(t.status) === 'neutral' ? '' : toneOf(t.status)}`} />{t.candidate_id}</span>)}</td>
                  <td className="small num">{s.budget ? `${fmt.dur(s.budget.used_s)} / ${fmt.dur(s.budget.limit_s)}` : '—'}</td>
                  <td className="small ellipsis" style={{ maxWidth: 280 }}>{s.recommendation?.headline || '—'}</td><td className="small muted">{fmt.ago(s.created_at)}</td></tr>
              ))}</tbody></table></div>
          )}
        </Panel>
      )}
      {tab === 'compare' && <Compare runs={list} />}
    </div>
  );
}

export function Compare({ runs, initial = [] }: { runs: any[]; initial?: string[] }) {
  const [sel, setSel] = useState<string[]>(initial);
  const cmp = useLoad(() => trainer.compare(sel), [sel.join()], 0, sel.length >= 2);
  const d = cmp.data;
  return (
    <div className="grid g-side-l">
      <Panel title="Runs" sub="Choose 2–6" flush>
        <div className="list" style={{ maxHeight: 520, overflowY: 'auto' }}>{runs.map((r) => (
          <label key={r.id} className="list-item" style={{ cursor: 'pointer' }}><input type="checkbox" checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id].slice(0, 6) : sel.filter((x) => x !== r.id))} />
            <div className="grow"><div className="small">{r.job_name}</div><div className="tiny muted">{r.policy} · {r.status}</div></div></label>
        ))}</div>
      </Panel>
      {sel.length < 2 ? <Panel><Empty icon={<I.layers />} title="Select at least two runs" /></Panel> : cmp.error ? <ErrorState error={cmp.error} /> : !d ? <Loading /> : (
        <div className="stack">
          {d.best && <Callout tone="ok" title={`Best so far: ${d.runs.find((r: any) => r.id === d.best.run_id)?.job_name} (step ${d.best.step})`}>{d.best.basis}</Callout>}
          <Panel title="Training loss"><LineChart series={d.runs.map((r: any) => ({ name: r.job_name, points: (r.loss || []).map((p: any) => [p.x, p.y]) }))} log xLabel="step" /></Panel>
          {d.runs.some((r: any) => r.eval_loss?.length) && <Panel title="Validation loss"><LineChart series={d.runs.filter((r: any) => r.eval_loss?.length).map((r: any) => ({ name: r.job_name, points: r.eval_loss.map((p: any) => [p.x, p.y]) }))} xLabel="step" /></Panel>}
          <Panel title="Training metrics vs robot results" sub="Loss measures imitation of the demonstrations; only robot trials measure task success" flush>
            <div className="table-wrap"><table className="table"><thead><tr><th>Run</th><th>Stability</th><th className="right">Final loss</th><th className="right">Best val loss</th><th className="right">Steps</th><th className="right">GPU peak</th><th className="right">Robot success</th></tr></thead>
              <tbody>{d.runs.map((r: any) => {
                const ev = (r.evaluations || [])[0];
                return <tr key={r.id}><td>{r.job_name}</td><td><StatusBadge status={r.stability === 'stable' ? 'ok' : r.stability} /></td><td className="right num">{fmt.sci(r.final_loss)}</td><td className="right num">{fmt.sci(r.eval_best)}</td><td className="right num">{fmt.num(r.steps_done)}</td><td className="right num">{r.gpu_peak_mb ? `${fmt.num(r.gpu_peak_mb)} MB` : '—'}</td><td className="right num">{ev ? `${Math.round(100 * (ev.success_rate ?? 0))}% (${ev.trials ?? ev.n} trials)` : '—'}</td></tr>;
              })}</tbody></table></div>
          </Panel>
          <Panel title="Configuration differences" flush>
            <div className="table-wrap"><table className="table"><thead><tr><th>Setting</th>{d.runs.map((r: any) => <th key={r.id}>{r.job_name}</th>)}</tr></thead>
              <tbody>{(d.config_diff || []).filter((c: any) => c.differs).map((c: any) => <tr key={c.key}><td className="mono small">{c.key}</td>{c.values.map((v: any, i: number) => <td key={i} className="mono small">{String(v ?? '—')}</td>)}</tr>)}
                {!(d.config_diff || []).some((c: any) => c.differs) && <tr><td colSpan={d.runs.length + 1} className="muted small">Identical configuration.</td></tr>}</tbody></table></div>
          </Panel>
        </div>
      )}
    </div>
  );
}

const SEV: Record<string, 'danger' | 'warn' | 'info'> = { critical: 'danger', high: 'danger', warning: 'warn', medium: 'warn', info: 'info', low: 'info' };

function Diagnosis({ id }: { id: string }) {
  const toast = useToast();
  const { go } = useRouter();
  const dg = useLoad(() => trainer.diagnostics(id), [id], 10000);
  const watches = useLoad(() => trainer.optSessions(), [id]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [mode, setMode] = useState<'manual' | 'auto'>('manual');
  const [settings, setSettings] = useState<any>({ max_trials: 3, trial_steps: null, gpu_budget_s: 3600, min_gain_pct: 5 });
  const [proposal, setProposal] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const [watchAck, setWatchAck] = useState(false);
  if (dg.error) return <ErrorState error={dg.error} onRetry={dg.reload} />;
  const d = dg.data;
  if (!d) return <Loading label="Analysing the run…" />;
  const run = d.run;
  const active = ACTIVE_RUN.includes(run.status);
  const cands: any[] = d.candidates || [];
  const sel = picked ?? d.trial_set ?? [];
  const series = d.series || {};
  const pts = (k: string) => (series[k] || []).map((p: any) => [p.x, p.y] as [number, number]);
  const watch = watches.data?.watches?.[id];
  const propose = async () => {
    setBusy('propose');
    try { setProposal(await trainer.optPropose({ run_id: id, candidate_ids: sel, mode, settings })); } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const create = async () => {
    setBusy('create');
    try { const s = await trainer.optCreate({ run_id: id, candidate_ids: sel, mode, settings }, proposal.token); toast.ok('Session created'); go(`/optimization/sessions/${s.id}`); } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const setWatch = async (m: string) => { try { await trainer.watch(id, m, mode === 'auto' ? settings : undefined, watchAck); toast.ok(`Monitor: ${m}`); watches.reload(); } catch (e) { toast.error(e); } };
  return (
    <div className="stack" data-diagnosis={id}>
      <div className="row"><Link to="/optimization" className="btn btn-sm btn-ghost"><I.back />Optimisation</Link><h2 style={{ margin: 0, fontSize: 18 }}>{run.job_name}</h2><StatusBadge status={run.status} /><Link to={`/training/runs/${id}`} className="btn btn-sm btn-ghost">Run details<I.chevron /></Link></div>
      <div className="grid g4">
        <div className="panel stat"><span className="label">Issues</span><span className="stat-value">{d.issues.length}</span><span className="stat-foot">{d.issues.filter((i: any) => SEV[i.severity] === 'danger').length} critical</span></div>
        <div className="panel stat"><span className="label">Loss now / best</span><span className="stat-value" style={{ fontSize: 19 }}>{fmt.sci(d.summary.loss_last)} / {fmt.sci(d.summary.loss_min)}</span></div>
        <div className="panel stat"><span className="label">Throughput</span><span className="stat-value">{d.summary.steps_per_s?.toFixed?.(1) ?? '—'}<small>steps/s</small></span><span className="stat-foot">data {fmt.sci(d.summary.data_s)} s · update {fmt.sci(d.summary.update_s)} s</span></div>
        <div className="panel stat"><span className="label">GPU peak</span><span className="stat-value">{fmt.num(d.summary.gpu_peak_mb)}<small>MB</small></span><span className="stat-foot">of {fmt.num(d.summary.gpu_total_mb)} MB</span></div>
      </div>
      <div className="grid g-side">
        <div className="stack">
          <Panel title="Training health" sub={d.validation?.enabled ? `validation loss: ${d.validation.points} points` : 'validation off for this run'}>
            {!d.issues.length ? <Callout tone="ok" title="No problems detected">The loss, gradients and throughput look normal for this run.</Callout> : (
              <div className="stack">{d.issues.map((i: any) => (
                <div key={i.id} className={`callout callout-${SEV[i.severity] || 'info'}`} data-issue={i.id}>
                  <I.alert />
                  <div className="grow"><div className="callout-title">{i.title} <Badge tone={SEV[i.severity] || 'info'}>{i.severity}</Badge></div><div className="text-2 small">{i.detail}</div><div className="small" style={{ marginTop: 4 }}><b>Action:</b> {i.action}</div></div>
                </div>
              ))}</div>
            )}
          </Panel>
          <div className="grid g2">
            <Panel title="Loss"><LineChart series={[{ name: 'loss', points: pts('loss') }, ...(series.eval_loss?.length ? [{ name: 'validation', points: pts('eval_loss'), dashed: true }] : [])]} log height={190} xLabel="step" /></Panel>
            <Panel title="Gradient norm" sub={`clip ${d.clip_norm ?? '—'}${d.clip_norm_assumed ? ' (preset default)' : ''}`}><LineChart series={[{ name: 'grad norm', points: pts('grad_norm') }]} log height={190} xLabel="step" markers={d.clip_norm ? [] : []} /></Panel>
            <Panel title="Learning rate"><LineChart series={[{ name: 'lr', points: pts('lr') }]} height={190} xLabel="step" yFormat={fmt.sci} /></Panel>
            <Panel title="GPU memory"><LineChart series={[{ name: 'MB', points: pts('gpu_mb') }]} height={190} xLabel="step" /></Panel>
          </div>
          <Panel title="What this LeRobot supports" sub="Read from lerobot-train --help for this policy" flush>
            <div className="table-wrap"><table className="table"><thead><tr><th>Lever</th><th>Supported</th><th>Flags / reason</th></tr></thead>
              <tbody>{(d.capabilities || []).map((c: any) => <tr key={c.id}><td>{c.label}</td><td>{c.supported ? <Badge tone="ok">yes</Badge> : <Badge>no</Badge>}</td><td className="small mono">{c.supported ? c.flags.join(', ') : c.reason}</td></tr>)}</tbody></table></div>
          </Panel>
        </div>
        <div className="stack">
          <Panel title="Recommendations" sub="Select the changes to trial">
            {!cands.length ? <Empty title="No changes recommended" /> : (
              <div className="stack">{cands.map((c) => (
                <div key={c.id} className="panel" style={{ padding: 12, boxShadow: 'none', opacity: c.supported ? 1 : 0.6 }} data-candidate={c.id}>
                  <Check checked={sel.includes(c.id)} disabled={!c.supported || c.kind !== 'config'} onChange={(v) => setPicked(v ? [...sel, c.id] : sel.filter((x: string) => x !== c.id))}><b style={{ color: 'var(--text)' }}>{c.title}</b></Check>
                  <div className="small text-2" style={{ marginTop: 4 }}>{c.why}</div>
                  {c.risk && <div className="tiny muted">Risk: {c.risk}</div>}
                  {!c.supported && <div className="tiny" style={{ color: 'var(--warn)' }}>{c.unsupported_reason}</div>}
                  {c.patch && <div className="tiny mono muted" style={{ marginTop: 4 }}>{JSON.stringify(c.patch)}</div>}
                </div>
              ))}</div>
            )}
          </Panel>
          <Panel title="Optimisation session" sub="Control + each change, run one after another from the same checkpoint">
            <div className="stack">
              <Segmented value={mode} onChange={setMode} options={[{ value: 'manual', label: 'Manual (launch each trial)' }, { value: 'auto', label: 'Automatic within budget' }]} />
              <div className="grid g2">
                <Field label="Max trials"><NumberInput value={settings.max_trials} onChange={(v) => setSettings({ ...settings, max_trials: v })} /></Field>
                <Field label="Steps per trial" hint="empty = 10% of the run"><NumberInput value={settings.trial_steps} onChange={(v) => setSettings({ ...settings, trial_steps: v })} /></Field>
                <Field label="GPU budget (s)"><NumberInput value={settings.gpu_budget_s} onChange={(v) => setSettings({ ...settings, gpu_budget_s: v })} /></Field>
                <Field label="Min. gain over control %"><NumberInput value={settings.min_gain_pct} onChange={(v) => setSettings({ ...settings, min_gain_pct: v })} /></Field>
              </div>
              {active && <Callout tone="warn">This run is still {run.status}. Stop it first (checkpoints are kept) or let the monitor stop it.</Callout>}
              <Button variant="primary" disabled={!sel.length || active} busy={busy === 'propose'} onClick={propose} data-action="propose">Plan trials</Button>
            </div>
          </Panel>
          {active && (
            <Panel title="Run monitor" sub={`currently: ${watch?.mode || 'off'}`}>
              <div className="stack">
                <div className="small text-2">Flag problems as they appear, or stop the run on divergence. Stopping needs your permission.</div>
                <Check checked={watchAck} onChange={setWatchAck}>I allow the monitor to stop this run</Check>
                <div className="row">{['off', 'flag', 'stop', 'auto'].map((m) => <Button key={m} size="sm" variant={watch?.mode === m ? 'primary' : 'default'} disabled={(m === 'stop' || m === 'auto') && !watchAck} onClick={() => setWatch(m)}>{m}</Button>)}</div>
              </div>
            </Panel>
          )}
          {(d.notes || []).concat(d.caveats || []).map((n: string) => <Callout key={n} tone="info">{n}</Callout>)}
        </div>
      </div>
      <Confirm open={!!proposal} onClose={() => setProposal(null)} title="Review the trials" confirmLabel={mode === 'auto' ? 'Create and start' : 'Create session'} onConfirm={create} busy={busy === 'create'}>
        {proposal && (
          <div className="stack">
            {proposal.errors?.length > 0 && <Callout tone="danger" title="Cannot create">{proposal.errors.join(' ')}</Callout>}
            <KV items={[['Starts from', proposal.checkpoint ? `checkpoint step ${proposal.checkpoint.step} (${proposal.checkpoint.reason})` : 'original starting weights'], ['Steps per trial', fmt.num(proposal.trial_steps)], ['Estimated time', proposal.estimate_s ? fmt.dur(proposal.estimate_s) : 'unknown']]} />
            {proposal.trials.map((t: any) => <div key={t.id} className="stack-sm"><div className="row"><Badge tone={t.role === 'control' ? 'neutral' : 'info'}>{t.role}</Badge><b className="small">{t.title}</b></div><CodeBlock text={(t.argv || []).join(' ')} /></div>)}
            {proposal.notes?.map((n: string) => <Callout key={n} tone="warn">{n}</Callout>)}
          </div>
        )}
      </Confirm>
    </div>
  );
}

function SessionDetail({ id }: { id: string }) {
  const toast = useToast();
  const s = useLoad(() => trainer.optSession(id), [id], 4000);
  const runs = useLoad(() => trainer.runs(), [], 0);
  const [busy, setBusy] = useState('');
  if (s.error) return <ErrorState error={s.error} onRetry={s.reload} />;
  const x = s.data;
  if (!x) return <Loading />;
  const act = async (k: string, fn: () => Promise<any>, ok: string) => { setBusy(k); try { await fn(); toast.ok(ok); s.reload(); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  const trialRuns = x.trials.map((t: any) => t.run_id).filter(Boolean);
  return (
    <div className="stack" data-session={id}>
      <div className="row-between">
        <div className="row"><Link to="/optimization" className="btn btn-sm btn-ghost"><I.back />Optimisation</Link><h2 style={{ margin: 0, fontSize: 18 }}>{x.name}</h2><StatusBadge status={x.status} /><Badge>{x.mode}</Badge></div>
        <div className="row">
          {!['concluded', 'stopped'].includes(x.status) && <Button size="sm" variant="danger" icon={<I.stop />} busy={busy === 'stop'} onClick={() => act('stop', () => trainer.optStop(id), 'Session stopped')}>Stop session</Button>}
          {!['concluded'].includes(x.status) && <Button size="sm" busy={busy === 'conclude'} onClick={() => act('conclude', () => trainer.optConclude(id), 'Concluded')}>Conclude</Button>}
        </div>
      </div>
      {x.status_note && <Callout tone="info">{x.status_note}</Callout>}
      {x.recommendation?.headline && <Callout tone={x.recommendation.winner ? 'ok' : 'info'} title={x.recommendation.headline}>Ranked by {x.recommendation.metric}{x.recommendation.robot_based ? ' and robot success rate' : ''}. {x.recommendation.noise_note}</Callout>}
      <div className="grid g3">
        <div className="panel stat"><span className="label">Source run</span><span className="stat-value" style={{ fontSize: 16 }}><Link to={`/training/runs/${x.source_run_id}`}>{x.source_run_id}</Link></span></div>
        <div className="panel stat"><span className="label">Starts from</span><span className="stat-value" style={{ fontSize: 16 }}>{x.checkpoint ? `step ${x.checkpoint.step}` : 'original weights'}</span><span className="stat-foot">{fmt.num(x.trial_steps)} steps per trial</span></div>
        <div className="panel stat"><span className="label">GPU budget</span><span className="stat-value" style={{ fontSize: 18 }}>{fmt.dur(x.budget?.used_s)} / {fmt.dur(x.budget?.limit_s)}</span></div>
      </div>
      <Panel title="Trials" flush>
        <div className="table-wrap"><table className="table"><thead><tr><th>Trial</th><th>Change</th><th>Status</th><th>Run</th><th className="right">Result</th><th /></tr></thead>
          <tbody>{x.trials.map((t: any) => (
            <tr key={t.id} data-trial={t.id}><td><Badge tone={t.role === 'control' ? 'neutral' : 'info'}>{t.role}</Badge></td><td><div className="small">{t.title}</div><div className="tiny mono muted">{JSON.stringify(t.patch)}</div></td><td><StatusBadge status={t.status} /></td>
              <td className="small">{t.run_id ? <Link to={`/training/runs/${t.run_id}`}>{t.run_id}</Link> : '—'}</td>
              <td className="right num small">{t.result ? <>{fmt.sci(t.result.eval_best ?? t.result.final_loss)} <span className="muted">{t.result.eval_best != null ? 'val' : 'loss'} · {t.result.stability}</span></> : t.error ? <span style={{ color: 'var(--danger)' }}>{t.error}</span> : '—'}</td>
              <td>{x.mode === 'manual' && t.status === 'pending' && <Button size="sm" variant="primary" busy={busy === t.id} onClick={() => act(t.id, () => trainer.optLaunch(id, t.id, t.token), `${t.title} launched`)} data-launch={t.id}>Launch</Button>}</td></tr>
          ))}</tbody></table></div>
      </Panel>
      {trialRuns.length >= 2 && <Compare runs={(runs.data?.runs || []).filter((r: any) => trialRuns.includes(r.id) || r.id === x.source_run_id)} initial={trialRuns} />}
      <Panel title="Session log"><div className="timeline">{(x.events || []).slice().reverse().map((e: any, i: number) => <div key={i} className="timeline-item ok small">{e.msg || e.text || JSON.stringify(e)} <span className="muted">· {fmt.time(e.t)}</span></div>)}</div></Panel>
      <CodeBlock text={JSON.stringify(x.settings, null, 2)} />
    </div>
  );
}
