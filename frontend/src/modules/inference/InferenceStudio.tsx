// MODULE 9: Inference Studio. Loads a trained checkpoint in the host rollout worker and runs
// it on the live camera and joint data WITHOUT publishing commands (dry run). The robot does
// not move here; Robot Rollout continues from a loaded, ready model.
import { useState } from 'react';
import { ros } from '@/api/gateway';
import { trainer } from '@/api/trainer';
import { Link, useRouter } from '@/app/router';
import { useAvailability } from '@/app/system';
import { I } from '@/design/icons';
import { Badge, Button, Callout, CodeBlock, Empty, ErrorState, Field, KV, Loading, Panel, Select, StatusBadge, TextArea, fmt, useToast } from '@/design/ui';
import { useLoad } from '@/hooks/data';
import { CameraView, Page, Requires } from '../shared';
import { PredictionTable, ROLLOUT_ACTIVE, buildRequest, useCheckpointChoice, useRobotConfig, useRollout } from '../rollout/rolloutShared';

export default function InferenceStudio() {
  return (
    <Page intro="Load a trained checkpoint and watch what it would do: the model reads the live cameras and joint states and its predicted actions are shown after the same safety filter used on the robot. Nothing is sent to the robot in this studio.">
      <Requires service="trainer" what="Inference"><Studio /></Requires>
    </Page>
  );
}

