// MODULE 9: Inference Studio. Loads a trained checkpoint in the host rollout worker and runs
// it on the live camera and joint data WITHOUT publishing commands (dry run). The robot does
// not move here; Robot Rollout continues from a loaded, ready model.
import { useState } from 'react';
import type { ReactNode } from 'react';
import { ros } from '@/api/gateway';
import { trainer } from '@/api/trainer';
import { Link, useRouter } from '@/app/router';
import { useAvailability } from '@/app/system';
import { I } from '@/design/icons';
import { Badge, Callout, Field, KV, Loading, Panel, Select, StatusBadge, TextArea, fmt, useToast } from '@/design/ui';
import { useLoad } from '@/hooks/data';
import { BigButton, Console, ControlBar, Requires, RobotCameras, RouteTabs, SideSec } from '../shared';
import { HostRollout, RobotInference } from '../rollout/RolloutStudio';
import { Logs, PredictionTable, ROLLOUT_ACTIVE, buildRequest, useCheckpointChoice, useRobotConfig, useRollout } from '../rollout/rolloutShared';

export type InferenceView = 'check' | 'rollout' | 'container';

/** 06 · Inference, laid out like the Physical AI Manager inference page: tabs and robot type
 *  at the top left, live cameras in the middle, the task sheet on the right and the control
 *  bar at the bottom. Tabs: model check (dry run, no motion), host rollout of a model trained
 *  on this PC, and container (physical_ai_server) inference. */
export default function InferenceStudio({ view = 'check' }: { view?: InferenceView }) {
  const av = useAvailability();
  const tabs: [InferenceView, string, string][] = [['check', '/inference', 'Model check (dry run)'], ['rollout', '/inference/rollout', 'Host rollout (trained on this PC)'], ['container', '/inference/container', 'Container inference']];
  const tabEl = <RouteTabs items={tabs.map(([id, to, label]) => ({ to, label, active: id === view }))} />;
  const need = view === 'container' ? 'ros' : 'trainer';
  const ok = need === 'ros' ? av.ros : av.trainer;
  if (!av.known || !ok) {
    return <Console tabs={tabEl} center={<Requires service={need} what={view === 'check' ? 'Inference' : view === 'rollout' ? 'Host rollout' : 'Container inference'}><span /></Requires>}
      side={<SideSec label="06 · Inference"><div className="small muted">Run a trained policy on the robot. The robot only moves after you start it; Stop and Emergency stop are always available.</div></SideSec>} />;
  }
  return view === 'check' ? <Studio tabs={tabEl} /> : view === 'rollout' ? <HostRollout tabs={tabEl} /> : <RobotInference tabs={tabEl} />;
}

