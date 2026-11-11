// 03 · Record. Recording runs in physical_ai_server (/task/command with a TaskInfo, progress
// on /task/status); plan-mode bookkeeping is the planning service's record.* commands; episode
// review writes data.review. Laid out like the Physical AI Manager record page: robot type and
// connection at the top left, cameras in the middle, the plan sheet on the right and the
// control bar (Start / Stop / Retry / Next / Finish) at the bottom.
import { useEffect, useMemo, useRef, useState } from 'react';
import { PHASE, PHASES, data, planning, ros } from '@/api/gateway';
import { Link } from '@/app/router';
import { useAvailability, useSystem } from '@/app/system';
import { I } from '@/design/icons';
import {
  Badge, Button, Callout, Check, Confirm, Empty, ErrorState, Field, Input, KV, Loading, Modal, NumberInput, Panel,
  Segmented, StatusBadge, Switch, TextArea, fmt, useToast,
} from '@/design/ui';
import { useLoad, useNow } from '@/hooks/data';
import { CameraView, LiveJoints, Page, Requires } from '../shared';
import { WorkspaceView } from '../planning/WorkspaceView';

const parseTopics = (list?: string[]) => (list || []).map((s) => { const i = s.indexOf(':'); return i > 0 ? { name: s.slice(0, i), topic: s.slice(i + 1) } : { name: s, topic: s }; });
const FREE0 = { task_name: '', user_id: '', instruction: '', fps: 30, warmup_time_s: 5, episode_time_s: 20, reset_time_s: 5, num_episodes: 5, use_optimized_save_mode: true, private_mode: true, push_to_hub: false, record_rosbag2: false };

export default function RecordingStudio() {
  const av = useAvailability();
  if (av.known && !av.ros) return <Page code="03" label="Record" title="Record demonstrations"><Requires service="ros" what="The Recording Studio"><span /></Requires></Page>;
  return <Studio />;
}

