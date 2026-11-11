// MODULE 1: Dashboard. Every number comes from a backend: gateway health and host metrics,
// physical_ai_server (datasets, task status), pam_trainer (runs, sessions, rollouts).
import { data, gateway, PHASES } from '@/api/gateway';
import { trainer, ACTIVE_RUN } from '@/api/trainer';
import { Link } from '@/app/router';
import { useAvailability, useSystem } from '@/app/system';
import { Sparkline } from '@/design/charts';
import { I } from '@/design/icons';
import { Badge, Dot, Empty, Loading, Meter, Panel, Stat, StatusBadge, fmt, toneOf } from '@/design/ui';
import { useLoad } from '@/hooks/data';
import { useRef } from 'react';

/** The operations overview under the Home hero: live checks, hardware, training, datasets. */
export function Overview() {
  const { health, taskStatus, notices } = useSystem();
  const av = useAvailability();
  const sys = useLoad(() => gateway.system(), [], 3000);
  const runs = useLoad(() => trainer.runs(), [av.trainer], 5000, av.trainer);
  const sessions = useLoad(() => trainer.optSessions(), [av.trainer], 10000, av.trainer);
  const rollouts = useLoad(() => trainer.rollouts(), [av.trainer], 5000, av.trainer);
  const datasets = useLoad(async () => {
    if (av.ros) {
      const r = await data('data.list_datasets');
      return { source: 'physical_ai_server', list: r.datasets as any[] };
    }
    if (av.trainer) {
      const r = await trainer.datasets();
      return { source: 'training service', list: r.datasets as any[] };
    }
    return { source: 'none', list: [] as any[] };
  }, [av.ros, av.trainer], 15000, av.known);

  const cpuHist = useRef<number[]>([]);
  if (sys.data?.cpu_percent != null && cpuHist.current[cpuHist.current.length - 1] !== sys.data.cpu_percent) {
    cpuHist.current = [...cpuHist.current.slice(-59), sys.data.cpu_percent];
  }

  const runList: any[] = runs.data?.runs || [];
  const active = runList.filter((r) => ACTIVE_RUN.includes(r.status));
  const models = runList.filter((r) => r.status === 'succeeded');
  const dsList = datasets.data?.list || [];
  const episodes = dsList.reduce((a, d) => a + (d.total_episodes || 0), 0);
  const review = dsList.reduce((a, d) => {
    const c = d.review_counts || {};
    a.accepted += c.accepted || 0; a.rejected += c.rejected || 0; a.needs_review += c.needs_review || 0; a.unreviewed += c.unreviewed || 0;
    return a;
  }, { accepted: 0, rejected: 0, needs_review: 0, unreviewed: 0 });
  const phase = taskStatus?.phase ?? null;
  const taskActive = phase != null && phase !== 0 && phase !== 5;
  const s = sys.data;
  const gpus: any[] = s?.gpu?.gpus || [];
  const openSessions = (sessions.data?.sessions || []).filter((x: any) => !['concluded', 'stopped'].includes(x.status));

  return (
    <div className="stack" data-testid="overview">
      <div className="grid g4">
        <Stat label="System" value={health ? health.status : '—'} tone={health ? toneOf(health.status) : 'danger'} foot={health ? `${Object.values(health.services).filter((x) => x.status === 'ok').length}/${Object.keys(health.services).length} services OK` : 'gateway not reachable'} />
        <Stat label="Datasets" value={datasets.loading && !datasets.data ? '…' : fmt.num(dsList.length)} foot={`${fmt.num(episodes)} episodes · from ${datasets.data?.source || '—'}`} />
        <Stat label="Training" value={av.trainer ? fmt.num(active.length) : '—'} unit={av.trainer ? 'active' : undefined} foot={av.trainer ? `${models.length} finished model(s) · ${openSessions.length} optimisation session(s)` : 'training service offline'} tone={active.length ? 'info' : undefined} />
        <Stat label="Robot task" value={phase == null ? '—' : PHASES[phase]} tone={phase == null ? undefined : taskActive ? 'info' : 'ok'} foot={taskStatus ? `episode ${taskStatus.current_episode_number || 0}${taskStatus.task_info?.task_name ? ' · ' + taskStatus.task_info.task_name : ''}` : 'no /task/status from the robot'} />
      </div>

      <div className="grid g-side mt">
        <div className="stack">
          <Panel title="Services" sub="Live checks by the gateway every few seconds" icon={<I.layers width={17} height={17} />}>
            {!health ? <Loading rows={3} /> : (
              <div className="grid g3" data-testid="service-grid">
                {Object.entries(health.services).map(([k, v]) => (
                  <div key={k} className="panel" style={{ padding: 12, boxShadow: 'none' }} data-service-card={k} data-status={v.status}>
                    <div className="row-between"><span className="label">{k.replace('_', ' ')}</span><StatusBadge status={v.status} /></div>
                    <div className="small text-2" style={{ marginTop: 6 }}>{v.detail}</div>
                    {v.status !== 'ok' && v.hint && <div className="tiny muted" style={{ marginTop: 4 }}>{v.hint}</div>}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <div className="grid g2">
            <Panel title="Active training" actions={<Link to="/training" className="btn btn-sm btn-ghost">All runs<I.chevron /></Link>}>
              {!av.trainer ? <Empty icon={<I.link />} title="Training service offline">{av.hint('trainer')}</Empty>
                : runs.loading && !runs.data ? <Loading rows={2} />
                : active.length ? <div className="stack">{active.map((r) => {
                  const p = r.progress || {};
                  return (
                    <Link key={r.id} to={`/training/runs/${r.id}`} className="stack-sm" style={{ color: 'inherit' }}>
                      <div className="row-between"><b style={{ fontWeight: 600 }}>{r.job_name}</b><StatusBadge status={r.status} /></div>
                      <div className="progress"><span style={{ width: `${p.total ? (100 * p.step) / p.total : 0}%` }} /></div>
                      <div className="tiny muted">{fmt.num(p.step)} / {fmt.num(p.total)} steps · loss {fmt.sci(p.last?.loss)} · {r.policy} on {r.dataset}</div>
                    </Link>
                  );
                })}</div>
                : <Empty icon={<I.training />} title="No training running">{models.length ? `${models.length} finished model(s) available.` : 'Start one from the Training Studio.'}</Empty>}
            </Panel>
            <Panel title="Available models" sub="Finished local trainings" actions={<Link to="/training/evaluate" className="btn btn-sm btn-ghost">Evaluate<I.chevron /></Link>}>
              {!av.trainer ? <Empty icon={<I.link />} title="Training service offline" />
                : models.length ? <div className="list" style={{ margin: -16 }}>{models.slice(0, 6).map((r) => (
                  <Link key={r.id} to={`/training/runs/${r.id}`} className="list-item" style={{ color: 'inherit' }}>
                    <I.cube width={16} height={16} />
                    <div className="grow"><div className="ellipsis">{r.job_name}</div><div className="tiny muted">{r.policy} · {r.dataset} · {fmt.ago(r.finished_at)}</div></div>
                    <span className="tiny num muted">{fmt.num(r.progress?.step)} steps</span>
                  </Link>
                ))}</div>
                : <Empty icon={<I.cube />} title="No finished models yet" />}
            </Panel>
          </div>

          <Panel title="Dataset quality" sub="Episode review status across all datasets" actions={<Link to="/datasets" className="btn btn-sm btn-ghost">Library<I.chevron /></Link>}>
            {!dsList.length ? <Empty icon={<I.datasets />} title={datasets.loading ? 'Loading…' : 'No datasets found'}>{!av.ros && !av.trainer ? 'Needs the robot side or the training service.' : 'Record demonstrations in the Recording Studio.'}</Empty> : (
              <div className="stack">
                <div className="row" style={{ gap: 18 }}>
                  <span className="row" style={{ gap: 6 }}><Dot tone="ok" />{review.accepted} accepted</span>
                  <span className="row" style={{ gap: 6 }}><Dot tone="warn" />{review.needs_review} need review</span>
                  <span className="row" style={{ gap: 6 }}><Dot tone="danger" />{review.rejected} rejected</span>
                  <span className="row" style={{ gap: 6 }}><Dot />{review.unreviewed} unreviewed</span>
                </div>
                <div style={{ display: 'flex', height: 10, borderRadius: 99, overflow: 'hidden', background: 'var(--surface-3)' }}>
                  {[['accepted', 'var(--ok)'], ['needs_review', 'var(--warn)'], ['rejected', 'var(--danger)'], ['unreviewed', 'var(--line-strong)']].map(([k, c]) => {
                    const total = review.accepted + review.rejected + review.needs_review + review.unreviewed || 1;
                    return <span key={k} style={{ width: `${(100 * (review as any)[k]) / total}%`, background: c }} />;
                  })}
                </div>
                <div className="table-wrap"><table className="table"><thead><tr><th>Dataset</th><th>Robot</th><th className="right">Episodes</th><th>Integrity</th><th>Modified</th></tr></thead>
                  <tbody>{dsList.slice(0, 6).map((d) => (
                    <tr key={d.id}><td><Link to={`/datasets/${d.id}`}>{d.id}</Link></td><td className="mono small">{d.robot_type}</td><td className="right num">{d.total_episodes}</td><td><StatusBadge status={d.integrity === 'complete' || d.complete ? 'ok' : 'warn'} /></td><td className="small muted">{fmt.ago(d.modified)}</td></tr>
                  ))}</tbody></table></div>
              </div>
            )}
          </Panel>
        </div>

        <div className="stack">
          <Panel title="Hardware" sub={s ? `${s.os || ''} · ${s.machine || ''}` : undefined} icon={<I.cpu width={17} height={17} />}>
            {!s ? (sys.error ? <Empty icon={<I.link />} title="Gateway offline" /> : <Loading rows={4} />) : (
              <div className="stack">
                <div className="row-between">
                  <div><div className="label">CPU</div><div className="stat-value" style={{ fontSize: 20 }}>{s.cpu_percent == null ? '…' : `${s.cpu_percent}%`}</div><div className="tiny muted">{s.cpu_count} cores · load {s.load_avg ? s.load_avg[0].toFixed(2) : '—'}</div></div>
                  <Sparkline values={cpuHist.current} width={150} height={40} />
                </div>
                <Meter label="Memory" value={s.ram_total != null && s.ram_available != null ? s.ram_total - s.ram_available : null} max={s.ram_total} format={fmt.bytes} />
                {gpus.length ? gpus.map((g) => (
                  <div key={g.index} className="stack-sm">
                    <div className="row-between small"><span className="row" style={{ gap: 6 }}><I.gpu width={15} height={15} />{g.name}</span><span className="num">{g.utilization_pct ?? '—'}% util</span></div>
                    <Meter label="GPU memory" value={g.memory_used_mb != null ? g.memory_used_mb * 1048576 : null} max={g.memory_total_mb != null ? g.memory_total_mb * 1048576 : null} format={fmt.bytes} />
                  </div>
                )) : <div className="small muted row" style={{ gap: 6 }}><I.gpu width={15} height={15} />No GPU visible: {s.gpu?.reason || 'nvidia-smi reported none'}</div>}
                {(s.disks || []).slice(0, 3).map((d: any) => <Meter key={d.path} label={<span className="mono tiny ellipsis" title={d.path} style={{ maxWidth: 190, display: 'inline-block' }}>{d.path}</span>} value={d.used} max={d.total} format={fmt.bytes} />)}
                <div className="tiny muted">Up {fmt.dur(s.uptime_s)} · source: {s.source}</div>
              </div>
            )}
          </Panel>

          <Panel title="Recording & rollout">
            <div className="stack">
              <div className="row-between"><span className="text-2">Recording session</span>{taskActive && phase !== 6 ? <Badge tone="danger" dot>{PHASES[phase]}</Badge> : <Badge>idle</Badge>}</div>
              <div className="row-between"><span className="text-2">On-robot inference</span>{phase === 6 ? <Badge tone="warn" dot>running</Badge> : <Badge>idle</Badge>}</div>
              <div className="row-between"><span className="text-2">Host rollout</span>{rollouts.data?.active ? <StatusBadge status={rollouts.data.active.status} /> : <Badge>{av.trainer ? 'none' : 'unknown'}</Badge>}</div>
              {taskStatus?.used_storage_size != null && taskStatus.total_storage_size > 0 && (
                <Meter label="Robot storage" value={taskStatus.used_storage_size} max={taskStatus.total_storage_size} format={(v) => `${v.toFixed(1)} GB`} />
              )}
            </div>
          </Panel>

          <Panel title="Recent activity" flush>
            {notices.length ? (
              <div className="list" style={{ maxHeight: 360, overflowY: 'auto' }}>{notices.slice(0, 14).map((n) => (
                <div key={n.id} className="list-item" style={{ alignItems: 'flex-start', padding: '9px 16px' }}>
                  <Dot tone={n.level === 'error' ? 'danger' : n.level === 'warn' ? 'warn' : 'ok'} />
                  <div className="grow"><div className="small">{n.text}</div><div className="tiny muted">{n.source} · {fmt.ago(n.t)}</div></div>
                </div>
              ))}</div>
            ) : <Empty icon={<I.clock />} title="No activity yet" />}
          </Panel>
        </div>
      </div>
    </div>
  );
}
