// MODULE 4: Dataset Library. Reads the recorder's LeRobot datasets in place (no new format):
// listings/episodes/reviews from physical_ai_server (data.*), video and export from the
// gateway's read-only dataset files, health analysis from the training service.
import { useEffect, useMemo, useRef, useState } from 'react';
import { data, files, planning, ros } from '@/api/gateway';
import { trainer } from '@/api/trainer';
import { Link, useRouter } from '@/app/router';
import { useAvailability } from '@/app/system';
import { LineChart } from '@/design/charts';
import { I } from '@/design/icons';
import {
  Badge, Button, Callout, Check, Confirm, Empty, ErrorState, Field, Input, KV, Loading, Panel, Progress, Segmented,
  Select, StatusBadge, Switch, Tabs, fmt, useToast,
} from '@/design/ui';
import { useLoad, useTopic } from '@/hooks/data';
import { Page } from '../shared';

export default function DatasetLibrary({ datasetId }: { datasetId?: string }) {
  return datasetId ? <DatasetDetail id={datasetId} /> : <DatasetList />;
}

function useDatasetList() {
  const av = useAvailability();
  return useLoad(async () => {
    if (av.ros) return { source: 'ros' as const, list: (await data('data.list_datasets')).datasets as any[] };
    if (av.trainer) return { source: 'trainer' as const, list: (await trainer.datasets()).datasets as any[] };
    throw Object.assign(new Error('Neither the robot side nor the training service is reachable.'), { code: 'network', hint: 'Start physical_ai_server (ROS) or pam_trainer.' });
  }, [av.ros, av.trainer], 20000, av.known);
}

