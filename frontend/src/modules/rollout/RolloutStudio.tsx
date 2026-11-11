// MODULE 10: Physical Robot Rollout. Two engines, both existing:
//  * host rollout (pam_trainer rollout worker): checkpoint trained here; joint envelope,
//    per-step limits, stale-data hold, heartbeat hold, duration cap, e-stop kills the worker;
//  * on-robot inference (physical_ai_server /task/command START_INFERENCE) for policies saved
//    on the robot side.
// Nothing moves without the operator's explicit start; the page sends a heartbeat while the
// arm moves and the worker holds position if it stops arriving.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { PHASE, PHASES, ros } from '@/api/gateway';
import { trainer } from '@/api/trainer';
import { Link } from '@/app/router';
import { useAvailability, useSystem } from '@/app/system';
import { I } from '@/design/icons';
import {
  Badge, Button, Callout, Confirm, Empty, Field, Input, KV, Loading, NumberInput, Panel, Select, StatusBadge,
  TextArea, fmt, useToast,
} from '@/design/ui';
import { useLoad, useNow } from '@/hooks/data';
import { BigButton, Console, ControlBar, LiveJoints, RobotCameras, SideSec } from '../shared';
import { Logs, PredictionTable, ROLLOUT_ACTIVE, buildRequest, useCheckpointChoice, useRobotConfig, useRollout } from './rolloutShared';

const CHECKS = [
  'The workspace is clear of people and loose objects',
  'The emergency stop (power switch) is within reach',
  'I will watch the robot for the whole rollout',
  'The camera positions match the recorded training data',
];


function useReadiness() {
  const { robotType, heartbeatAt, taskStatus } = useSystem();
  const av = useAvailability();
  const now = useNow(1000);
  const robots = useLoad(() => trainer.robots(), [av.trainer], 0, av.trainer);
  const custom = (robots.data?.robots || []).find((r: any) => r.id.toLowerCase().replace(/[^a-z0-9_]/g, '_') === robotType);
  const items = [
    { label: 'physical_ai_server reachable', ok: av.ros, detail: av.ros ? 'ROS services answer' : av.hint('ros_node') },
    { label: 'Robot type selected', ok: !!robotType, detail: robotType || 'choose it in the header' },
    { label: 'Server heartbeat', ok: !!heartbeatAt && now - heartbeatAt < 3000, detail: heartbeatAt ? `${fmt.dur((now - heartbeatAt) / 1000)} ago` : 'none received' },
    { label: 'No recording running', ok: !taskStatus || [PHASE.READY, PHASE.STOPPED].includes(taskStatus.phase), detail: taskStatus ? `phase ${taskStatus.phase}` : 'idle' },
    ...(custom ? [{ label: `Custom robot ${custom.name} hardware-verified`, ok: custom.state === 'registered' && (custom.stage || 0) >= 3, detail: `stage ${custom.stage || 0} of 4` }] : []),
  ];
  return { items, ok: items.every((i) => i.ok), custom };
}

function Readiness({ r }: { r: ReturnType<typeof useReadiness> }) {
  return (
    <SideSec label="Robot readiness" actions={<Badge tone={r.ok ? 'ok' : 'danger'} dot>{r.ok ? 'ready' : 'not ready'}</Badge>} data-testid="readiness">
      <div className="stack-sm">{r.items.map((i) => (
        <div key={i.label} className="row-between small" data-ready={i.ok}><span className="row" style={{ gap: 8 }}>{i.ok ? <I.ok width={16} height={16} style={{ color: 'var(--ok)' }} /> : <I.alert width={16} height={16} style={{ color: 'var(--danger)' }} />}{i.label}</span><span className="muted tiny ellipsis" style={{ maxWidth: 160 }}>{i.detail}</span></div>
      ))}</div>
      {r.custom && <div className="mt"><Link to={`/robots/${r.custom.id}`} className="btn btn-sm btn-ghost">Custom robot readiness<I.chevron /></Link></div>}
    </SideSec>
  );
}

