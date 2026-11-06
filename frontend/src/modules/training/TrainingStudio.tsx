// MODULE 5: Local Training Studio. Training runs in pam_trainer (host, outside Docker, using
// the operator's LeRobot environment). Every start shows the exact command first; the
// trainer only accepts a start with the token of that preview.
import { useEffect, useMemo, useState } from 'react';
import { trainer, ACTIVE_RUN } from '@/api/trainer';
import { Link, useRouter } from '@/app/router';
import { LineChart } from '@/design/charts';
import { I } from '@/design/icons';
import {
  Badge, Button, Callout, CodeBlock, Confirm, Empty, ErrorState, Field, Input, KV, Loading, NumberInput, Panel, Progress,
  Segmented, Select, StatusBadge, Switch, Tabs, TextArea, fmt, useToast,
} from '@/design/ui';
import { useLoad } from '@/hooks/data';
import { Page, Requires } from '../shared';

export default function TrainingStudio({ view, runId }: { view?: 'new'; runId?: string }) {
  return (
    <Page>
      <Requires service="trainer" what="Training">
        {runId ? <RunDetail id={runId} /> : view === 'new' ? <NewTraining /> : <RunList />}
      </Requires>
    </Page>
  );
}

// ------------------------------------------------------------------------------- runs
function RunList() {
  const runs = useLoad(() => trainer.runs(), [], 4000);
  const queue = useLoad(() => trainer.queue(), [], 6000);
  const storage = useLoad(() => trainer.storage(), [], 0);
  const [q, setQ] = useState('');
  const list: any[] = (runs.data?.runs || []).filter((r: any) => !q || `${r.job_name} ${r.policy} ${r.dataset}`.toLowerCase().includes(q.toLowerCase()));
  const items: any[] = queue.data?.items || [];
  const ck: any[] = storage.data?.checkpoints || [];
  return (
    <div className="stack">
      <div className="row-between">
        <p className="page-intro" style={{ margin: 0 }}>Train policies on this PC with your LeRobot environment. Runs survive closing the browser; logs, metrics and checkpoints stay on disk.</p>
        <div className="row"><Input placeholder="Filter runs…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} /><Link to="/training/new" className="btn btn-primary" data-action="new-training"><I.plus />New training</Link></div>
      </div>
      <Panel title="Training runs" sub={`${list.length} run(s)`} flush>
        {runs.error ? <ErrorState error={runs.error} onRetry={runs.reload} /> : !runs.data ? <div style={{ padding: 16 }}><Loading rows={4} /></div> : !list.length ? <Empty icon={<I.training />} title="No training runs yet" action={<Link to="/training/new" className="btn btn-sm">Start a training</Link>} /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Run</th><th>Status</th><th>Policy</th><th>Dataset</th><th style={{ width: 200 }}>Progress</th><th className="right">Loss</th><th>Started</th></tr></thead>
            <tbody>{list.map((r) => {
              const p = r.progress || {};
              return (
                <tr key={r.id} className="clickable" data-run={r.id}>
                  <td><Link to={`/training/runs/${r.id}`}><b style={{ fontWeight: 600 }}>{r.job_name}</b></Link><div className="tiny muted mono">{r.id}</div></td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>{r.policy}</td>
                  <td className="small mono ellipsis" style={{ maxWidth: 220 }}>{r.dataset}</td>
                  <td><Progress value={p.step || 0} max={p.total || 1} tone={r.status === 'failed' ? 'danger' : undefined} /><div className="tiny muted num">{fmt.num(p.step)} / {fmt.num(p.total)}</div></td>
                  <td className="right num small">{fmt.sci(p.last?.loss)}</td>
                  <td className="small muted nowrap">{fmt.ago(r.created_at)}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Panel>
      <div className="grid g2">
        <Panel title="Queue" sub="Trainings start one after another; changed commands wait for review">
          {!items.length ? <Empty icon={<I.clock />} title="Queue is empty" /> : <div className="list" style={{ margin: -16 }}>{items.map((it) => (
            <div key={it.id} className="list-item"><div className="grow"><div>{it.job_name}</div><div className="tiny muted">{it.status} {it.reason ? `· ${it.reason}` : ''}</div></div><StatusBadge status={it.status} />
              {['queued', 'needs_review', 'held'].includes(it.status) && <Button size="sm" variant="ghost" onClick={() => trainer.queueAction(it.id, 'cancel').then(queue.reload)}>Cancel</Button>}</div>
          ))}</div>}
        </Panel>
        <Panel title="Checkpoint storage" sub={storage.data ? `${ck.length} checkpoint(s), ${fmt.bytes(ck.reduce((a, c) => a + (c.bytes || 0), 0))}` : undefined}>
          {!storage.data ? <Loading rows={2} /> : <div className="stack-sm small">{ck.slice(0, 6).map((c) => <div key={c.path} className="row-between"><span className="ellipsis">{c.job_name} · step {c.step}</span><span className="row" style={{ gap: 8 }}>{c.protected ? <Badge tone="ok">{c.reason}</Badge> : <span className="muted">{c.reason}</span>}<span className="num">{fmt.bytes(c.bytes)}</span></span></div>)}{!ck.length && <span className="muted">No checkpoints on disk.</span>}</div>}
        </Panel>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------- new training
const STEPS = ['Environment', 'Dataset', 'Model', 'Configure', 'Review'];

function NewTraining() {
  const { go, loc } = useRouter();
  const toast = useToast();
  const envs = useLoad(() => trainer.envs(), []);
  const dsets = useLoad(() => trainer.datasets(), []);
  const [step, setStep] = useState(0);
  const [env, setEnv] = useState('');
  const [dsPath, setDsPath] = useState('');
  const [policy, setPolicy] = useState('');
  const [cfg, setCfg] = useState<any>({ train: { steps: 20000, batch_size: 8, lr: 1e-4, log_freq: 100, save_freq: 5000, num_workers: 4, seed: 1000, device: 'cuda' }, policy_params: {}, episodes: 'exclude_rejected', job_name: '', validation: { enabled: false, eval_split: 0.1 }, advanced: {} });
  const [advText, setAdvText] = useState('');
  const [plan, setPlan] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const envList: any[] = envs.data?.envs || [];
  const dsList: any[] = dsets.data?.datasets || [];
  const models = useLoad(() => trainer.models(env, dsPath), [env, dsPath], 0, !!env && !!dsPath);
  const modelList: any[] = models.data?.models || [];
  useEffect(() => { if (!env && envList.length) setEnv((envList.find((e) => e.lerobot_train) || envList[0]).name); }, [envList, env]);
  useEffect(() => {
    const want = loc.query.get('dataset');
    if (want && !dsPath) { const d = dsList.find((x) => x.id === want); if (d) setDsPath(d.path); }
  }, [dsList, loc.query, dsPath]);
  const chooseModel = (m: any) => {
    setPolicy(m.id);
    const ds = dsList.find((d) => d.path === dsPath);
    setCfg((c: any) => ({ ...c, ...(m.defaults || {}), train: { ...c.train, ...(m.defaults?.train || {}) }, policy_params: { ...(m.defaults?.policy_params || {}) }, job_name: `${ds?.name || 'dataset'}_${m.id}` }));
  };
  const fullCfg = () => {
    const advanced: Record<string, string> = {};
    advText.split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => { const i = l.indexOf('='); if (i > 0) advanced[l.slice(0, i).trim().replace(/^--/, '')] = l.slice(i + 1).trim(); });
    return { ...cfg, advanced, env, dataset_path: dsPath, policy };
  };
  const review = async () => {
    setBusy('plan');
    try { setPlan(await trainer.plan(fullCfg())); setStep(4); } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const start = async (queue = false) => {
    setBusy(queue ? 'queue' : 'start');
    try {
      if (queue) { await trainer.enqueue(fullCfg(), plan.token); toast.ok('Added to the queue'); go('/training'); }
      else { const r = await trainer.start(fullCfg(), plan.token); toast.ok('Training started'); go(`/training/runs/${r.id || r.run?.id}`); }
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const setTrain = (p: any) => setCfg((c: any) => ({ ...c, train: { ...c.train, ...p } }));
  const envSel = envList.find((e) => e.name === env);
  const ds = dsList.find((d) => d.path === dsPath);
  const canNext = [!!envSel?.lerobot_train, !!dsPath, !!policy, true, false][step];

  return (
    <div className="stack" data-testid="new-training">
      <div className="row-between">
        <Link to="/training" className="btn btn-sm btn-ghost"><I.back />Runs</Link>
        <div className="steps">{STEPS.map((s, i) => <div key={s} className={`step ${i < step ? 'done' : i === step ? 'active' : ''}`}><b>{i < step ? '✓' : i + 1}</b>{s}</div>)}</div>
      </div>

      {step === 0 && (
        <Panel title="Python environment" sub="Where lerobot-train runs (conda environments are discovered automatically)" actions={<Button size="sm" icon={<I.refresh />} onClick={() => trainer.envs(true).then(envs.setData)}>Re-scan</Button>}>
          {envs.error ? <ErrorState error={envs.error} /> : !envs.data ? <Loading label="Probing environments…" /> : !envList.length ? <Empty title="No Python environments found">Install LeRobot in a conda environment, or start pam_trainer with --env NAME=PREFIX.</Empty> : (
            <div className="grid g3">{envList.map((e) => (
              <button key={e.name} className="panel" style={{ padding: 14, textAlign: 'left', cursor: 'pointer', borderColor: env === e.name ? 'var(--accent)' : undefined }} onClick={() => setEnv(e.name)} data-env={e.name}>
                <div className="row-between"><b>{e.name}</b>{e.lerobot_train ? <Badge tone="ok">can train</Badge> : <Badge tone="danger">no lerobot-train</Badge>}</div>
                <div className="tiny muted mono ellipsis">{e.prefix}</div>
                <div className="small text-2" style={{ marginTop: 6 }}>LeRobot {e.packages?.lerobot || '—'} · torch {e.packages?.torch || '—'} · {e.cuda_available ? `CUDA ${e.gpu?.name || ''}` : 'CPU only'}</div>
              </button>
            ))}</div>
          )}
        </Panel>
      )}

      {step === 1 && (
        <Panel title="Dataset" sub="Recorded datasets visible to the training service" flush>
          {!dsList.length ? <Empty icon={<I.datasets />} title="No datasets" /> : (
            <div className="table-wrap"><table className="table"><thead><tr><th /><th>Dataset</th><th>Format</th><th className="right">Episodes</th><th>Rejected</th><th>Cameras</th></tr></thead>
              <tbody>{dsList.map((d) => (
                <tr key={d.path} className="clickable" aria-selected={dsPath === d.path} onClick={() => setDsPath(d.path)} data-train-dataset={d.id}>
                  <td><input type="radio" checked={dsPath === d.path} readOnly /></td>
                  <td><b style={{ fontWeight: 600 }}>{d.id}</b><div className="tiny muted mono">{d.root}</div></td>
                  <td><Badge>{d.codebase_version}</Badge></td><td className="right num">{d.total_episodes}</td>
                  <td>{(d.rejected_indices || []).length || 0}</td>
                  <td className="small">{(d.cameras || []).map((c: any) => (c.key || c).toString().replace('observation.images.', '')).join(', ')}</td>
                </tr>
              ))}</tbody></table></div>
          )}
        </Panel>
      )}

      {step === 2 && (
        <Panel title="Policy" sub={`Compatibility checked against ${ds?.id} and ${env}`}>
          {models.error ? <ErrorState error={models.error} /> : !models.data ? <Loading label="Reading lerobot-train capabilities…" /> : (
            <div className="grid g2">{modelList.map((m) => (
              <button key={m.id} className="panel" style={{ padding: 14, textAlign: 'left', cursor: m.status === 'blocked' ? 'not-allowed' : 'pointer', opacity: m.status === 'blocked' ? 0.6 : 1, borderColor: policy === m.id ? 'var(--accent)' : undefined }}
                onClick={() => m.status !== 'blocked' && chooseModel(m)} data-model={m.id}>
                <div className="row-between"><b>{m.name}</b><span className="row">{m.recommended && <Badge tone="accent">recommended</Badge>}<StatusBadge status={m.status} /></span></div>
                <div className="small text-2" style={{ marginTop: 6 }}>{m.summary}</div>
                <div className="tiny muted" style={{ marginTop: 6 }}>{m.language ? 'Uses the language instruction · ' : ''}≈{fmt.num(m.est_vram_mb?.['8'] || m.min_vram_mb)} MB GPU at batch 8</div>
                {(m.reasons || []).map((r: string) => <div key={r} className="tiny" style={{ color: m.status === 'blocked' ? 'var(--danger)' : 'var(--warn)', marginTop: 4 }}>• {r}</div>)}
              </button>
            ))}</div>
          )}
        </Panel>
      )}

      {step === 3 && (
        <div className="grid g2">
          <Panel title="Training settings">
            <div className="stack">
              <Field label="Job name" hint="Letters, digits, _ - ."><Input value={cfg.job_name} onChange={(e) => setCfg({ ...cfg, job_name: e.target.value })} data-field="job-name" /></Field>
              <div className="grid g3">
                <Field label="Steps"><NumberInput value={cfg.train.steps} onChange={(v) => setTrain({ steps: v })} data-field="steps" /></Field>
                <Field label="Batch size"><NumberInput value={cfg.train.batch_size} onChange={(v) => setTrain({ batch_size: v })} /></Field>
                <Field label="Learning rate"><Input className="mono" value={String(cfg.train.lr)} onChange={(e) => setTrain({ lr: e.target.value })} data-field="lr" /></Field>
                <Field label="Log every"><NumberInput value={cfg.train.log_freq} onChange={(v) => setTrain({ log_freq: v })} data-field="log-freq" /></Field>
                <Field label="Checkpoint every"><NumberInput value={cfg.train.save_freq} onChange={(v) => setTrain({ save_freq: v })} /></Field>
                <Field label="Data workers"><NumberInput value={cfg.train.num_workers} onChange={(v) => setTrain({ num_workers: v })} /></Field>
                <Field label="Seed"><NumberInput value={cfg.train.seed} onChange={(v) => setTrain({ seed: v })} data-field="seed" /></Field>
                <Field label="Device"><Select value={cfg.train.device} onChange={(v) => setTrain({ device: v })} options={['cuda', 'cpu']} /></Field>
              </div>
              <Field label="Episodes"><Segmented value={cfg.episodes} onChange={(v) => setCfg({ ...cfg, episodes: v })} options={[{ value: 'exclude_rejected', label: 'All except rejected' }, { value: 'accepted_only', label: 'Accepted only' }, { value: 'all', label: 'All' }]} /></Field>
            </div>
          </Panel>
          <div className="stack">
            <Panel title="Validation" sub="Hold out episodes and report validation loss (needs --dataset.eval_split support)">
              <div className="stack">
                <Switch checked={!!cfg.validation.enabled} onChange={(v) => setCfg({ ...cfg, validation: { ...cfg.validation, enabled: v } })} label="Hold out validation episodes" />
                {cfg.validation.enabled && <div className="grid g2">
                  <Field label="Fraction held out"><NumberInput value={cfg.validation.eval_split} step={0.05} onChange={(v) => setCfg({ ...cfg, validation: { ...cfg.validation, eval_split: v } })} /></Field>
                  <Field label="Evaluate every (steps)"><NumberInput value={cfg.validation.eval_steps} onChange={(v) => setCfg({ ...cfg, validation: { ...cfg.validation, eval_steps: v } })} placeholder="auto" /></Field>
                </div>}
              </div>
            </Panel>
            <Panel title="Policy parameters" sub={`Defaults for ${policy}; change only what you understand`}>
              <div className="grid g2">{Object.entries(cfg.policy_params || {}).map(([k, v]) => (
                <Field key={k} label={<span className="mono">{k}</span>}><Input className="mono" value={String(v)} onChange={(e) => setCfg({ ...cfg, policy_params: { ...cfg.policy_params, [k]: e.target.value } })} /></Field>
              ))}{!Object.keys(cfg.policy_params || {}).length && <span className="small muted">No policy-specific defaults.</span>}</div>
            </Panel>
            <Panel title="Advanced flags" sub="One --flag=value per line, checked against this lerobot-train --help">
              <TextArea className="mono" rows={4} value={advText} onChange={(e) => setAdvText(e.target.value)} placeholder="policy.optimizer_weight_decay=1e-4" />
            </Panel>
          </div>
        </div>
      )}

      {step === 4 && plan && (
        <div className="grid g-side">
          <div className="stack">
            {plan.errors?.length > 0 && <Callout tone="danger" title="This command cannot start">{plan.errors.map((e: string) => <div key={e}>• {e}</div>)}</Callout>}
            {plan.warnings?.length > 0 && <Callout tone="warn" title="Warnings">{plan.warnings.map((e: string) => <div key={e}>• {e}</div>)}</Callout>}
            <Panel title="Exactly what will run" sub="Each stage runs in order; the recorded dataset is never modified">
              <div className="stack">{(plan.stages || []).map((s: any, i: number) => (
                <div key={i} className="stack-sm"><div className="row"><Badge tone="info">{i + 1}. {s.kind}</Badge><span className="small text-2">{s.desc}</span></div><CodeBlock text={(s.argv || []).join(' \\\n  ')} /></div>
              ))}</div>
            </Panel>
          </div>
          <Panel title="Summary">
            <div className="stack">
              <KV items={[['Policy', plan.policy], ['Dataset', plan.dataset?.id || ds?.id], ['Output', <span className="mono tiny">{plan.output_dir}</span>], ['Episodes used', plan.resources?.episodes_used],
                ['GPU estimate', plan.resources?.gpu_estimate_mb ? `${fmt.num(plan.resources.gpu_estimate_mb)} MB of ${fmt.num(plan.resources.gpu_available_mb)} MB` : '—'],
                ['Disk', plan.storage ? `${fmt.bytes(plan.storage.estimate_bytes || plan.storage.needed_bytes)} needed` : '—']]} />
              {plan.busy && <Callout tone="warn" title="Another training is running">Only one training runs at a time; add this one to the queue.</Callout>}
              <div className="row">
                <Button variant="primary" icon={<I.play />} disabled={!plan.ok || !!plan.busy} busy={busy === 'start'} onClick={() => start(false)} data-action="start-training">Start training</Button>
                <Button icon={<I.clock />} disabled={!plan.ok} busy={busy === 'queue'} onClick={() => start(true)}>Add to queue</Button>
              </div>
            </div>
          </Panel>
        </div>
      )}

      <div className="row-between">
        <Button disabled={step === 0} icon={<I.back />} onClick={() => setStep(step - 1)}>Back</Button>
        {step < 3 && <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)} data-action="next">Next<I.chevron /></Button>}
        {step === 3 && <Button variant="primary" busy={busy === 'plan'} onClick={review} data-action="review">Review command<I.chevron /></Button>}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- run detail
type RunTab = 'metrics' | 'log' | 'checkpoints' | 'config';
export function RunDetail({ id }: { id: string }) {
  const toast = useToast();
  const run = useLoad(() => trainer.run(id), [id], 3000);
  const r = run.data;
  const active = r && ACTIVE_RUN.includes(r.status);
  const metrics = useLoad(() => trainer.metrics(id), [id], active ? 5000 : 0);
  const res = useLoad(() => trainer.resources(id), [id], active ? 10000 : 0);
  const [tab, setTab] = useState<RunTab>('metrics');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState('');
  const act = async (a: 'stop' | 'pause' | 'resume') => { setBusy(a); try { await trainer.runAction(id, a); toast.ok(`${a} sent`); run.reload(); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  if (run.error) return <ErrorState error={run.error} onRetry={run.reload} />;
  if (!r) return <Loading />;
  const p = r.progress || {};
  const tr: any[] = metrics.data?.train || [];
  const ev: any[] = metrics.data?.eval || [];
  const s = (k: string) => tr.filter((x) => x[k] != null).map((x) => [x.step, x[k]] as [number, number]);
  const gpu: any[] = res.data?.rows || [];
  return (
    <div className="stack" data-run-detail={id}>
      <div className="row-between">
        <div className="row"><Link to="/training" className="btn btn-sm btn-ghost"><I.back />Runs</Link><h2 style={{ margin: 0, fontSize: 18 }}>{r.job_name}</h2><StatusBadge status={r.status} /></div>
        <div className="row">
          {r.status === 'training' && <Button size="sm" icon={<I.pause />} busy={busy === 'pause'} onClick={() => act('pause')}>Pause</Button>}
          {r.status === 'paused' && <Button size="sm" icon={<I.play />} busy={busy === 'resume'} onClick={() => act('resume')}>Resume</Button>}
          {active && <Button size="sm" variant="danger" icon={<I.stop />} onClick={() => setConfirm('stop')}>Stop</Button>}
          <Link to={`/optimization/runs/${id}`} className="btn btn-sm"><I.optimize />Diagnose</Link>
        </div>
      </div>
      {r.error && <Callout tone="danger" title="Run error">{r.error}</Callout>}
      {(r.parser?.error_tail || []).length > 0 && r.status === 'failed' && <CodeBlock text={r.parser.error_tail.join('\n')} />}
      <div className="grid g4">
        <div className="panel stat"><span className="label">Progress</span><span className="stat-value">{p.total ? Math.round((100 * p.step) / p.total) : 0}<small>%</small></span><Progress value={p.step || 0} max={p.total || 1} /><span className="stat-foot num">{fmt.num(p.step)} / {fmt.num(p.total)} steps</span></div>
        <div className="panel stat"><span className="label">Loss</span><span className="stat-value">{fmt.sci(p.last?.loss)}</span><span className="stat-foot">grad norm {fmt.sci(p.last?.grdn)} · lr {fmt.sci(p.last?.lr)}</span></div>
        <div className="panel stat"><span className="label">Validation loss</span><span className="stat-value">{ev.length ? fmt.sci(ev[ev.length - 1].eval_loss) : '—'}</span><span className="stat-foot">{ev.length ? `${ev.length} evaluations` : 'validation off'}</span></div>
        <div className="panel stat"><span className="label">GPU memory</span><span className="stat-value">{(() => { const g = r.resources_now?.gpu || gpu[gpu.length - 1]?.gpu; return g?.memory_used_mb != null ? fmt.num(g.memory_used_mb) : '—'; })()}<small>MB</small></span><span className="stat-foot">{r.policy || r.plan?.policy} · {r.env?.name}</span></div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'metrics', label: 'Metrics' }, { id: 'log', label: 'Log' }, { id: 'checkpoints', label: 'Checkpoints' }, { id: 'config', label: 'Configuration' }]} />
      {tab === 'metrics' && (
        <div className="grid g2">
          <Panel title="Loss" sub="training (solid) and validation (dashed)"><LineChart series={[{ name: 'train loss', points: s('loss') }, ...(ev.length ? [{ name: 'validation loss', points: ev.map((e) => [e.step, e.eval_loss] as [number, number]), dashed: true }] : [])]} log xLabel="step" /></Panel>
          <Panel title="Learning rate"><LineChart series={[{ name: 'lr', points: s('lr') }]} xLabel="step" yFormat={fmt.sci} /></Panel>
          <Panel title="Gradient norm" sub="before clipping"><LineChart series={[{ name: 'grad norm', points: s('grdn') }]} log xLabel="step" /></Panel>
          <Panel title="GPU memory and utilisation" sub="whole GPU, sampled by the training service"><LineChart series={[
            { name: 'memory MB', points: gpu.filter((g) => g.gpu?.memory_used_mb != null).map((g) => [(g.t - gpu[0].t) / 60, g.gpu.memory_used_mb] as [number, number]) },
          ]} xLabel="minutes since start" /></Panel>
        </div>
      )}
      {tab === 'log' && <LogTail id={id} active={!!active} />}
      {tab === 'checkpoints' && <Checkpoints id={id} />}
      {tab === 'config' && <RunConfig run={r} onSaved={run.reload} />}
      <Confirm open={confirm === 'stop'} onClose={() => setConfirm('')} danger title="Stop training" confirmLabel="Stop" busy={busy === 'stop'}
        onConfirm={() => { setConfirm(''); act('stop'); }}>The process is stopped; checkpoints already written stay usable and the run can be resumed from the last one.</Confirm>
    </div>
  );
}

function LogTail({ id, active }: { id: string; active: boolean }) {
  const log = useLoad(() => trainer.log(id, -1, 65536), [id], active ? 3000 : 0);
  const text = log.data?.text ?? log.data?.lines?.join('\n') ?? (typeof log.data === 'string' ? log.data : '');
  return <Panel title="Output" sub={active ? 'refreshes every 3 s' : undefined} actions={<Button size="sm" variant="ghost" icon={<I.refresh />} onClick={log.reload}>Refresh</Button>}>{log.error ? <ErrorState error={log.error} /> : <pre className="code log">{text || 'No output yet.'}</pre>}</Panel>;
}

function Checkpoints({ id }: { id: string }) {
  const toast = useToast();
  const ck = useLoad(() => trainer.checkpoints(id), [id]);
  const rows: any[] = ck.data?.checkpoints || ck.data?.rows || [];
  if (ck.error) return <ErrorState error={ck.error} />;
  if (!ck.data) return <Loading rows={3} />;
  return (
    <Panel flush title={`${rows.length} checkpoint(s)`}>
      {!rows.length ? <Empty title="No checkpoints written yet" /> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>Step</th><th>Policy</th><th>Size</th><th>Path</th><th>Kept</th><th /></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.step}><td className="num">{fmt.num(c.step)} {c.is_last && <Badge tone="accent">last</Badge>}</td><td>{c.policy_type}</td><td className="num">{fmt.bytes(c.size_bytes)}</td><td className="mono tiny ellipsis" style={{ maxWidth: 320 }} title={c.path}>{c.path}</td>
              <td><Switch checked={!!c.keep} onChange={(v) => trainer.keep(id, c.step, v).then(ck.reload, toast.error)} /></td>
              <td className="nowrap"><Button size="sm" variant="ghost" icon={<I.download />} onClick={() => trainer.exportCkpt(id, c.step).then((r: any) => toast.ok(`Exported to ${r.path || r.dest || 'the export folder'}`), toast.error)}>Export</Button>
                <Link to={`/inference?run=${id}&step=${c.step}`} className="btn btn-sm btn-ghost">Use</Link></td></tr>
          ))}</tbody></table></div>
      )}
    </Panel>
  );
}

function RunConfig({ run, onSaved }: { run: any; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(run.job_name || '');
  const [notes, setNotes] = useState(run.notes || '');
  const argv = useMemo(() => (run.plan?.stages || []).map((s: any) => (s.argv || []).join(' ')).join('\n\n'), [run]);
  return (
    <div className="grid g2">
      <Panel title="Notes" footer={<Button size="sm" variant="primary" onClick={() => trainer.metadata(run.id, name, notes).then(() => { toast.ok('Saved'); onSaved(); }, toast.error)}>Save</Button>}>
        <div className="stack"><Field label="Display name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field><Field label="Notes"><TextArea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field></div>
      </Panel>
      <Panel title="Configuration">
        <KV items={[['Environment', run.env?.name], ['LeRobot', run.env?.lerobot], ['Output', <span className="mono tiny">{run.output_dir}</span>], ['Created', fmt.time(run.created_at)], ['Finished', fmt.time(run.finished_at)], ['Resume of', run.resume_of || '—']]} />
        <div className="mt"><CodeBlock text={argv || JSON.stringify(run.config, null, 2)} /></div>
      </Panel>
    </div>
  );
}