function Studio() {
  const toast = useToast();
  const { taskStatus, taskStatusAt, heartbeatAt, robotType } = useSystem();
  const now = useNow(1000);
  const cams = useLoad(() => ros.cameras(), [robotType]);
  const profile = useLoad(() => planning('robot.profile', {}), [robotType]);
  const st = useLoad(() => planning('record.state', {}), [], 2500);
  const [mode, setMode] = useState<'plan' | 'free'>('plan');
  const [sel, setSel] = useState<string | null>(null);
  const [free, setFree] = useState(FREE0);
  const [busy, setBusy] = useState('');
  const [review, setReview] = useState<{ dataset_id: string; episode_index: number; episode_id?: string } | null>(null);
  const params = profile.data?.params || {};
  const topics = parseTopics(params.joint_topic_list);
  const followerTopic = topics.find((t) => /joint_states|follower/.test(t.topic + t.name))?.topic || '/joint_states';
  const phase: number | null = taskStatus?.phase ?? null;
  const running = phase != null && phase !== PHASE.READY && phase !== PHASE.STOPPED;
  const hbFresh = !!heartbeatAt && now - heartbeatAt < 4000;
  const statusFresh = !!taskStatusAt && now - taskStatusAt < 4000;
  const camTopics: string[] = cams.data?.topics || [];

  // plan state
  const s = st.data;
  const plan = s?.plan;
  const eps = useMemo(() => (plan ? [...plan.episodes].sort((a: any, b: any) => a.order - b.order) : []), [plan]);
  const prog = s?.progress?.episodes || {};
  const curId = s?.progress?.active?.episode_id || (sel && eps.some((e: any) => e.id === sel) ? sel : s?.next_episode_id) || eps[0]?.id;
  const cur = eps.find((e: any) => e.id === curId);
  const status = (id?: string) => (id && prog[id]?.status) || 'pending';
  const counts = s?.counts || {};
  const done = (counts.validated || 0) + (counts.recorded || 0);

  // after a take finishes, refresh and offer the review of the new episode
  const lastPhase = useRef(phase);
  useEffect(() => {
    if (lastPhase.current !== phase && phase === PHASE.READY) {
      setTimeout(async () => {
        await st.reload();
        try {
          const rec = await planning('record.recent', { limit: 1 });
          const r = rec.recent?.[0];
          if (r && Date.now() - Date.parse(r.t) < 60000 && rec.settings?.record_review_enabled) setReview({ dataset_id: r.dataset_id, episode_index: r.episode_index, episode_id: r.episode_id });
        } catch { /* ignore */ }
      }, 800);
    }
    lastPhase.current = phase;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const startPlan = async (retake = false) => {
    if (!plan || !cur) return;
    setBusy('start');
    try {
      const st0 = status(cur.id);
      const begin = await planning('record.begin', { plan_id: plan.id, episode_id: cur.id, retake: retake || st0 === 'validated' || st0 === 'recorded' });
      const r = await ros.task('start_record', begin.task_info);
      if (!r.success) {
        await planning('record.cancel', { plan_id: plan.id, reason: 'start_failed' }).catch(() => {});
        toast.warn(r.message || 'physical_ai_server did not start recording');
      } else toast.ok(`Recording ${cur.id}`);
    } catch (e) { toast.error(e); } finally { setBusy(''); st.reload(); }
  };
  const freeValid = /^[A-Za-z0-9_.-]+$/.test(free.task_name) && /^[A-Za-z0-9_.-]+$/.test(free.user_id) && free.instruction.trim() && !!robotType;
  const startFree = async () => {
    setBusy('start');
    try {
      const r = await ros.task('start_record', { ...free, task_type: 'record', task_instruction: [free.instruction], tags: [robotType, 'physios'], policy_path: '', record_inference_mode: false });
      r.success ? toast.ok('Recording started') : toast.warn(r.message);
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const send = async (cmd: string) => {
    setBusy(cmd);
    try {
      const r = await ros.task(cmd, taskStatus?.task_info || {});
      r.success ? toast.ok(r.message || `${cmd} sent`) : toast.warn(r.message || `${cmd} rejected`);
      if (cmd === 'stop' || cmd === 'finish') setTimeout(st.reload, 600);
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const bk = async (cmd: string, payload: any, ok: string) => {
    setBusy(cmd);
    try { await planning(cmd, payload); toast.ok(ok); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const canStart = !running && (mode === 'plan' ? !!cur && status(cur?.id) !== 'skipped' : freeValid);
  const pct = taskStatus?.total_time ? (100 * taskStatus.proceed_time) / taskStatus.total_time : 0;

  return (
    <div className="console">
      <div className="console-main">
        <div className="console-top">
          <div className="stack-sm" style={{ gap: 12 }}>
            <div className="robot-type-card">Robot Type <b>{robotType || 'none'}</b></div>
            <div><span className={`conn-chip${hbFresh ? '' : ' off'}`}><span className="dot" style={{ background: 'currentColor' }} />{hbFresh ? 'Connected' : 'No heartbeat'}</span></div>
          </div>
          <div className="stack-sm" style={{ alignItems: 'center', gap: 10 }}>
            <Segmented value={mode} onChange={(m) => !running && setMode(m)} options={[{ value: 'plan', label: 'Plan mode' }, { value: 'free', label: 'Free recording' }]} />
            <span className="pill" style={{ padding: '4px 12px' }} data-testid="review-switch"><ReviewSwitch /></span>
          </div>
          <div style={{ width: 120 }} className="hide-sm" />
        </div>
        <div className="console-center">
          {!robotType && <Callout tone="warn" title="No robot type selected">Select and confirm a robot on Home. physical_ai_server loads its camera and joint topics from it.</Callout>}
          {taskStatus?.error && <Callout tone="danger" title="physical_ai_server reported an error">{taskStatus.error}</Callout>}
          {cams.error ? <ErrorState error={cams.error} onRetry={cams.reload} /> : !camTopics.length ? <Empty icon={<I.camera />} title={cams.loading ? 'Loading cameras…' : 'No camera topics'}>Select a robot type; its camera topics appear here.</Empty> : (
            <div className={camTopics.length > 1 ? 'grid g2' : ''} style={{ alignItems: 'center' }}>{camTopics.map((t) => <CameraView key={t} topic={t} recording={phase === PHASE.RECORDING} />)}</div>
          )}
          <div className="grid g2">
            <Panel title="Follower arm">{robotType ? <LiveJoints topic={followerTopic} title={followerTopic} /> : <span className="muted small">Select a robot type.</span>}</Panel>
            <Panel title="Robot links">
              <div className="stack-sm small">
                {topics.length ? topics.map((t) => <div key={t.topic} className="row-between"><span><b style={{ fontWeight: 500 }}>{t.name}</b> <span className="mono muted">{t.topic}</span></span><TopicAlive topic={t.topic} /></div>)
                  : <span className="muted">Topic list appears when physical_ai_server reports robot parameters.</span>}
                <div className="row-between"><span>Server heartbeat</span>{hbFresh ? <Badge tone="ok" dot>alive</Badge> : <Badge tone="danger" dot>missing</Badge>}</div>
              </div>
            </Panel>
          </div>
        </div>
      </div>

      <aside className="console-side" data-testid={mode === 'plan' ? 'plan-recorder' : 'free-recorder'}>
        {mode === 'plan' ? (
          st.error ? <div className="side-sec"><ErrorState error={st.error} onRetry={st.reload} /></div> : !s ? <div className="side-sec"><Loading /></div> : !plan ? (
            <div className="side-sec"><Empty icon={<I.planning />} title="No approved plan" action={<Link to="/planning" className="btn btn-sm btn-primary">Open Planning</Link>}>Approve a plan and choose "Use for recording".</Empty></div>
          ) : (
            <>
              <div className="side-sec stack" style={{ gap: 10 }}>
                <div className="row-between"><span className="label">Approved plan · v{s.working_version ?? plan.version}</span><span className="badge">{plan.strategy?.type}</span></div>
                <div><div style={{ fontSize: 15, fontWeight: 600 }}>{plan.task.name}</div><div className="mono tiny muted">{s.dataset?.id || s.dataset || ''}</div></div>
                <div className="mini-stats">
                  <div><b style={{ color: 'var(--ok)' }}>{done}</b><span>Done</span></div><div><b>{Math.max(0, eps.length - done - (counts.skipped || 0))}</b><span>Left</span></div>
                  <div><b>{counts.failed || 0}</b><span>Failed</span></div><div><b>{counts.skipped || 0}</b><span>Skipped</span></div>
                </div>
                <div className="row" style={{ flexWrap: 'nowrap' }}><div className="progress grow" style={{ height: 6 }}><span style={{ width: `${(100 * done) / Math.max(1, eps.length)}%`, background: 'var(--ok)' }} /></div><span className="mono tiny muted">{Math.round((100 * done) / Math.max(1, eps.length))}%</span></div>
              </div>
              <div className="side-sec">
                <div className="label" style={{ marginBottom: 8 }}>Episodes</div>
                <div className="ep-squares">{eps.map((e: any) => {
                  const stt = status(e.id);
                  return <span key={e.id} title={`${e.id} · ${stt}`} data-rec-episode={e.id} className={`${['validated', 'recorded'].includes(stt) ? 'done' : stt === 'failed' ? 'failed' : stt === 'skipped' ? 'skipped' : ''} ${e.id === curId ? 'cur' : ''}`} onClick={() => !running && setSel(e.id)} />;
                })}</div>
              </div>
              {cur && (
                <div className="side-sec stack" style={{ gap: 10 }}>
                  <div className="row-between">
                    <div><div className="label">Episode</div><div className="num" style={{ fontSize: 22, fontWeight: 300 }}>{eps.indexOf(cur) + 1} <span className="muted" style={{ fontSize: 15 }}>/ {eps.length}</span></div></div>
                    <div className="row">
                      <button className="btn btn-sm btn-icon" disabled={running || eps.indexOf(cur) <= 0} onClick={() => setSel(eps[eps.indexOf(cur) - 1].id)} aria-label="Previous"><I.back /></button>
                      <button className="btn btn-sm btn-icon" disabled={running || eps.indexOf(cur) >= eps.length - 1} onClick={() => setSel(eps[eps.indexOf(cur) + 1].id)} aria-label="Next"><I.chevron /></button>
                    </div>
                  </div>
                  <div className="row"><span className="badge mono">{cur.id}</span><StatusBadge status={status(cur.id)} /><span className="badge">{cur.scenario?.name || 'Normal'}</span></div>
                  <div className="callout callout-info"><div><div className="label" style={{ marginBottom: 2 }}>Instruction (recorded with the episode)</div><div style={{ fontSize: 14 }}>"{cur.instruction || plan.task.instruction}"</div></div></div>
                  <div className="label">Set up before start</div>
                  <WorkspaceView task={plan.task} placements={cur.placements} height={230} />
                  <div className="stack-sm small">{cur.placements.map((pl: any) => {
                    const it = plan.task.items.find((x: any) => x.id === pl.item_id);
                    return <div key={pl.item_id} className="row-between"><span>{it?.name || pl.item_id}</span><span className="row"><span className="badge">{(pl.region || '?').slice(0, 1).toUpperCase()}</span><span className="mono">x {pl.x_mm} · y {pl.y_mm} · {pl.yaw_deg || 0}°</span></span></div>;
                  })}</div>
                  {(plan.strategy?.params?.sequence || []).length > 0 && <><div className="label">Sequence</div><div className="row" style={{ gap: 4 }}>{plan.strategy.params.sequence.map((q: any, i: number) => <span key={i} className="badge badge-accent">{i + 1}. {q.action.replace(/_/g, ' ')}</span>)}</div></>}
                  {cur.operator_notes && <Callout tone="info">{cur.operator_notes}</Callout>}
                  <div className="row-between">
                    {status(cur.id) === 'skipped' ? <Button size="sm" busy={busy === 'record.restore'} onClick={() => bk('record.restore', { plan_id: plan.id, episode_id: cur.id }, 'Restored')}>Restore</Button>
                      : <Button size="sm" disabled={running} busy={busy === 'record.skip'} onClick={() => bk('record.skip', { plan_id: plan.id, episode_id: cur.id, reason: 'operator' }, `Skipped ${cur.id}`)}>Skip…</Button>}
                    <Link to={s.dataset?.id ? `/datasets/${s.dataset.id}` : '/datasets'} className="btn btn-sm">Review in Data →</Link>
                  </div>
                </div>
              )}
            </>
          )
        ) : (
          <div className="side-sec stack">
            <div><div className="label">Free recording</div><div style={{ fontSize: 15, fontWeight: 600 }}>Task information</div><div className="tiny muted">Your own settings; no plan bookkeeping.</div></div>
            <div className="grid g2">
              <Field label="Task name"><Input value={free.task_name} disabled={running} onChange={(e) => setFree({ ...free, task_name: e.target.value })} data-field="free-task" /></Field>
              <Field label="Owner"><Input value={free.user_id} disabled={running} onChange={(e) => setFree({ ...free, user_id: e.target.value })} data-field="free-user" /></Field>
            </div>
            <Field label="Task instruction"><TextArea rows={2} value={free.instruction} disabled={running} onChange={(e) => setFree({ ...free, instruction: e.target.value })} /></Field>
            <div className="grid g2">
              <Field label="Episodes"><NumberInput value={free.num_episodes} onChange={(v) => setFree({ ...free, num_episodes: v ?? 1 })} /></Field>
              <Field label="Episode s"><NumberInput value={free.episode_time_s} onChange={(v) => setFree({ ...free, episode_time_s: v ?? 20 })} /></Field>
              <Field label="Warm-up s"><NumberInput value={free.warmup_time_s} onChange={(v) => setFree({ ...free, warmup_time_s: v ?? 0 })} /></Field>
              <Field label="Reset s"><NumberInput value={free.reset_time_s} onChange={(v) => setFree({ ...free, reset_time_s: v ?? 0 })} /></Field>
              <Field label="FPS"><NumberInput value={free.fps} onChange={(v) => setFree({ ...free, fps: v ?? 30 })} /></Field>
            </div>
            <Switch checked={free.use_optimized_save_mode} onChange={(v) => setFree({ ...free, use_optimized_save_mode: v })} label="Optimised save" />
            <Switch checked={free.record_rosbag2} onChange={(v) => setFree({ ...free, record_rosbag2: v })} label="Also record rosbag2" />
            {!freeValid && <div className="tiny muted">Fill in task name, owner and instruction, then press Start.</div>}
          </div>
        )}
        <div className="side-sec"><RecentTakes /></div>
      </aside>
      <div className="console-bottom">
        <div className="control-bar" data-testid="task-bar" data-phase={phase ?? ''}>
          <div className="cb-buttons">
            <button className="big-btn primary" disabled={!canStart || busy === 'start'} onClick={() => (mode === 'plan' ? startPlan(false) : startFree())} data-action={mode === 'plan' ? 'start-take' : 'start-free'}>
              {busy === 'start' ? <span className="spinner" /> : <I.play />}{mode === 'plan' && (status(cur?.id) === 'validated' || status(cur?.id) === 'recorded') ? 'Retake' : 'Start'}
            </button>
            <button className="big-btn" disabled={!running || busy === 'stop'} onClick={() => send('stop')} data-action="stop"><I.stop />Stop</button>
            <button className="big-btn" disabled={!running} onClick={() => send('rerecord')} title="Discard the current episode and record it again"><I.refresh />Retry</button>
            <button className="big-btn" disabled={!running} onClick={() => send('move_to_next')} title="End this episode early and continue"><I.chevron />Next</button>
            <button className="big-btn" disabled={!running} onClick={() => send('finish')}><I.check />Finish</button>
          </div>
          <div className="cb-status">
            <div className="row-between" style={{ flexWrap: 'nowrap' }}>
              <span className="row" style={{ fontSize: 16, fontWeight: 600, gap: 8 }}><span className="dot" style={{ background: phase === PHASE.RECORDING ? 'var(--err)' : running ? 'var(--warn)' : 'var(--ink-4)' }} />{phase == null ? 'No status' : PHASES[phase]}</span>
              <span className="num" style={{ fontSize: 18 }}>{taskStatus ? Math.round(taskStatus.proceed_time || 0) : 0} <span className="muted" style={{ fontSize: 13 }}>/ {taskStatus ? Math.round(taskStatus.total_time || 0) : 0} s</span></span>
            </div>
            <div className="progress" style={{ height: 6 }}><span style={{ width: `${pct}%`, background: phase === PHASE.RECORDING ? 'var(--err)' : 'var(--ink)' }} /></div>
            <div className="tiny muted">{running ? (phase === PHASE.SAVING ? 'Saving the episode…' : taskStatus?.current_task_instruction || 'Recording with the leader arm.') : !statusFresh ? 'Waiting for /task/status from physical_ai_server.' : 'Press Start when the scene is set up. Pause is not available: Stop ends the take, Retry repeats it.'}</div>
          </div>
          <div className="cb-progress">
            <Ring value={mode === 'plan' ? done : taskStatus?.current_episode_number || 0} total={mode === 'plan' ? eps.length : taskStatus?.task_info?.num_episodes || free.num_episodes} />
            <div><div className="label" style={{ fontSize: 9.5 }}>{mode === 'plan' ? 'Plan progress' : 'Episode'}</div><div className="num" style={{ fontSize: 20, fontWeight: 300 }}>{mode === 'plan' ? done : taskStatus?.current_episode_number || 0} <span className="muted" style={{ fontSize: 14 }}>/ {mode === 'plan' ? eps.length : taskStatus?.task_info?.num_episodes || free.num_episodes}</span></div><div className="tiny muted">{mode === 'plan' ? `next ${s?.next_episode_id || '—'}` : 'this session'}</div></div>
          </div>
          <div className="cb-res">
            {[['CPU', taskStatus?.used_cpu, 100, (v: number) => `${v.toFixed(0)}%`], ['RAM', taskStatus?.used_ram_size, taskStatus?.total_ram_size, (v: number) => `${v.toFixed(1)} / ${(taskStatus?.total_ram_size || 0).toFixed(0)} GB`], ['DISK', taskStatus?.used_storage_size, taskStatus?.total_storage_size, (v: number) => `${v.toFixed(0)} / ${(taskStatus?.total_storage_size || 0).toFixed(0)} GB`]].map(([k, v, m, f]: any) => (
              <div key={k}><div className="row-between"><span>{k}</span><span>{v != null ? f(v) : '—'}</span></div><div className="progress"><span style={{ width: `${m ? Math.min(100, (100 * (v || 0)) / m) : 0}%`, background: 'var(--ink-3)' }} /></div></div>
            ))}
          </div>
        </div>
      </div>
      <ReviewModal target={review} onClose={() => setReview(null)} onRetake={() => { const id = review?.episode_id; setReview(null); if (id) setSel(id); setTimeout(() => startPlan(true), 50); }} />
    </div>
  );
}

function Ring({ value, total }: { value: number; total: number }) {
  const p = total ? Math.min(1, value / total) : 0;
  const r = 22; const c = 2 * Math.PI * r;
  return (
    <svg className="ring" viewBox="0 0 54 54" aria-hidden>
      <circle cx="27" cy="27" r={r} fill="none" stroke="var(--paper-2)" strokeWidth="5" />
      <circle cx="27" cy="27" r={r} fill="none" stroke="var(--ok)" strokeWidth="5" strokeDasharray={`${c * p} ${c}`} transform="rotate(-90 27 27)" strokeLinecap="round" />
      <text x="27" y="31" textAnchor="middle" style={{ font: '600 11px var(--font-mono)', fill: 'var(--ink)' }}>{Math.round(p * 100)}%</text>
    </svg>
  );
}

function TopicAlive({ topic }: { topic: string }) {
  // presence only: a compact live/stale marker for any topic type
  const [at, setAt] = useState(0);
  const now = useNow(1000);
  useEffect(() => {
    let off: (() => void) | undefined;
    import('@/api/rosbridge').then(({ rosSocket }) => { off = rosSocket.subscribe(topic, undefined, () => setAt(Date.now()), 500); });
    return () => off?.();
  }, [topic]);
  return at && now - at < 2500 ? <Badge tone="ok" dot>live</Badge> : <Badge dot>no data</Badge>;
}

function ReviewSwitch() {
  const toast = useToast();
  const s = useLoad(() => planning('settings.get', {}), []);
  const on = !!s.data?.record_review_enabled;
  return <Switch checked={on} onChange={(v) => planning('settings.set', { record_review_enabled: v }).then(s.setData, toast.error)} label="Review episodes" />;
}

function RecentTakes() {
  const rec = useLoad(() => planning('record.recent', { limit: 8 }), [], 8000);
  const [review, setReview] = useState<any>(null);
  return (
    <div>
      <div className="label" style={{ marginBottom: 6 }}>Recent takes</div>
      {rec.data?.recent?.length ? <div className="list">{rec.data.recent.map((r: any) => (
        <div key={r.dataset_id + r.episode_index} className="list-item">
          <div className="grow"><div className="small"><span className="mono">{r.episode_id || `#${r.episode_index}`}</span> · {fmt.dur(r.duration_s)}</div><div className="tiny muted ellipsis">{r.dataset_id} · {fmt.ago(r.t)}</div></div>
          {r.review?.status ? <StatusBadge status={r.review.status} /> : <Button size="sm" onClick={() => setReview({ dataset_id: r.dataset_id, episode_index: r.episode_index, episode_id: r.episode_id })} data-action="review">Review</Button>}
        </div>
      ))}</div> : <Empty icon={<I.record />} title="No takes yet" />}
      <ReviewModal target={review} onClose={() => { setReview(null); rec.reload(); }} />
    </div>
  );
}

export function ReviewModal({ target, onClose, onRetake }: { target: { dataset_id: string; episode_index: number; episode_id?: string } | null; onClose: () => void; onRetake?: () => void }) {
  const toast = useToast();
  const meta = useLoad(() => planning('meta'), [!!target], 0, !!target);
  const [status, setStatus] = useState('accepted');
  const [cats, setCats] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => { if (target) { setStatus('accepted'); setCats([]); setComment(''); } }, [target]);
  if (!target) return null;
  const save = async () => {
    setBusy(true);
    try {
      await data('data.review', { dataset_id: target.dataset_id, episode_index: target.episode_index, status, failure_categories: status === 'accepted' ? [] : cats, comment, source: 'record' });
      toast.ok(`Episode ${target.episode_index} marked ${status.replace('_', ' ')}`);
      onClose();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={<>Review episode <span className="mono">{target.episode_id || target.episode_index}</span></>}
      footer={<>{onRetake && <Button icon={<I.refresh />} onClick={onRetake}>Reshoot</Button>}<span className="grow" /><Button onClick={onClose}>Later</Button><Button variant="primary" busy={busy} onClick={save} data-action="save-review">Save review</Button></>}>
      <div className="stack">
        <KV items={[['Dataset', <span className="mono">{target.dataset_id}</span>], ['Episode index', target.episode_index]]} />
        <Segmented value={status} onChange={setStatus} options={[{ value: 'accepted', label: 'Accept' }, { value: 'needs_review', label: 'Needs review' }, { value: 'rejected', label: 'Reject' }]} />
        {status !== 'accepted' && (
          <Field label="Failure categories">
            <div className="grid g2">{(meta.data?.failure_categories || []).map((c: string) => (
              <Check key={c} checked={cats.includes(c)} onChange={(v) => setCats(v ? [...cats, c] : cats.filter((x) => x !== c))}>{c.replace(/_/g, ' ')}</Check>
            ))}</div>
          </Field>
        )}
        <Field label="Comment"><Input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        <div className="tiny muted">Rejected episodes are excluded from training by default; nothing is deleted. <a href="#" onClick={(e) => { e.preventDefault(); setConfirmDel(true); }}>Delete episode…</a></div>
      </div>
      <Confirm open={confirmDel} onClose={() => setConfirmDel(false)} danger title="Delete episode from the dataset" confirmLabel="Delete" typeToConfirm={target.dataset_id}
        onConfirm={async () => { setConfirmDel(false); try { await data('data.delete_episodes', { dataset_id: target.dataset_id, episode_indices: [target.episode_index], confirm: target.dataset_id }); toast.ok('Deletion started; the Dataset Library shows its progress'); onClose(); } catch (e) { toast.error(e); } }}>
        Removes the episode files and re-indexes the dataset. This cannot be undone.
      </Confirm>
    </Modal>
  );
}
