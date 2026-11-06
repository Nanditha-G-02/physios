// MODULE 3: Recording Studio. Recording runs in physical_ai_server (/task/command with a
// TaskInfo, progress on /task/status); plan-mode bookkeeping is the planning service's
// record.* commands. Episode review writes data.review.
import { useEffect, useMemo, useRef, useState } from 'react';
import { PHASE, PHASES, data, planning, ros } from '@/api/gateway';
import { Link } from '@/app/router';
import { useSystem } from '@/app/system';
import { I } from '@/design/icons';
import {
  Badge, Button, Callout, Check, Confirm, Empty, ErrorState, Field, Input, KV, Loading, Meter, Modal, NumberInput, Panel,
  Progress, Segmented, StatusBadge, Switch, TextArea, fmt, useToast,
} from '@/design/ui';
import { useLoad, useNow } from '@/hooks/data';
import { CameraView, LiveJoints, Page, Requires } from '../shared';
import { WorkspaceView } from '../planning/WorkspaceView';

const parseTopics = (list?: string[]) => (list || []).map((s) => { const i = s.indexOf(':'); return i > 0 ? { name: s.slice(0, i), topic: s.slice(i + 1) } : { name: s, topic: s }; });

export default function RecordingStudio() {
  return (
    <Page intro="Record demonstrations with the leader arm while the follower and cameras are captured. Plan mode records the approved plan episode by episode; free mode records with your own settings.">
      <Requires service="ros" what="The Recording Studio"><Studio /></Requires>
    </Page>
  );
}