function Studio() {
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

  const request = () => buildRequest({ run: ck.run, step: ck.step, task, speed: 0.3, maxDur: 45, device, robotType: robot.robotType, params: robot.params });
  const check = async () => { setBusy('check'); try { setPrep(await trainer.rolloutPrepare(request())); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  const load = async () => {
    setBusy('load');
    try { await trainer.rolloutStart(request(), prep.token); toast.ok('Loading model (dry run, no motion)'); setPrep(null); active.reload(); } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const unload = async () => { if (!current) return; setBusy('stop'); try { await trainer.rolloutCommand(current.id, 'stop'); toast.ok('Model unloaded'); active.reload(); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  const cams = Object.entries(r.data?.config?.cameras || prep?.config?.cameras || {}) as [string, string][];

  return (
    <div className="grid g-side">
      <div className="stack">
        {current && ROLLOUT_ACTIVE.includes(status) ? (
          <Panel title="Loaded model" sub={`${r.data?.config?.policy} · step ${r.data?.config?.step} · ${r.data?.config?.device}`} actions={<StatusBadge status={status} />} data-testid="loaded-model">
            <div className="stack">
              {status === 'running' && <Callout tone="warn" title="This model is moving the robot">It was started from Robot Rollout. Control it there.</Callout>}
              {['loading', 'connecting', 'waiting_for_data', 'starting'].includes(status) && <div className="row small"><span className="spinner" />{status.replace(/_/g, ' ')}… {live.pause_reason || ''}</div>}
              {preview ? (
                <>
                  <div className="row"><b>First prediction</b><Badge tone={preview.verdict === 'ok' ? 'ok' : preview.verdict === 'clamped' ? 'warn' : 'danger'}>{preview.verdict}</Badge></div>
                  <PredictionTable names={r.data?.config?.action_names || []} state={preview.state} raw={preview.raw} safe={preview.safe} notes={preview.notes} />
                  {preview.verdict === 'unsafe' && <Callout tone="danger" title="The first action is outside the safety envelope">The rollout would stop instead of moving. Check the camera setup and the joint limits.</Callout>}
                </>
              ) : status === 'ready' ? <span className="small muted">Waiting for the first prediction…</span> : null}
              {live.last && <><b className="small">Latest prediction</b><PredictionTable names={r.data?.config?.action_names || []} state={live.last.state} raw={live.last.raw} safe={live.last.safe} notes={live.last.notes} /></>}
              <div className="row">
                <Button variant="danger" icon={<I.stop />} busy={busy === 'stop'} onClick={unload}>Unload model</Button>
                {status === 'ready' && <Button variant="primary" icon={<I.rollout />} onClick={() => go('/rollout')} data-action="to-rollout">Continue to Robot Rollout</Button>}
              </div>
            </div>
          </Panel>
        ) : (
          <Panel title="Model" sub="Checkpoints from local trainings">
            <div className="stack">
              {ck.picker}
              <Field label="Task instruction" hint="Language-conditioned policies (SmolVLA) need it; others ignore it"><TextArea rows={2} value={task} onChange={(e) => setTask(e.target.value)} /></Field>
              <Field label="Device"><Select value={device} onChange={setDevice} options={[{ value: '', label: 'Automatic (GPU if available)' }, { value: 'cuda', label: 'cuda' }, { value: 'cpu', label: 'cpu' }]} /></Field>
              {!av.ros && <Callout tone="warn" title="Robot side offline">The model needs live camera and joint topics from physical_ai_server.</Callout>}
              <div className="row"><Button variant="primary" disabled={!ck.run || !ck.step} busy={busy === 'check'} onClick={check} data-action="check-model">Check compatibility</Button></div>
            </div>
          </Panel>
        )}
        {prep && (
          <Panel title={prep.ok ? 'Ready to load' : 'Cannot load'} actions={<Badge tone={prep.ok ? 'ok' : 'danger'}>{prep.ok ? 'compatible' : `${prep.errors.length} problem(s)`}</Badge>}>
            <div className="stack">
              {prep.errors.map((e: string) => <Callout key={e} tone="danger">{e}</Callout>)}
              {prep.warnings.map((e: string) => <Callout key={e} tone="warn">{e}</Callout>)}
              <KV items={[['Checkpoint', <span className="mono tiny">{prep.config.checkpoint}</span>], ['Policy', prep.config.policy], ['Robot type', prep.config.robot_type], ['State topic', prep.config.state_topic], ['Command topic', `${prep.config.action_topic} (not used in dry run)`], ['Cameras', Object.entries(prep.config.cameras).map(([k, v]) => `${k.split('.').pop()} ← ${v}`).join(', ')], ['Joints', prep.config.action_names.join(', ')], ['Limits from', prep.limits_source]]} />
              {prep.busy && <Callout tone="warn">Another rollout is active ({prep.busy.status}).</Callout>}
              <Button variant="primary" disabled={!prep.ok || !!prep.busy} busy={busy === 'load'} onClick={load} data-action="load-model">Load model (dry run)</Button>
            </div>
          </Panel>
        )}
        <Logs id={current?.id} />
      </div>
      <div className="stack">
        <Panel title="Live input" sub="What the model sees">
          {cams.length ? <div className="stack">{cams.map(([k, t]) => <CameraView key={k} topic={t} label={k.split('.').pop()} quality={40} />)}</div> : <Empty icon={<I.camera />} title="Cameras appear after the compatibility check" />}
        </Panel>
        <Panel title="Runtime">
          {current ? <KV items={[['Status', status], ['Rate', live.rate_hz ? `${live.rate_hz} Hz` : '—'], ['Steps', live.step ?? 0], ['Started', fmt.time(r.data?.created_at)], ['Warnings', (live.warnings || []).join('; ') || '—']]} /> : <span className="small muted">No model loaded.</span>}
        </Panel>
        {av.ros && (
          <Panel title="Policies on the robot side" sub="Saved in physical_ai_server (ROBOTIS inference); run them from Robot Rollout">
            {policies.error ? <ErrorState error={policies.error} /> : !policies.data ? <Loading rows={2} /> : policies.data.policies.length ? <div className="stack-sm small">{policies.data.policies.map((p) => <div key={p.path} className="row-between"><span className="mono ellipsis tiny">{p.path}</span><Badge>{p.type}</Badge></div>)}</div> : <span className="small muted">None saved.</span>}
          </Panel>
        )}
        <Link to="/evaluation" className="btn btn-ghost">Evaluation Studio<I.chevron /></Link>
      </div>
    </div>
  );
}

export function Logs({ id }: { id?: string }) {
  const log = useLoad(() => trainer.rolloutLog(id!), [id], 2500, !!id);
  if (!id) return null;
  const text = log.data?.text ?? (log.data?.lines || []).join('\n');
  return <Panel title="Worker log">{log.error ? <ErrorState error={log.error} /> : <CodeBlock className="log" text={text || 'No output yet.'} />}</Panel>;
}