function Studio({ tabs }: { tabs: ReactNode }) {
  const toast = useToast();
  const { loc, go } = useRouter();
  const av = useAvailability();
  const ck = useCheckpointChoice(loc.query.get('run'), loc.query.get('step'));
  const robot = useRobotConfig();
  const active = useLoad(() => trainer.rollouts(), [], 3000);
  const [task, setTask] = useState('pick up the object and place it at the target location');
  const [device, setDevice] = useState('');
  const [prep, setPrep] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const current = active.data?.active;
  const r = useRollout(current?.id || null);
  const live = r.data?.live || {};
  const status = r.data?.status;
  const preview = live.preview;
  const policies = useLoad(() => ros.policies(), [av.ros], 0, av.ros);
  const loaded = !!current && ROLLOUT_ACTIVE.includes(status);

  const request = () => buildRequest({ run: ck.run, step: ck.step, task, speed: 0.3, maxDur: 45, device, robotType: robot.robotType, params: robot.params });
  const check = async () => { setBusy('check'); try { setPrep(await trainer.rolloutPrepare(request())); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  const load = async () => {
    setBusy('load');
    try { await trainer.rolloutStart(request(), prep.token); toast.ok('Loading model (dry run, no motion)'); setPrep(null); active.reload(); } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const unload = async () => { if (!current) return; setBusy('stop'); try { await trainer.rolloutCommand(current.id, 'stop'); toast.ok('Model unloaded'); active.reload(); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  const cams = Object.entries(r.data?.config?.cameras || prep?.config?.cameras || {}) as [string, string][];
  const lastFailed = !current && active.data?.rollouts?.[0]?.status === 'failed' && Date.now() - Date.parse(active.data.rollouts[0].created_at) < 15 * 60000 ? active.data.rollouts[0] : null;

  const center = (
    <>
      <RobotCameras extra={cams} />
      {loaded && (
        <Panel title="Loaded model" sub={`${r.data?.config?.policy} · step ${r.data?.config?.step} · ${r.data?.config?.device}`} actions={<StatusBadge status={status} />} data-testid="loaded-model">
          <div className="stack">
            {status === 'running' && <Callout tone="warn" title="This model is moving the robot">It was started from Host rollout. Control it there.</Callout>}
            {['loading', 'connecting', 'waiting_for_data', 'starting'].includes(status) && <div className="row small"><span className="spinner" />{status.replace(/_/g, ' ')}… {live.pause_reason || ''}</div>}
            {preview ? (
              <>
                <div className="row"><b>First prediction</b><Badge tone={preview.verdict === 'ok' ? 'ok' : preview.verdict === 'clamped' ? 'warn' : 'danger'}>{preview.verdict}</Badge></div>
                <PredictionTable names={r.data?.config?.action_names || []} state={preview.state} raw={preview.raw} safe={preview.safe} notes={preview.notes} />
                {preview.verdict === 'unsafe' && <Callout tone="danger" title="The first action is outside the safety envelope">The rollout would stop instead of moving. Check the camera setup and the joint limits.</Callout>}
              </>
            ) : status === 'ready' ? <span className="small muted">Waiting for the first prediction…</span> : null}
            {live.last && <><b className="small">Latest prediction</b><PredictionTable names={r.data?.config?.action_names || []} state={live.last.state} raw={live.last.raw} safe={live.last.safe} notes={live.last.notes} /></>}
          </div>
        </Panel>
      )}
      {prep && !loaded && (
        <Panel title={prep.ok ? 'Ready to load' : 'Cannot load'} actions={<Badge tone={prep.ok ? 'ok' : 'danger'}>{prep.ok ? 'compatible' : `${prep.errors.length} problem(s)`}</Badge>}>
          <div className="stack">
            {prep.errors.map((e: string) => <Callout key={e} tone="danger">{e}</Callout>)}
            {prep.warnings.map((e: string) => <Callout key={e} tone="warn">{e}</Callout>)}
            <KV items={[['Checkpoint', <span className="mono tiny">{prep.config.checkpoint}</span>], ['Policy', prep.config.policy], ['Robot type', prep.config.robot_type], ['State topic', prep.config.state_topic], ['Command topic', `${prep.config.action_topic} (not used in dry run)`], ['Cameras', Object.entries(prep.config.cameras).map(([k, v]) => `${k.split('.').pop()} ← ${v}`).join(', ')], ['Joints', prep.config.action_names.join(', ')], ['Limits from', prep.limits_source]]} />
            {prep.busy && <Callout tone="warn">Another rollout is active ({prep.busy.status}).</Callout>}
            <div className="small muted">Press <b>Load</b> in the control bar to load it as a dry run.</div>
          </div>
        </Panel>
      )}
      {lastFailed && (
        <Panel title="Last load attempt failed" actions={<StatusBadge status="failed" />} data-testid="last-failed">
          <Callout tone="danger" title={lastFailed.error || lastFailed.end_reason || 'The worker stopped.'}>The worker log below shows why. Nothing was sent to the robot.</Callout>
        </Panel>
      )}
      <Logs id={current?.id || lastFailed?.id} />
    </>
  );

  const side = (
    <>
      <SideSec label="Task information">
        <div className="stack">
          {loaded ? <KV items={[['Model', r.data?.config?.policy], ['Checkpoint', `step ${fmt.num(r.data?.config?.step)}`], ['Device', r.data?.config?.device], ['Instruction', r.data?.config?.task || task]]} /> : (
            <>
              {ck.picker}
              <Field label="Task instruction" hint="Language-conditioned policies (SmolVLA) need it; others ignore it"><TextArea rows={2} value={task} onChange={(e) => setTask(e.target.value)} /></Field>
              <Field label="Device"><Select value={device} onChange={setDevice} options={[{ value: '', label: 'Automatic (GPU if available)' }, { value: 'cuda', label: 'cuda' }, { value: 'cpu', label: 'cpu' }]} /></Field>
            </>
          )}
          {!av.ros && <Callout tone="warn" title="Robot side offline">The model needs live camera and joint topics from physical_ai_server.</Callout>}
          <div className="tiny muted">Dry run: the model reads the live cameras and joints, and its output goes through the safety filter. Nothing is sent to the robot.</div>
        </div>
      </SideSec>
      <SideSec label="Runtime">
        {current ? <KV items={[['Status', status], ['Rate', live.rate_hz ? `${live.rate_hz} Hz` : '—'], ['Steps', live.step ?? 0], ['Started', fmt.time(r.data?.created_at)], ['Warnings', (live.warnings || []).join('; ') || '—']]} /> : <span className="small muted">No model loaded.</span>}
      </SideSec>
      {av.ros && (
        <SideSec label="Policies on the robot side">
          {policies.error ? <span className="small muted">Not available: {(policies.error as Error).message}</span> : !policies.data ? <Loading rows={2} /> : policies.data.policies.length ? <div className="stack-sm small">{policies.data.policies.map((p) => <div key={p.path} className="row-between"><span className="mono ellipsis tiny">{p.path}</span><Badge>{p.type}</Badge></div>)}</div> : <span className="small muted">None saved. Run them from Container inference.</span>}
        </SideSec>
      )}
      <SideSec><Link to="/training/evaluate" className="btn btn-sm">Evaluate in Training →</Link></SideSec>
    </>
  );

  const bar = (
    <ControlBar
      buttons={<>
        <BigButton tone={!loaded && !prep?.ok ? 'primary' : undefined} icon={<I.check />} disabled={loaded || !ck.run || !ck.step} busy={busy === 'check'} onClick={check} data-action="check-model">Check</BigButton>
        <BigButton tone={!loaded && prep?.ok ? 'primary' : undefined} icon={<I.download />} disabled={loaded || !prep?.ok || !!prep?.busy} busy={busy === 'load'} onClick={load} data-action="load-model">Load</BigButton>
        <BigButton icon={<I.stop />} disabled={!current} busy={busy === 'stop'} onClick={unload}>Unload</BigButton>
        <BigButton tone={status === 'ready' ? 'primary' : undefined} icon={<I.rollout />} disabled={status !== 'ready'} onClick={() => go('/inference/rollout')} data-action="to-rollout">Rollout</BigButton>
      </>}
      title={loaded ? `Model ${String(status).replace(/_/g, ' ')}` : prep ? (prep.ok ? 'Ready to load' : 'Not compatible') : 'No model loaded'}
      dot={loaded ? (status === 'ready' ? 'var(--ok)' : 'var(--warn)') : 'var(--ink-4)'}
      time={<>{live.step ?? 0} <span className="muted" style={{ fontSize: 13 }}>steps</span></>}
      pct={loaded ? 100 : prep ? 50 : 0} barColor={loaded ? 'var(--ok)' : 'var(--ink)'}
      hint={loaded ? (live.rate_hz ? `${live.rate_hz} Hz · nothing is sent to the robot` : 'Waiting for predictions.') : 'Choose a checkpoint on the right, then Check and Load. The robot does not move on this tab.'}
    />
  );
  return <Console tabs={tabs} center={center} side={side} bar={bar} sideTestId="inference-side" />;
}