function DatasetList() {
  const ds = useDatasetList();
  const [q, setQ] = useState('');
  const list = (ds.data?.list || []).filter((d) => !q || d.id.toLowerCase().includes(q.toLowerCase()));
  return (
    <Page intro="Every LeRobot dataset recorded on this robot PC, read in place. Review episodes, check quality, publish or export; the files stay in their LeRobot format."
      actions={<><Input placeholder="Filter datasets…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} /><Button icon={<I.refresh />} onClick={ds.reload}>Refresh</Button></>}>
      {ds.data?.source === 'trainer' && <div style={{ marginBottom: 12 }}><Callout tone="warn" title="Read-only listing">The robot side is offline, so this list comes from the training service. Reviews, episode details and publishing need physical_ai_server.</Callout></div>}
      <Panel flush>
        {ds.error ? <ErrorState error={ds.error} onRetry={ds.reload} /> : ds.loading && !ds.data ? <div style={{ padding: 16 }}><Loading rows={4} /></div> : !list.length ? <Empty icon={<I.datasets />} title="No datasets">Recorded datasets appear here automatically.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Dataset</th><th>Robot</th><th>Format</th><th className="right">Episodes</th><th className="right">Frames</th><th>Review</th><th>Integrity</th><th>Plans</th><th>Modified</th></tr></thead>
            <tbody>{list.map((d) => {
              const c = d.review_counts || {};
              return (
                <tr key={d.id} data-dataset={d.id}>
                  <td><Link to={`/datasets/${d.id}`}><b style={{ fontWeight: 600 }}>{d.name}</b></Link><div className="tiny muted">{d.owner}</div></td>
                  <td className="mono small">{d.robot_type}</td>
                  <td><Badge>{d.codebase_version}</Badge></td>
                  <td className="right num">{d.total_episodes}</td>
                  <td className="right num">{fmt.num(d.total_frames)}</td>
                  <td className="small">{c.total != null ? <span className="row" style={{ gap: 8 }}><span style={{ color: 'var(--ok)' }}>{c.accepted}✓</span><span style={{ color: 'var(--warn)' }}>{c.needs_review}?</span><span style={{ color: 'var(--danger)' }}>{c.rejected}✗</span><span className="muted">{c.unreviewed} new</span></span> : d.rejected_episodes ? `${d.rejected_episodes.length} rejected` : '—'}</td>
                  <td><StatusBadge status={(d.integrity || (d.complete ? 'complete' : 'incomplete')) === 'complete' ? 'ok' : 'warn'} /></td>
                  <td className="small">{(d.plans || []).map((p: any) => <Link key={p.id} to={`/planning/${p.id}`} className="badge">{p.name}</Link>)}</td>
                  <td className="small muted nowrap">{fmt.ago(d.modified)}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Panel>
    </Page>
  );
}

type Tab = 'episodes' | 'viewer' | 'quality' | 'publish' | 'export';

function DatasetDetail({ id }: { id: string }) {
  const av = useAvailability();
  const { loc, go } = useRouter();
  const ov = useLoad(() => data('data.overview', { dataset_id: id }), [id, av.ros], 0, av.ros);
  const eps = useLoad(() => data('data.episodes', { dataset_id: id }), [id, av.ros], 0, av.ros);
  const tab = (loc.query.get('tab') as Tab) || 'episodes';
  const epIndex = loc.query.get('ep') != null ? Number(loc.query.get('ep')) : null;
  const setTab = (t: Tab, ep?: number) => go(`/datasets/${id}?tab=${t}${ep != null ? `&ep=${ep}` : epIndex != null ? `&ep=${epIndex}` : ''}`, true);
  if (!av.ros && av.known) {
    return <Page><Panel><Empty icon={<I.link />} title="Robot side disconnected" action={<Link to="/datasets" className="btn btn-sm">Back</Link>}>Episode details, reviews and publishing are read by physical_ai_server. {av.hint('ros_node')}</Empty></Panel></Page>;
  }
  const o = ov.data;
  return (
    <Page>
      <div className="row" style={{ marginBottom: 14 }}>
        <Link to="/datasets" className="btn btn-sm btn-ghost"><I.back />Datasets</Link>
        <h2 style={{ margin: 0, fontSize: 18 }} className="mono">{id}</h2>
        {o && <><Badge>{o.codebase_version}</Badge><Badge>{o.robot_type}</Badge><Badge>{o.fps} fps</Badge></>}
      </div>
      {ov.error ? <ErrorState error={ov.error} onRetry={ov.reload} /> : !o ? <Loading /> : (
        <>
          <div className="grid g4">
            <div className="panel stat"><span className="label">Episodes</span><span className="stat-value">{o.total_episodes}</span><span className="stat-foot">{fmt.num(o.total_frames)} frames</span></div>
            <div className="panel stat"><span className="label">Duration</span><span className="stat-value">{fmt.dur(o.duration_s)}</span><span className="stat-foot">{fmt.bytes(o.size_bytes)} on disk</span></div>
            <div className="panel stat"><span className="label">Cameras</span><span className="stat-value">{o.cameras?.length ?? 0}</span><span className="stat-foot ellipsis">{(o.cameras || []).map((c: any) => c.key.split('.').pop()).join(', ')}</span></div>
            <ReviewStat eps={eps.data?.episodes} />
          </div>
          <div className="mt" />
          <Tabs value={tab} onChange={(t) => setTab(t)} tabs={[{ id: 'episodes', label: 'Episodes' }, { id: 'viewer', label: 'Episode viewer' }, { id: 'quality', label: 'Validation' }, { id: 'publish', label: 'Publish' }, { id: 'export', label: 'Export' }]} />
          {tab === 'episodes' && <EpisodeTable id={id} eps={eps} onOpen={(i) => setTab('viewer', i)} />}
          {tab === 'viewer' && <EpisodeViewer id={id} overview={o} eps={eps.data?.episodes || []} index={epIndex ?? eps.data?.episodes?.[0]?.episode_index ?? 0} onIndex={(i) => setTab('viewer', i)} onReviewed={eps.reload} />}
          {tab === 'quality' && <Quality id={id} overview={o} />}
          {tab === 'publish' && <Publish id={id} />}
          {tab === 'export' && <Export id={id} overview={o} />}
        </>
      )}
    </Page>
  );
}

function ReviewStat({ eps }: { eps?: any[] }) {
  const c = { accepted: 0, rejected: 0, needs_review: 0, none: 0 };
  (eps || []).forEach((e) => { const s = e.review?.status as keyof typeof c; c[s && s in c ? s : 'none']++; });
  return <div className="panel stat"><span className="label">Review</span><span className="stat-value">{c.accepted}<small>accepted</small></span><span className="stat-foot">{c.needs_review} need review · {c.rejected} rejected · {c.none} unreviewed</span></div>;
}

function EpisodeTable({ id, eps, onOpen }: { id: string; eps: ReturnType<typeof useLoad<any>>; onOpen: (i: number) => void }) {
  const toast = useToast();
  const [filter, setFilter] = useState('all');
  const [sel, setSel] = useState<number[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [job, setJob] = useState<any>(null);
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const t = setInterval(async () => {
      try { const j = await data('job.status', { job_id: job.id }); setJob(j); if (j.status !== 'running') { eps.reload(); setSel([]); j.status === 'done' ? toast.ok('Episodes deleted') : toast.error(j.message); } } catch (e) { toast.error(e); setJob(null); }
    }, 1000);
    return () => clearInterval(t);
  }, [job, eps, toast]);
  if (eps.error) return <ErrorState error={eps.error} onRetry={eps.reload} />;
  if (!eps.data) return <Loading rows={5} />;
  const all: any[] = eps.data.episodes || [];
  const list = all.filter((e) => filter === 'all' || (filter === 'unreviewed' ? !e.review?.status : e.review?.status === filter));
  const bulk = async (status: string) => {
    for (const i of sel) await data('data.review', { dataset_id: id, episode_index: i, status }).catch((e) => toast.error(e));
    toast.ok(`${sel.length} episode(s) marked ${status.replace('_', ' ')}`);
    setSel([]); eps.reload();
  };
  return (
    <Panel flush title={`${list.length} episode(s)`} actions={
      <div className="row">
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'unreviewed', label: 'Unreviewed' }, { value: 'accepted', label: 'Accepted' }, { value: 'needs_review', label: 'Needs review' }, { value: 'rejected', label: 'Rejected' }]} />
        {sel.length > 0 && <><Button size="sm" onClick={() => bulk('accepted')}>Accept {sel.length}</Button><Button size="sm" onClick={() => bulk('rejected')}>Reject {sel.length}</Button><Button size="sm" variant="ghost" icon={<I.trash />} onClick={() => setConfirm(true)}>Delete</Button></>}
      </div>}>
      {job?.status === 'running' && <div style={{ padding: 12 }}><Progress value={job.progress} max={job.total || 1} /><div className="tiny muted">{job.message}</div></div>}
      <div className="table-wrap" style={{ maxHeight: 640 }}><table className="table">
        <thead><tr><th style={{ width: 30 }}><input type="checkbox" checked={sel.length === list.length && list.length > 0} onChange={(e) => setSel(e.target.checked ? list.map((x) => x.episode_index) : [])} /></th><th>#</th><th>Length</th><th>Task</th><th>Plan episode</th><th>Checks</th><th>Review</th><th /></tr></thead>
        <tbody>{list.map((e) => (
          <tr key={e.episode_index} data-ep={e.episode_index}>
            <td><input type="checkbox" checked={sel.includes(e.episode_index)} onChange={(ev) => setSel(ev.target.checked ? [...sel, e.episode_index] : sel.filter((x) => x !== e.episode_index))} /></td>
            <td className="num">{e.episode_index}</td>
            <td className="num small">{fmt.dur(e.duration_s)} <span className="muted">({e.length} fr)</span></td>
            <td className="small ellipsis" style={{ maxWidth: 260 }}>{(e.tasks || []).join(' · ')}</td>
            <td className="small">{e.plan ? <Link to={`/planning/${e.plan.plan_id}`}>{e.plan.plan_name} · {e.plan.episode_id}</Link> : <span className="muted">—</span>}{e.binding_stale && <Badge tone="warn">stale</Badge>}</td>
            <td>{e.validation ? <StatusBadge status={e.validation.ok ? 'ok' : 'warn'} /> : '—'}</td>
            <td>{e.review?.status ? <StatusBadge status={e.review.status} /> : <Badge>unreviewed</Badge>}{e.review?.failure_categories?.length ? <span className="tiny muted"> {e.review.failure_categories.join(', ')}</span> : null}</td>
            <td><Button size="sm" variant="ghost" onClick={() => onOpen(e.episode_index)} data-open-ep={e.episode_index}>Open<I.chevron /></Button></td>
          </tr>
        ))}</tbody>
      </table></div>
      <Confirm open={confirm} onClose={() => setConfirm(false)} danger title={`Delete ${sel.length} episode(s)`} typeToConfirm={id} confirmLabel="Delete"
        onConfirm={async () => { setConfirm(false); try { setJob(await data('data.delete_episodes', { dataset_id: id, episode_indices: sel, confirm: id })); } catch (e) { toast.error(e); } }}>
        Removes the episode files from the dataset and re-indexes the remaining episodes (LeRobot v2.1 only). This cannot be undone; rejecting keeps the data and excludes it from training.
      </Confirm>
    </Panel>
  );
}

function EpisodeViewer({ id, overview, eps, index, onIndex, onReviewed }: { id: string; overview: any; eps: any[]; index: number; onIndex: (i: number) => void; onReviewed: () => void }) {
  const toast = useToast();
  const meta = useLoad(() => planning('meta'), []);
  const ep = useLoad(() => data('data.episode', { dataset_id: id, episode_index: index, max_points: 600 }), [id, index]);
  const row = eps.find((e) => e.episode_index === index);
  const cams: string[] = Object.keys(row?.videos || {});
  const [shown, setShown] = useState<string[]>([]);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState('1');
  const [joint, setJoint] = useState(0);
  const vids = useRef<Record<string, HTMLVideoElement | null>>({});
  const [review, setReview] = useState({ status: '', cats: [] as string[], comment: '' });
  useEffect(() => { setShown(cams.slice(0, 2)); setT(0); setPlaying(false); }, [index, cams.join()]);
  useEffect(() => { setReview({ status: row?.review?.status || '', cats: row?.review?.failure_categories || [], comment: row?.review?.comment || '' }); }, [row?.review, index]);
  const master = () => vids.current[shown[0]];
  const seek = (s: number) => { shown.forEach((k) => { const v = vids.current[k]; const off = row?.videos?.[k]?.from_s || 0; if (v) v.currentTime = s + off; }); setT(s); };
  const play = (p: boolean) => { shown.forEach((k) => { const v = vids.current[k]; if (v) { v.playbackRate = Number(rate); p ? v.play().catch(() => {}) : v.pause(); } }); setPlaying(p); };
  const d = ep.data;
  const names: string[] = d?.state_names || [];
  const series = d ? [
    { name: `state ${names[joint] || joint}`, points: (d.timestamp as number[]).map((x, i) => [x, d.state[i]?.[joint]] as [number, number]) },
    { name: `action ${d.action_names?.[joint] || joint}`, points: (d.timestamp as number[]).map((x, i) => [x, d.action[i]?.[joint]] as [number, number]), dashed: true },
  ] : [];
  const idx = eps.findIndex((e) => e.episode_index === index);
  const saveReview = async (status: string) => {
    try {
      await data('data.review', { dataset_id: id, episode_index: index, status, failure_categories: status === 'accepted' ? [] : review.cats, comment: review.comment });
      toast.ok(`Episode ${index}: ${status.replace('_', ' ')}`);
      onReviewed();
      if (idx >= 0 && idx < eps.length - 1) onIndex(eps[idx + 1].episode_index);
    } catch (e) { toast.error(e); }
  };
  return (
    <div className="grid g-side">
      <div className="stack">
        <Panel title={<>Episode {index}</>} sub={row ? `${fmt.dur(row.duration_s)} · ${(row.tasks || []).join(' · ')}` : undefined}
          actions={<><Button size="sm" variant="ghost" iconOnly icon={<I.back />} disabled={idx <= 0} onClick={() => onIndex(eps[idx - 1].episode_index)} aria-label="Previous" /><span className="small num">{idx + 1}/{eps.length}</span><Button size="sm" variant="ghost" iconOnly icon={<I.chevron />} disabled={idx < 0 || idx >= eps.length - 1} onClick={() => onIndex(eps[idx + 1].episode_index)} aria-label="Next" /></>}>
          <div className="row" style={{ marginBottom: 10 }}>{cams.map((c) => <Check key={c} checked={shown.includes(c)} onChange={(v) => setShown(v ? [...shown, c] : shown.filter((x) => x !== c))}>{c.replace('observation.images.', '')}</Check>)}</div>
          {!cams.length ? <Empty icon={<I.camera />} title="No videos in this episode" /> : (
            <div className={shown.length > 1 ? 'grid g2' : ''}>{shown.map((k, i) => (
              <div key={k} className="camera" style={{ aspectRatio: '4 / 3' }}>
                <video ref={(el) => { vids.current[k] = el; }} src={files.datasetFile(id, row.videos[k].path)} muted playsInline preload="auto"
                  onLoadedMetadata={(e) => { const off = row.videos[k].from_s || 0; (e.target as HTMLVideoElement).currentTime = off + t; }}
                  onTimeUpdate={i === 0 ? (e) => { const v = e.target as HTMLVideoElement; const off = row.videos[k].from_s || 0; const end = row.videos[k].to_s; setT(v.currentTime - off); if (end && v.currentTime >= end) play(false); } : undefined}
                  onEnded={() => setPlaying(false)} style={{ width: '100%', height: '100%', objectFit: 'contain' }} data-video={k} />
                <div className="camera-label">{k.replace('observation.images.', '')}</div>
              </div>
            ))}</div>
          )}
          <div className="row mt">
            <Button size="sm" variant="primary" iconOnly icon={playing ? <I.pause /> : <I.play />} onClick={() => play(!playing)} aria-label="Play" disabled={!shown.length} />
            <input type="range" min={0} max={row?.duration_s || 1} step={0.01} value={t} onChange={(e) => seek(Number(e.target.value))} className="grow" />
            <span className="mono small num">{t.toFixed(2)} / {(row?.duration_s || 0).toFixed(2)} s</span>
            <Select value={rate} onChange={(v) => { setRate(v); const m = master(); if (m) shown.forEach((k) => { const x = vids.current[k]; if (x) x.playbackRate = Number(v); }); }} options={['0.25', '0.5', '1', '2']} style={{ width: 74, height: 28 }} />
          </div>
        </Panel>
        <Panel title="State and action timeline" sub="Joint values; the marker follows the video" actions={<Select value={String(joint)} onChange={(v) => setJoint(Number(v))} options={names.map((n, i) => ({ value: String(i), label: n }))} style={{ width: 170, height: 28 }} />}>
          {ep.error ? <ErrorState error={ep.error} onRetry={ep.reload} /> : !d ? <Loading /> : <LineChart series={series} height={230} xLabel="time (s)" markers={[{ x: t, label: '', color: 'var(--accent)' }]} />}
        </Panel>
      </div>
      <div className="stack">
        <Panel title="Review" actions={row?.review?.status ? <StatusBadge status={row.review.status} /> : <Badge>unreviewed</Badge>}>
          <div className="stack">
            <Field label="Failure categories (for reject / needs review)">
              <div className="grid g2">{(meta.data?.failure_categories || []).map((c: string) => (
                <Check key={c} checked={review.cats.includes(c)} onChange={(v) => setReview({ ...review, cats: v ? [...review.cats, c] : review.cats.filter((x) => x !== c) })}>{c.replace(/_/g, ' ')}</Check>
              ))}</div>
            </Field>
            <Field label="Comment"><Input value={review.comment} onChange={(e) => setReview({ ...review, comment: e.target.value })} /></Field>
            <div className="row">
              <Button variant="primary" icon={<I.check />} onClick={() => saveReview('accepted')} data-action="accept">Accept</Button>
              <Button onClick={() => saveReview('needs_review')}>Needs review</Button>
              <Button variant="danger" icon={<I.x />} onClick={() => saveReview('rejected')} data-action="reject">Reject</Button>
            </div>
            <div className="tiny muted">Saving moves to the next episode.</div>
          </div>
        </Panel>
        <Panel title="Metadata">
          <KV items={[
            ['Frames', row?.length], ['Duration', fmt.dur(row?.duration_s)],
            ['Plan', row?.plan ? <Link to={`/planning/${row.plan.plan_id}`}>{row.plan.plan_name} · {row.plan.episode_id} (v{row.plan.plan_version})</Link> : '—'],
            ['Strategy', row?.plan?.strategy], ['Checks', row?.validation ? (row.validation.ok ? 'passed' : (row.validation.problems || []).join('; ')) : '—'],
            ['Warnings', (row?.validation?.warnings || []).join('; ') || '—'],
            ['Reviewed', row?.review?.updated_at ? fmt.time(row.review.updated_at) : '—'],
          ]} />
          {d?.plan?.config?.placements && <div className="tiny muted mt mono">{d.plan.config.placements.map((p: any) => `${p.item_id} (${p.x_mm}, ${p.y_mm}) ${p.region || ''}`).join(' · ')}</div>}
        </Panel>
        <Panel title="Cameras"><div className="stack-sm small">{(overview.cameras || []).map((c: any) => <div key={c.key} className="row-between"><span className="mono">{c.key.replace('observation.images.', '')}</span><span className="muted">{c.shape?.slice(0, 2).join('×')} · {c.info?.['video.codec']}</span></div>)}</div></Panel>
      </div>
    </div>
  );
}

function Quality({ id, overview }: { id: string; overview: any }) {
  const av = useAvailability();
  const toast = useToast();
  const host = useLoad(async () => ((await trainer.datasets()).datasets as any[]).find((d) => d.id === id), [id, av.trainer], 0, av.trainer);
  const path = host.data?.path;
  const rep = useLoad(() => trainer.healthReport(path), [path], 0, !!path);
  useEffect(() => {
    if (rep.data?.state !== 'running') return;
    const t = setInterval(rep.reload, 1500);
    return () => clearInterval(t);
  }, [rep.data?.state, rep.reload]);
  if (!av.trainer) return <Panel><Empty icon={<I.link />} title="Training service offline">The dataset health analysis runs in your LeRobot Python environment through pam_trainer. {av.hint('trainer')}</Empty></Panel>;
  if (host.loading) return <Loading />;
  if (!path) return <Panel><Empty title="Dataset not visible to the training service">Add its folder with --dataset-root when starting pam_trainer.</Empty></Panel>;
  const r = rep.data;
  const res = r?.result;
  const start = async (refresh = false) => { try { rep.setData(await trainer.startHealthReport(path, undefined, true, refresh)); } catch (e) { toast.error(e); } };
  return (
    <div className="stack">
      <Panel title="Dataset health analysis" sub="Episode length, idle time, joint outliers, grasp/lift detection, frozen or dark video. Read-only."
        actions={r?.state === 'done' ? <Button size="sm" icon={<I.refresh />} onClick={() => start(true)}>Run again</Button> : r?.state !== 'running' ? <Button size="sm" variant="primary" onClick={() => start()} data-action="run-health">Run analysis</Button> : null}>
        {rep.error ? <ErrorState error={rep.error} /> : !r ? <Loading /> : r.state === 'running' ? <div className="stack"><Progress value={r.progress} /><span className="small muted">{r.text}</span></div>
          : r.state === 'failed' || r.error ? <Callout tone="danger" title="Analysis failed">{r.error || r.text}</Callout>
          : !res ? <Empty icon={<I.shield />} title="Not analysed yet" /> : (
            <div className="stack">
              <div className="grid g4">
                <div className="panel stat"><span className="label">OK</span><span className="stat-value" style={{ color: 'var(--ok)' }}>{res.summary.ok}</span></div>
                <div className="panel stat"><span className="label">Warnings</span><span className="stat-value" style={{ color: 'var(--warn)' }}>{res.summary.warn}</span></div>
                <div className="panel stat"><span className="label">Errors</span><span className="stat-value" style={{ color: 'var(--danger)' }}>{res.summary.error}</span></div>
                <div className="panel stat"><span className="label">Median length</span><span className="stat-value">{res.summary.duration_median_s ?? '—'}<small>s</small></span></div>
              </div>
              {res.recommendations?.map((t: string) => <Callout key={t} tone="info">{t}</Callout>)}
              <div className="table-wrap"><table className="table"><thead><tr><th>Episode</th><th>Duration</th><th>Status</th><th>Issues</th></tr></thead>
                <tbody>{res.episodes.filter((e: any) => e.issues.length).map((e: any) => (
                  <tr key={e.episode}><td><Link to={`/datasets/${id}?tab=viewer&ep=${e.episode}`}>{e.episode}</Link></td><td className="num">{e.duration_s}s</td><td><StatusBadge status={e.status} /></td><td className="small">{e.issues.map((i: any) => i.code.replace(/_/g, ' ')).join(', ')}</td></tr>
                ))}</tbody></table></div>
            </div>
          )}
      </Panel>
      <Panel title="Format"><KV items={[['LeRobot format', overview.codebase_version], ['FPS', overview.fps], ['State', (overview.state_names || []).join(', ')], ['Action', (overview.action_names || []).join(', ')], ['Host path', <span className="mono small">{path}</span>]]} /></Panel>
    </div>
  );
}

function Publish({ id }: { id: string }) {
  const toast = useToast();
  const acct = useLoad(() => data('data.hf_account'), []);
  const uploads = useLoad(() => data('data.uploads', { dataset_id: id }), [id], 5000);
  const gh = useLoad(() => data('github.status'), []);
  const status = useTopic<any>('/huggingface/status', 'physical_ai_interfaces/msg/HFOperationStatus', 300);
  const [repo, setRepo] = useState('');
  const [priv, setPriv] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ghRepo, setGhRepo] = useState('');
  useEffect(() => { if (acct.data?.name && !repo) setRepo(`${acct.data.name}/${id.split('/')[1]}`); }, [acct.data, id, repo]);
  const hf = status.msg && status.msg.repo_id === repo ? status.msg : null;
  const upload = async () => {
    setBusy(true);
    try {
      const prep = await data('data.hf_prepare', { dataset_id: id, repo_id: repo, private: priv });
      if (prep.note) toast.warn(prep.note);
      const r = await ros.hf({ mode: 'upload', repo_id: repo, local_dir: prep.local_dir, repo_type: 'dataset', author: repo.split('/')[0] });
      r.success ? toast.ok('Upload started') : toast.warn(r.message);
      uploads.reload();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <div className="grid g2">
      <Panel title="Hugging Face Hub" sub="Uploads the dataset folder as it is (LeRobot format) through physical_ai_server">
        {acct.error ? <Callout tone="warn" title="Not signed in">{(acct.error as Error).message}</Callout> : !acct.data ? <Loading /> : (
          <div className="stack">
            <div className="small">Signed in as <b>{acct.data.name}</b>{acct.data.orgs?.length ? ` (orgs: ${acct.data.orgs.join(', ')})` : ''}</div>
            <Field label="Repository"><Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="user/dataset" /></Field>
            <Switch checked={priv} onChange={setPriv} label="Private repository" />
            <Button variant="primary" icon={<I.upload />} busy={busy} disabled={!/^[^/]+\/[^/]+$/.test(repo) || hf?.status === 'Uploading'} onClick={upload}>Upload</Button>
            {hf && <div className="stack-sm"><div className="row-between small"><span>{hf.status}</span><span className="num">{hf.progress_percentage?.toFixed(0)}%</span></div><Progress value={hf.progress_percentage || 0} /><span className="tiny muted">{hf.message}</span>
              {hf.status === 'Uploading' && <Button size="sm" onClick={() => ros.hf({ mode: 'cancel', repo_id: repo, repo_type: 'dataset' }).catch(toast.error)}>Cancel upload</Button>}</div>}
          </div>
        )}
      </Panel>
      <Panel title="GitHub (collection metadata)" sub="Commits the plan and review metadata, not the videos">
        {!gh.data ? <Loading /> : !gh.data.signed_in ? <Callout tone="info" title="Not connected">{gh.data.error || 'Register a GitHub token on the robot side to publish metadata.'}</Callout> : (
          <div className="stack">
            <div className="small">Signed in as <b>{gh.data.user?.login || gh.data.user?.name}</b></div>
            <Field label="Repository (owner/name)"><Input value={ghRepo} onChange={(e) => setGhRepo(e.target.value)} /></Field>
            <Button icon={<I.upload />} disabled={!/^[^/]+\/[^/]+$/.test(ghRepo)} onClick={async () => { try { await data('github.publish', { dataset_id: id, repo: ghRepo }); toast.ok('Publishing to GitHub started'); uploads.reload(); } catch (e) { toast.error(e); } }}>Publish metadata</Button>
          </div>
        )}
      </Panel>
      <Panel title="Publishing history" flush className="g-span">
        {uploads.data?.uploads?.length ? <div className="table-wrap"><table className="table"><thead><tr><th>When</th><th>Target</th><th>Repository</th><th>Status</th></tr></thead>
          <tbody>{uploads.data.uploads.map((u: any, i: number) => <tr key={i}><td className="small">{fmt.time(u.t || u.created_at)}</td><td>{u.target}</td><td className="mono small">{u.url ? <a href={u.url} target="_blank" rel="noreferrer">{u.repo}</a> : u.repo}</td><td><StatusBadge status={u.status === 'started' ? 'running' : u.status} /></td></tr>)}</tbody></table></div>
          : <Empty title="Not published yet" />}
      </Panel>
    </div>
  );
}

function Export({ id, overview }: { id: string; overview: any }) {
  const size = useMemo(() => fmt.bytes(overview.size_bytes), [overview.size_bytes]);
  return (
    <Panel title="Export dataset" sub="A .tar.gz of the dataset folder, streamed read-only by the gateway">
      <div className="stack">
        <KV items={[['Dataset', <span className="mono">{id}</span>], ['Size on disk', size], ['Format', `LeRobot ${overview.codebase_version} (unchanged)`]]} />
        <div><a className="btn btn-primary" href={files.datasetExport(id)} download data-action="export"><I.download />Download {id.split('/')[1]}.tar.gz</a></div>
        <div className="tiny muted">The archive contains meta/, data/ and videos/ exactly as recorded, so it loads with LeRobot after extraction into a dataset root.</div>
      </div>
    </Panel>
  );
}