export function HostRollout({ tabs }: { tabs?: ReactNode }) {
  const toast = useToast();
  const ready = useReadiness();
  const robot = useRobotConfig();
  const ck = useCheckpointChoice();
  const list = useLoad(() => trainer.rollouts(), [], 2000);
  const [task, setTask] = useState('pick up the object and place it at the target location');
  const [speed, setSpeed] = useState(0.3);
  const [maxDur, setMaxDur] = useState(45);
  const [limits, setLimits] = useState<any>(null);
  const [prep, setPrep] = useState<any>(null);
  const [confirm, setConfirm] = useState<'' | 'load' | 'run'>('');
  const [busy, setBusy] = useState('');
  const [outcome, setOutcome] = useState(false);
  const active = list.data?.active;
  const r = useRollout(active?.id || null);
  const status: string | undefined = r.data?.status;
  const live = r.data?.live || {};
  const moving = status === 'running';
  const lastId = useRef<string | null>(null);
  if (active?.id) lastId.current = active.id;
  const finished = useRollout(!active && lastId.current ? lastId.current : null);

  // heartbeat while a rollout is active: without it the worker holds position
  useEffect(() => {
    if (!active?.id || !ROLLOUT_ACTIVE.includes(status || '')) return;
    const id = setInterval(() => { trainer.rolloutHeartbeat(active.id).catch(() => {}); }, 1000);
    return () => clearInterval(id);
  }, [active?.id, status]);
  useEffect(() => { if (finished.data && !ROLLOUT_ACTIVE.includes(finished.data.status)) setOutcome(true); }, [finished.data?.status]);

  const request = () => buildRequest({ run: ck.run, step: ck.step, task, speed, maxDur, robotType: robot.robotType, params: robot.params, limits });
  const check = async () => { setBusy('check'); try { const p = await trainer.rolloutPrepare(request()); setPrep(p); if (!limits) setLimits(p.config.limits); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  const load = async () => { setConfirm(''); setBusy('load'); try { await trainer.rolloutStart(request(), prep.token); setPrep(null); toast.ok('Model loading; the robot does not move until you press Run'); list.reload(); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  const cmd = async (c: 'run' | 'pause' | 'stop' | 'estop') => {
    if (!active) return;
    setBusy(c);
    try { await trainer.rolloutCommand(active.id, c); if (c === 'estop') toast.warn('EMERGENCY STOP sent: worker is being killed'); list.reload(); r.reload(); } catch (e) { toast.error(e); } finally { setBusy(''); setConfirm(''); }
  };
  const cams = Object.entries(r.data?.config?.cameras || prep?.config?.cameras || {}) as [string, string][];
  const names: string[] = r.data?.config?.action_names || prep?.config?.action_names || [];

  const isActive = !!active && ROLLOUT_ACTIVE.includes(status || '');
  const followerTopic = robot.params?.joint_topic_list ? (robot.params.joint_topic_list.find((t: string) => t.startsWith('follower')) || 'follower:/joint_states').split(':').slice(1).join(':') : null;
  const elapsed = Number(live.elapsed_s || 0);
  const maxD = Number(r.data?.config?.max_duration_s || maxDur);

  const center = (
    <>
      {isActive && moving && <Callout tone="warn" title="Robot moving under policy control">Watch the robot. Stop holds position; EMERGENCY STOP kills the worker.</Callout>}
      <RobotCameras extra={cams} recording={moving} />
      {isActive && (
        <Panel title={moving ? 'Robot moving under policy control' : `Rollout ${status?.replace(/_/g, ' ')}`} sub={`${r.data?.config?.policy} · step ${r.data?.config?.step} · speed ${Math.round(100 * (r.data?.config?.speed_factor || 0))}% · max ${r.data?.config?.max_duration_s}s`}
          actions={<StatusBadge status={status} />} data-testid="rollout-live" data-status={status}>
          <div className="stack">
            {live.pause_reason && <Callout tone="warn" title="Holding position">{live.pause_reason}</Callout>}
            {!ready.ok && status === 'ready' && <Callout tone="danger" title="Robot not ready">Fix the readiness items before running.</Callout>}
            <div className="grid g4">
              <div className="panel stat"><span className="label">Steps</span><span className="stat-value">{live.step ?? 0}</span></div>
              <div className="panel stat"><span className="label">Rate</span><span className="stat-value">{live.rate_hz ?? '—'}<small>Hz</small></span></div>
              <div className="panel stat"><span className="label">Elapsed</span><span className="stat-value">{fmt.dur(live.elapsed_s)}</span></div>
              <div className="panel stat"><span className="label">Clamped</span><span className="stat-value">{Object.values(live.clamps || {}).reduce((a: number, b: any) => a + Number(b || 0), 0)}</span></div>
            </div>
            {(live.last || live.preview) && <PredictionTable names={names} state={(live.last || live.preview).state} raw={(live.last || live.preview).raw} safe={(live.last || live.preview).safe} notes={(live.last || live.preview).notes} />}
          </div>
        </Panel>
      )}
      {prep && !active && (
        <Panel title="Compatibility" actions={<Badge tone={prep.ok ? 'ok' : 'danger'}>{prep.ok ? 'compatible' : `${prep.errors.length} problem(s)`}</Badge>}>
          <div className="stack">
            {prep.errors.map((e: string) => <Callout key={e} tone="danger">{e}</Callout>)}
            {prep.warnings.map((e: string) => <Callout key={e} tone="warn">{e}</Callout>)}
            <KV items={[['Robot type', `${prep.config.robot_type} (active: ${robot.robotType || '—'})`], ['Reads', `${prep.config.state_topic} + ${Object.keys(prep.config.cameras).length} camera(s)`], ['Commands', prep.config.action_topic], ['Joints', prep.config.action_names.join(', ')], ['Device', prep.config.device]]} />
            <LimitsEditor limits={limits || prep.config.limits} proposal={prep.proposal} source={prep.limits_source} onChange={setLimits} datasetId={prep.config.dataset_id} />
            <div className="row"><Button onClick={check} busy={busy === 'check'} icon={<I.refresh />}>Re-check with these limits</Button><span className="small muted">Then press <b>Load</b> in the control bar; the robot stays still until <b>Run</b>.</span></div>
            {!ready.ok && <span className="small" style={{ color: 'var(--danger)' }}>The robot is not ready (see readiness).</span>}
          </div>
        </Panel>
      )}
      {outcome && finished.data && <OutcomeForm ro={finished.data} onDone={() => { setOutcome(false); lastId.current = null; }} />}
      <Logs id={active?.id} />
    </>
  );

  const side = (
    <>
      <SideSec label="Task information">
        {isActive ? <KV items={[['Model', r.data?.config?.policy], ['Checkpoint', `step ${fmt.num(r.data?.config?.step)}`], ['Speed', `${Math.round(100 * (r.data?.config?.speed_factor || 0))}%`], ['Max duration', `${r.data?.config?.max_duration_s} s`]]} /> : (
          <div className="stack">
            {ck.picker}
            <Field label="Task instruction"><TextArea rows={2} value={task} onChange={(e) => setTask(e.target.value)} /></Field>
            <Field label={`Speed: ${Math.round(speed * 100)}% of the demonstrations`} hint="Start low; the worker also limits each step"><input type="range" min={0.05} max={1} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} /></Field>
            <Field label="Maximum duration (s)"><NumberInput value={maxDur} onChange={(v) => setMaxDur(v ?? 45)} /></Field>
          </div>
        )}
      </SideSec>
      <Readiness r={ready} />
      <SideSec label="Follower arm">{followerTopic ? <LiveJoints topic={followerTopic} /> : <span className="small muted">Robot configuration not available.</span>}</SideSec>
      <SideSec label="Recent rollouts">
        {(list.data?.rollouts || []).length ? <div className="list">{list.data.rollouts.slice(0, 8).map((x: any) => (
          <div key={x.id} className="list-item"><div className="grow"><div className="small">{x.config?.policy} · step {x.config?.step}</div><div className="tiny muted">{fmt.ago(x.created_at)} · {x.end_reason || x.error || ''}</div></div><StatusBadge status={x.status} /></div>
        ))}</div> : <Empty icon={<I.rollout />} title="No rollouts yet" />}
      </SideSec>
    </>
  );

  const bar = (
    <ControlBar
      buttons={<>
        <BigButton tone={!active && !prep?.ok ? 'primary' : undefined} icon={<I.check />} disabled={!!active || !ck.run || !ck.step} busy={busy === 'check'} onClick={check} data-action="check-rollout">Check</BigButton>
        <BigButton tone={!active && prep?.ok ? 'primary' : undefined} icon={<I.download />} disabled={!!active || !prep?.ok || !!prep?.busy || !ready.ok} busy={busy === 'load'} onClick={() => setConfirm('load')} data-action="load-rollout" title="Load the model; the robot stays still">Load</BigButton>
        {moving
          ? <BigButton icon={<I.pause />} busy={busy === 'pause'} onClick={() => cmd('pause')} title="Pause and hold position">Pause</BigButton>
          : <BigButton tone={status === 'ready' || status === 'paused' ? 'primary' : undefined} icon={<I.play />} disabled={!(status === 'ready' || status === 'paused') || !ready.ok} onClick={() => setConfirm('run')} data-action="run">Run</BigButton>}
        <BigButton icon={<I.stop />} disabled={!isActive} busy={busy === 'stop'} onClick={() => cmd('stop')} data-action="stop-rollout">Stop</BigButton>
        <BigButton tone="danger" icon={<I.alert />} disabled={!active} onClick={() => cmd('estop')} data-action="estop" title="Kill the rollout worker immediately">E-STOP</BigButton>
      </>}
      title={isActive ? (moving ? 'Running on robot' : String(status).replace(/_/g, ' ')) : prep ? (prep.ok ? 'Ready to load' : 'Not compatible') : 'No model loaded'}
      dot={moving ? 'var(--err)' : isActive ? 'var(--warn)' : prep?.ok ? 'var(--ok)' : 'var(--ink-4)'}
      time={<>{Math.round(elapsed)} <span className="muted" style={{ fontSize: 13 }}>/ {maxD} s</span></>}
      pct={isActive ? (100 * elapsed) / Math.max(1, maxD) : 0} barColor={moving ? 'var(--err)' : 'var(--ink)'}
      hint={moving ? 'The robot moves under policy control. Keep this page open: without its heartbeat the robot holds position.' : isActive ? (status === 'ready' ? 'Model loaded, robot still. Press Run to start (checklist and typed confirmation).' : live.pause_reason || 'Preparing…') : prep?.ok ? 'Compatible. Load starts the worker with the robot still; nothing moves before Run.' : 'Choose a checkpoint, Check compatibility and limits, then Load. Nothing moves before Run.'}
      ring={isActive ? { value: live.step ?? 0, total: Math.max(live.step ?? 0, Math.round(maxD * (live.rate_hz || 0)) || (live.step ?? 0) || 1), label: 'Steps', sub: live.rate_hz ? `${live.rate_hz} Hz` : 'this rollout' } : undefined}
    />
  );

  return (
    <>
      <Console tabs={tabs} top={isActive ? <button className="estop" onClick={() => cmd('estop')}>EMERGENCY STOP</button> : undefined} center={center} side={side} bar={bar} sideTestId="rollout-side" />
      <Confirm open={confirm === 'load'} onClose={() => setConfirm('')} title="Load the model" confirmLabel="Load (no motion)" checks={CHECKS.slice(0, 2)} onConfirm={load} busy={busy === 'load'}>
        The worker loads the checkpoint and connects to the robot. It publishes nothing until you press Run.
      </Confirm>
      <Confirm open={confirm === 'run'} onClose={() => setConfirm('')} danger title="Run the policy on the robot" confirmLabel="Run" checks={CHECKS} typeToConfirm="run" onConfirm={() => cmd('run')} busy={busy === 'run'}>
        The robot will move under policy control at {Math.round(100 * (r.data?.config?.speed_factor || speed))}% speed for at most {r.data?.config?.max_duration_s || maxDur} s. Keep this page open: if its heartbeat stops, the robot holds position.
      </Confirm>
    </>
  );
}

function LimitsEditor({ limits, proposal, source, onChange, datasetId }: { limits: any; proposal: any; source: string; onChange: (l: any) => void; datasetId: string }) {
  const toast = useToast();
  const joints: any[] = limits?.joints || [];
  const set = (i: number, k: string, v: number | null) => onChange({ joints: joints.map((j, n) => (n === i ? { ...j, [k]: v } : j)) });
  return (
    <div className="stack-sm">
      <div className="row-between"><b className="small">Safety envelope</b><span className="tiny muted">from {source} · may only be tightened inside the training data range</span></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Joint</th><th>Min</th><th>Max</th><th>Max step</th><th>Max lead</th><th className="muted">Data range</th></tr></thead>
        <tbody>{joints.map((j, i) => {
          const p = (proposal?.joints || []).find((x: any) => x.name === j.name);
          return (
            <tr key={j.name}><td className="mono small">{j.name}</td>
              {['min', 'max', 'max_step', 'max_lead'].map((k) => <td key={k}><NumberInput value={j[k]} step={0.01} onChange={(v) => set(i, k, v)} style={{ width: 90, height: 28 }} /></td>)}
              <td className="tiny muted num">{p ? `${p.min?.toFixed?.(2)} … ${p.max?.toFixed?.(2)}` : '—'}</td></tr>
          );
        })}</tbody></table></div>
      <div className="row"><Button size="sm" onClick={() => onChange(proposal)}>Reset to training data</Button><Button size="sm" variant="ghost" onClick={() => trainer.rolloutLimits(datasetId, joints).then(() => toast.ok('Saved as defaults for this dataset'), toast.error)}>Save as defaults</Button></div>
    </div>
  );
}

function OutcomeForm({ ro, onDone }: { ro: any; onDone: () => void }) {
  const toast = useToast();
  const ev = useLoad(() => trainer.evaluations(ro.config?.run_id), [ro.id]);
  const [outcome, setOutcome] = useState('success');
  const [notes, setNotes] = useState('');
  return (
    <Panel title="Record the result" sub={`Rollout ${ro.status}: ${ro.end_reason || ro.error || ''}`} footer={<><Button onClick={onDone}>Skip</Button><Button variant="primary" data-action="save-outcome" onClick={async () => {
      try { await trainer.addTrial({ run_id: ro.config.run_id, step: ro.config.step, outcome, notes, rollout_id: ro.id, duration_s: ro.live?.elapsed_s }); toast.ok('Saved to the Evaluation Studio'); onDone(); } catch (e) { toast.error(e); }
    }}>Save result</Button></>}>
      <div className="grid g2">
        <Field label="Outcome"><Select value={outcome} onChange={setOutcome} options={Object.entries(ev.data?.outcomes || { success: 'Success' }).map(([value, label]) => ({ value, label: String(label) }))} /></Field>
        <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Panel>
  );
}

export function RobotInference({ tabs }: { tabs?: ReactNode }) {
  const toast = useToast();
  const ready = useReadiness();
  const { taskStatus, robotType } = useSystem();
  const policies = useLoad(() => ros.policies(), []);
  const [policy, setPolicy] = useState('');
  const [task, setTask] = useState('pick up the object and place it at the target location');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState('');
  const running = taskStatus?.phase === PHASE.INFERENCING;
  const start = async () => {
    setConfirm(false); setBusy('start');
    try {
      const r = await ros.task('start_inference', { task_name: 'physios_inference', task_type: 'inference', task_instruction: [task], policy_path: policy, fps: 30, tags: [robotType, 'physios'], user_id: '' }, true);
      r.success ? toast.ok('On-robot inference started') : toast.warn(r.message);
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const stop = async () => { setBusy('stop'); try { const r = await ros.task('stop', taskStatus?.task_info || {}); r.success ? toast.ok('Stopped') : toast.warn(r.message); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  const phase = taskStatus?.phase;
  const center = (
    <>
      {running && <Callout tone="warn" title="Robot moving under container inference">Supervise closely. Stop sends STOP to physical_ai_server.</Callout>}
      <RobotCameras recording={running} />
      <Callout tone="warn" title="Fewer safeguards than the host rollout">This engine has no joint envelope or heartbeat hold from PHYSIOS. Supervise closely; Stop sends STOP to physical_ai_server.</Callout>
    </>
  );
  const side = (
    <>
      <SideSec label="Task information" actions={running ? <Badge tone="warn" dot>running</Badge> : <Badge>idle</Badge>}>
        <div className="stack">
          <div className="tiny muted">physical_ai_server runs a policy saved on the robot side (ROBOTIS inference).</div>
          {policies.error ? <Callout tone="warn">{(policies.error as Error).message}</Callout> : !policies.data ? <Loading rows={2} /> : !policies.data.policies.length ? <Empty title="No policies saved on the robot side" /> : (
            <Field label="Policy"><Select value={policy} onChange={setPolicy} disabled={running} options={policies.data.policies.map((p) => ({ value: p.path, label: `${p.path} (${p.type})` }))} placeholder="Select…" /></Field>
          )}
          <Field label="Task instruction"><TextArea rows={2} value={task} disabled={running} onChange={(e) => setTask(e.target.value)} /></Field>
        </div>
      </SideSec>
      <Readiness r={ready} />
    </>
  );
  const bar = (
    <ControlBar
      buttons={<>
        <BigButton tone={!running && policy && ready.ok ? 'primary' : undefined} icon={<I.play />} disabled={running || !policy || !ready.ok} busy={busy === 'start'} onClick={() => setConfirm(true)} data-action="start-inference">Start</BigButton>
        <BigButton icon={<I.stop />} disabled={!running} busy={busy === 'stop'} onClick={stop}>Stop</BigButton>
        <BigButton tone="danger" icon={<I.alert />} disabled={!running} onClick={stop} title="Send STOP to physical_ai_server">E-STOP</BigButton>
      </>}
      title={running ? 'Inferencing' : phase != null ? PHASES[phase] : 'No status'}
      dot={running ? 'var(--err)' : 'var(--ink-4)'}
      time={<>{Math.round(taskStatus?.proceed_time || 0)} <span className="muted" style={{ fontSize: 13 }}>s</span></>}
      pct={running ? 100 : 0} barColor="var(--err)"
      hint={running ? 'Policy running on the robot.' : 'Select a policy saved on the robot side, then press Start (checklist and typed confirmation).'}
    />
  );
  return (
    <>
      <Console tabs={tabs} top={running ? <button className="estop" onClick={stop}>EMERGENCY STOP</button> : undefined} center={center} side={side} bar={bar} sideTestId="container-side" />
      <Confirm open={confirm} onClose={() => setConfirm(false)} danger title="Start on-robot inference" confirmLabel="Start" checks={CHECKS} typeToConfirm="run" onConfirm={start}>
        The robot will move under control of <span className="mono">{policy}</span> until you stop it.
      </Confirm>
    </>
  );
}