function Studio() {
  const { taskStatus, taskStatusAt, heartbeatAt, robotType } = useSystem();
  const now = useNow(1000);
  const cams = useLoad(() => ros.cameras(), [robotType]);
  const profile = useLoad(() => planning('robot.profile', {}), [robotType]);
  const [mode, setMode] = useState<'plan' | 'free'>('plan');
  const params = profile.data?.params || {};
  const jointTopics = parseTopics(params.joint_topic_list).filter((t) => /joint_states|follower/.test(t.topic + t.name));
  const followerTopic = jointTopics[0]?.topic || '/joint_states';
  const phase: number | null = taskStatus?.phase ?? null;
  const running = phase != null && phase !== PHASE.READY && phase !== PHASE.STOPPED;
  const statusFresh = taskStatusAt && now - taskStatusAt < 4000;
  const hbFresh = heartbeatAt && now - heartbeatAt < 4000;
  const camTopics: string[] = cams.data?.topics || [];

  return (
    <div className="stack">
      {!robotType && <Callout tone="warn" title="No robot type selected">Choose the robot type in the header. physical_ai_server loads its camera and joint topics from it.</Callout>}
      <TaskBar status={taskStatus} fresh={!!statusFresh} heartbeat={!!hbFresh} />
      <div className="grid g-side">
        <div className="stack">
          <Panel title="Cameras" sub={`${camTopics.length} stream(s) via web_video_server`} actions={<Button size="sm" variant="ghost" icon={<I.refresh />} onClick={cams.reload}>Reload</Button>}>
            {cams.error ? <ErrorState error={cams.error} onRetry={cams.reload} /> : !camTopics.length ? <Empty icon={<I.camera />} title={cams.loading ? 'Loading cameras…' : 'No camera topics'}>Select a robot type; its camera topics appear here.</Empty> : (
              <div className={camTopics.length > 1 ? 'grid g2' : ''}>{camTopics.map((t) => <CameraView key={t} topic={t} recording={phase === PHASE.RECORDING} />)}</div>
            )}
          </Panel>
          <div className="grid g2">
            <Panel title="Follower arm" sub="Measured joint state">{robotType ? <LiveJoints topic={followerTopic} title={followerTopic} /> : <span className="muted small">Select a robot type.</span>}</Panel>
            <Panel title="Leader / robot links">
              <div className="stack-sm small">
                {jointTopics.length || parseTopics(params.joint_topic_list).length ? parseTopics(params.joint_topic_list).map((t) => (
                  <div key={t.topic} className="row-between"><span><b style={{ fontWeight: 500 }}>{t.name}</b> <span className="mono muted">{t.topic}</span></span><TopicAlive topic={t.topic} /></div>
                )) : <span className="muted">Topic list appears when physical_ai_server reports robot parameters.</span>}
                <div className="row-between"><span>Server heartbeat</span>{hbFresh ? <Badge tone="ok" dot>alive</Badge> : <Badge tone="danger" dot>missing</Badge>}</div>
              </div>
            </Panel>
          </div>
        </div>
        <div className="stack">
          <Segmented value={mode} onChange={setMode} options={[{ value: 'plan', label: 'Plan mode' }, { value: 'free', label: 'Free recording' }]} />
          {mode === 'plan' ? <PlanRecorder phase={phase} running={running} /> : <FreeRecorder phase={phase} running={running} />}
          <RecentTakes />
        </div>
      </div>
    </div>
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

function TaskBar({ status, fresh, heartbeat }: { status: any; fresh: boolean; heartbeat: boolean }) {
  const phase: number | null = status?.phase ?? null;
  const pct = status?.total_time ? (100 * status.proceed_time) / status.total_time : 0;
  return (
    <div className="panel" style={{ padding: '14px 16px' }} data-testid="task-bar" data-phase={phase ?? ''}>
      <div className="row-between">
        <div className="row" style={{ gap: 14 }}>
          {phase == null ? <Badge dot>no status</Badge> : <Badge tone={phase === PHASE.RECORDING ? 'danger' : phase === PHASE.READY || phase === PHASE.STOPPED ? 'ok' : 'warn'} dot>{PHASES[phase]}</Badge>}
          <div>
            <div style={{ fontWeight: 600 }}>{status?.task_info?.task_name || 'No task'}</div>
            <div className="tiny muted">{status?.current_task_instruction || (status?.task_info?.task_instruction || []).join(' · ') || '—'}</div>
          </div>
        </div>
        <div className="row" style={{ gap: 18 }}>
          <span className="small text-2">Episode <b className="num">{status?.current_episode_number ?? '—'}</b>{status?.task_info?.num_episodes ? ` / ${status.task_info.num_episodes}` : ''}</span>
          <span className="small text-2 num">{status ? `${fmt.dur(status.proceed_time)} / ${fmt.dur(status.total_time)}` : '—'}</span>
          {status?.encoding_progress > 0 && status.encoding_progress < 100 && <span className="small">encoding {status.encoding_progress.toFixed(0)}%</span>}
          {!fresh && <Badge tone="warn">status stale</Badge>}
          {!heartbeat && <Badge tone="danger">no heartbeat</Badge>}
        </div>
      </div>
      {phase != null && phase !== PHASE.READY && <div style={{ marginTop: 10 }}><Progress value={pct} /></div>}
      {status?.error && <div style={{ marginTop: 10 }}><Callout tone="danger" title="physical_ai_server reported an error">{status.error}</Callout></div>}
      {status && (
        <div className="grid g3" style={{ marginTop: 12 }}>
          <Meter label="Robot PC CPU" value={status.used_cpu} max={100} format={(v) => `${v.toFixed(0)}%`} />
          <Meter label="RAM" value={status.used_ram_size} max={status.total_ram_size} format={(v) => `${v.toFixed(1)} GB`} />
          <Meter label="Storage" value={status.used_storage_size} max={status.total_storage_size} format={(v) => `${v.toFixed(0)} GB`} />
        </div>
      )}
    </div>
  );
}

function Controls({ running, phase, onStopped }: { running: boolean; phase: number | null; onStopped?: () => void }) {
  const toast = useToast();
  const { taskStatus } = useSystem();
  const [busy, setBusy] = useState('');
  const send = async (cmd: string) => {
    setBusy(cmd);
    try {
      const r = await ros.task(cmd, taskStatus?.task_info || {});
      r.success ? toast.ok(r.message || `${cmd} sent`) : toast.warn(r.message || `${cmd} rejected`);
      if (cmd === 'stop' || cmd === 'finish') onStopped?.();
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  return (
    <div className="row">
      <Button variant="danger" icon={<I.stop />} disabled={!running} busy={busy === 'stop'} onClick={() => send('stop')} data-action="stop">Stop</Button>
      <Button icon={<I.chevron />} disabled={!running} busy={busy === 'move_to_next'} onClick={() => send('move_to_next')} data-tip="End this episode early and continue">Next</Button>
      <Button icon={<I.refresh />} disabled={!running} busy={busy === 'rerecord'} onClick={() => send('rerecord')} data-tip="Discard the current episode and record it again">Re-record</Button>
      <Button disabled={!running} busy={busy === 'finish'} onClick={() => send('finish')}>Finish</Button>
      <Button icon={<I.pause />} disabled data-tip="physical_ai_server has no pause command; Stop ends the take, Re-record repeats it">Pause</Button>
      {phase === PHASE.SAVING && <span className="small muted row"><span className="spinner" />saving episode…</span>}
    </div>
  );
}

function ReviewSwitch() {
  const toast = useToast();
  const s = useLoad(() => planning('settings.get', {}), []);
  const on = !!s.data?.record_review_enabled;
  return <Switch checked={on} onChange={(v) => planning('settings.set', { record_review_enabled: v }).then(s.setData, toast.error)} label="Review each take" />;
}

function PlanRecorder({ phase, running }: { phase: number | null; running: boolean }) {
  const toast = useToast();
  const st = useLoad(() => planning('record.state', {}), [], 2500);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [review, setReview] = useState<{ dataset_id: string; episode_index: number; episode_id: string } | null>(null);
  const lastPhase = useRef(phase);
  const s = st.data;
  const plan = s?.plan;
  const eps = useMemo(() => (plan ? [...plan.episodes].sort((a: any, b: any) => a.order - b.order) : []), [plan]);
  const prog = s?.progress?.episodes || {};
  const activeTake = s?.progress?.active;
  const curId = activeTake?.episode_id || (sel && eps.some((e: any) => e.id === sel) ? sel : s?.next_episode_id) || eps[0]?.id;
  const cur = eps.find((e: any) => e.id === curId);

  // after a take finishes, refresh and offer the review of the new episode
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

  if (st.error) return <Panel><ErrorState error={st.error} onRetry={st.reload} /></Panel>;
  if (!s) return <Panel><Loading /></Panel>;
  if (!plan) return <Panel><Empty icon={<I.planning />} title="No active plan" action={<Link to="/planning" className="btn btn-sm">Open Planning Studio</Link>}>Approve a plan and choose "Use for recording".</Empty></Panel>;
  const counts = s.counts || {};
  const done = (counts.validated || 0) + (counts.recorded || 0);
  const status = (id: string) => prog[id]?.status || 'pending';

  const start = async (retake = false) => {
    if (!cur) return;
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
  const bk = async (cmd: string, payload: any, ok: string) => {
    setBusy(cmd);
    try { await planning(cmd, payload); toast.ok(ok); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(''); }
  };

  return (
    <>
      <Panel title={plan.task.name} sub={`v${s.working_version ?? plan.version} · ${s.dataset?.id || s.dataset || ''}`} actions={<><ReviewSwitch /><Badge tone="accent">{done}/{eps.length}</Badge></>} data-testid="plan-recorder">
        <div className="stack">
          <Progress value={done} max={eps.length} />
          {cur && (
            <>
              <div className="row-between"><b>Episode <span className="mono">{cur.id}</span></b><StatusBadge status={status(cur.id)} /></div>
              <div className="small text-2">{cur.instruction || plan.task.instruction}</div>
              <WorkspaceView task={plan.task} placements={cur.placements} height={220} />
              {cur.scenario?.perturbation && cur.scenario.perturbation !== 'none' && <Callout tone="info" title={cur.scenario.name}>{cur.scenario.perturbation.replace(/_/g, ' ')}</Callout>}
              {cur.operator_notes && <Callout tone="info">{cur.operator_notes}</Callout>}
            </>
          )}
          {!running ? (
            <div className="row">
              <Button variant="primary" size="lg" icon={<I.record />} busy={busy === 'start'} disabled={!cur || status(cur?.id) === 'skipped'} onClick={() => start(false)} data-action="start-take">
                {status(cur?.id) === 'validated' || status(cur?.id) === 'recorded' ? 'Retake episode' : 'Start take'}
              </Button>
              {cur && status(cur.id) === 'skipped' ? <Button busy={busy === 'record.restore'} onClick={() => bk('record.restore', { plan_id: plan.id, episode_id: cur.id }, 'Restored')}>Restore</Button>
                : cur && <Button variant="ghost" busy={busy === 'record.skip'} onClick={() => bk('record.skip', { plan_id: plan.id, episode_id: cur.id, reason: 'operator' }, `Skipped ${cur.id}`)}>Skip</Button>}
            </div>
          ) : <Controls running={running} phase={phase} onStopped={() => setTimeout(st.reload, 600)} />}
        </div>
      </Panel>
      <Panel title="Episodes" flush>
        <div className="list" style={{ maxHeight: 300, overflowY: 'auto' }}>{eps.map((e: any) => (
          <button key={e.id} className="list-item" aria-selected={e.id === curId} onClick={() => !running && setSel(e.id)} disabled={running} data-rec-episode={e.id}>
            <span className="mono small">{e.id}</span>
            <span className="grow tiny muted ellipsis">{e.placements.map((p: any) => `${p.item_id}@${p.region || '?'}`).join(' ')}</span>
            <StatusBadge status={status(e.id)} />
          </button>
        ))}</div>
      </Panel>
      <ReviewModal target={review} onClose={() => setReview(null)} onRetake={() => { setReview(null); setSel(review?.episode_id || null); setTimeout(() => start(true), 50); }} />
    </>
  );
}

function FreeRecorder({ phase, running }: { phase: number | null; running: boolean }) {
  const toast = useToast();
  const { robotType } = useSystem();
  const [f, setF] = useState({ task_name: '', user_id: '', instruction: '', fps: 30, warmup_time_s: 5, episode_time_s: 20, reset_time_s: 5, num_episodes: 5, use_optimized_save_mode: true, private_mode: true, push_to_hub: false, record_rosbag2: false });
  const [busy, setBusy] = useState(false);
  const valid = /^[A-Za-z0-9_.-]+$/.test(f.task_name) && /^[A-Za-z0-9_.-]+$/.test(f.user_id) && f.instruction.trim() && robotType;
  const start = async () => {
    setBusy(true);
    try {
      const r = await ros.task('start_record', { ...f, task_type: 'record', task_instruction: [f.instruction], tags: [robotType, 'physios'], policy_path: '', record_inference_mode: false });
      r.success ? toast.ok('Recording started') : toast.warn(r.message);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Panel title="Free recording" sub="Your own task settings; no plan bookkeeping">
      {running ? <Controls running={running} phase={phase} /> : (
        <div className="stack">
          <div className="grid g2">
            <Field label="Task name"><Input value={f.task_name} onChange={(e) => setF({ ...f, task_name: e.target.value })} data-field="free-task" /></Field>
            <Field label="Owner"><Input value={f.user_id} onChange={(e) => setF({ ...f, user_id: e.target.value })} data-field="free-user" /></Field>
          </div>
          <Field label="Instruction"><TextArea rows={2} value={f.instruction} onChange={(e) => setF({ ...f, instruction: e.target.value })} /></Field>
          <div className="grid g4">
            <Field label="Episodes"><NumberInput value={f.num_episodes} onChange={(v) => setF({ ...f, num_episodes: v ?? 1 })} /></Field>
            <Field label="Episode s"><NumberInput value={f.episode_time_s} onChange={(v) => setF({ ...f, episode_time_s: v ?? 20 })} /></Field>
            <Field label="Warm-up s"><NumberInput value={f.warmup_time_s} onChange={(v) => setF({ ...f, warmup_time_s: v ?? 0 })} /></Field>
            <Field label="Reset s"><NumberInput value={f.reset_time_s} onChange={(v) => setF({ ...f, reset_time_s: v ?? 0 })} /></Field>
          </div>
          <div className="row"><Field label="FPS"><NumberInput value={f.fps} onChange={(v) => setF({ ...f, fps: v ?? 30 })} style={{ width: 90 }} /></Field>
            <Switch checked={f.use_optimized_save_mode} onChange={(v) => setF({ ...f, use_optimized_save_mode: v })} label="Optimised save" />
            <Switch checked={f.record_rosbag2} onChange={(v) => setF({ ...f, record_rosbag2: v })} label="Also rosbag2" /></div>
          <Button variant="primary" size="lg" icon={<I.record />} disabled={!valid} busy={busy} onClick={start}>Start recording</Button>
        </div>
      )}
    </Panel>
  );
}

function RecentTakes() {
  const rec = useLoad(() => planning('record.recent', { limit: 8 }), [], 8000);
  const [review, setReview] = useState<any>(null);
  return (
    <Panel title="Recent takes" flush>
      {rec.data?.recent?.length ? <div className="list">{rec.data.recent.map((r: any) => (
        <div key={r.dataset_id + r.episode_index} className="list-item">
          <div className="grow"><div className="small"><span className="mono">{r.episode_id || `#${r.episode_index}`}</span> · {fmt.dur(r.duration_s)}</div><div className="tiny muted ellipsis">{r.dataset_id} · {fmt.ago(r.t)}</div></div>
          {r.review?.status ? <StatusBadge status={r.review.status} /> : <Button size="sm" onClick={() => setReview({ dataset_id: r.dataset_id, episode_index: r.episode_index, episode_id: r.episode_id })} data-action="review">Review</Button>}
        </div>
      ))}</div> : <Empty icon={<I.record />} title="No takes yet" />}
      <ReviewModal target={review} onClose={() => { setReview(null); rec.reload(); }} />
    </Panel>
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
