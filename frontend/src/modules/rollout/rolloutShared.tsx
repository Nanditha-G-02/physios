// Shared by Inference Studio and Robot Rollout: checkpoint picker, rollout request builder,
// live rollout state and the prediction table. The worker (pam_trainer/rollout_worker.py)
// enforces every safety limit; the page only displays and commands.
import { useEffect, useState } from 'react';
import { planning } from '@/api/gateway';
import { trainer } from '@/api/trainer';
import { useSystem } from '@/app/system';
import { CodeBlock, ErrorState, Field, Panel, Select, fmt } from '@/design/ui';
import { useLoad } from '@/hooks/data';

export function useCheckpointChoice(initialRun?: string | null, initialStep?: string | null) {
  const runs = useLoad(() => trainer.runs(), [], 0);
  const [run, setRun] = useState(initialRun || '');
  const [step, setStep] = useState(initialStep || '');
  const cks = useLoad(() => trainer.checkpoints(run), [run], 0, !!run);
  const list: any[] = (runs.data?.runs || []).filter((r: any) => r.progress?.step > 0);
  useEffect(() => {
    const c: any[] = cks.data?.checkpoints || [];
    if (c.length && !c.some((x) => String(x.step) === step)) setStep(String((c.find((x) => x.is_last) || c[c.length - 1]).step));
  }, [cks.data, step]);
  const picker = (
    <div className="grid g2">
      <Field label="Trained model"><Select value={run} onChange={(v) => { setRun(v); setStep(''); }} options={list.map((r) => ({ value: r.id, label: `${r.job_name} · ${r.policy}` }))} placeholder="Select a training run…" data-field="model-run" /></Field>
      <Field label="Checkpoint"><Select value={step} onChange={setStep} options={(cks.data?.checkpoints || []).map((c: any) => ({ value: String(c.step), label: `step ${fmt.num(c.step)}${c.is_last ? ' (last)' : ''}` }))} placeholder="—" /></Field>
    </div>
  );
  const runObj = list.find((r) => r.id === run);
  return { run, step, setRun, setStep, picker, runObj, loading: runs.loading };
}

/** Robot configuration as physical_ai_server reports it (topics, joint order). */
export function useRobotConfig() {
  const { robotType, health } = useSystem();
  const ros = health?.services?.ros_node?.status === 'ok';
  const prof = useLoad(() => planning('robot.profile', {}), [robotType, ros], 0, ros);
  return { robotType, params: prof.data?.params || {}, error: prof.error, loading: prof.loading };
}

export function buildRequest(o: { run: string; step: string; task: string; speed: number; maxDur: number; device?: string; robotType: string; params: any; limits?: any }) {
  return {
    run_id: o.run, step: Number(o.step), task: o.task, speed_factor: o.speed, max_duration_s: o.maxDur,
    device: o.device || undefined, limits: o.limits || undefined, rosbridge_host: '127.0.0.1',
    robot: { robot_type: o.robotType, camera_topic_list: o.params.camera_topic_list || [], joint_topic_list: o.params.joint_topic_list || [], joint_order: o.params.joint_order || {} },
  };
}

export function useRollout(id: string | null) {
  const r = useLoad(() => trainer.rollout(id!), [id], 700, !!id);
  return r;
}

export const ROLLOUT_ACTIVE = ['loading', 'connecting', 'waiting_for_data', 'ready', 'running', 'paused', 'starting'];

export function PredictionTable({ names, state, raw, safe, notes }: { names: string[]; state?: number[]; raw?: number[]; safe?: number[] | null; notes?: string[] }) {
  return (
    <div className="stack-sm">
      <div className="table-wrap"><table className="table" data-testid="prediction"><thead><tr><th>Joint</th><th className="right">Measured</th><th className="right">Model output</th><th className="right">After safety filter</th><th className="right">Δ command</th></tr></thead>
        <tbody>{names.map((n, i) => {
          const d = safe && state ? safe[i] - state[i] : null;
          const clamped = raw && safe && Math.abs(raw[i] - safe[i]) > 1e-6;
          return (
            <tr key={n}><td className="mono small">{n}</td><td className="right num mono small">{state?.[i]?.toFixed(3) ?? '—'}</td><td className="right num mono small">{raw?.[i]?.toFixed(3) ?? '—'}</td>
              <td className="right num mono small" style={{ color: clamped ? 'var(--warn)' : undefined }}>{safe ? safe[i]?.toFixed(3) : <span style={{ color: 'var(--danger)' }}>blocked</span>}</td>
              <td className="right num mono small">{d == null ? '—' : (d >= 0 ? '+' : '') + d.toFixed(3)}</td></tr>
          );
        })}</tbody></table></div>
      {notes && notes.length > 0 && <div className="tiny" style={{ color: 'var(--warn)' }}>{notes.join(' · ')}</div>}
    </div>
  );
}

export function Logs({ id }: { id?: string }) {
  const log = useLoad(() => trainer.rolloutLog(id!), [id], 2500, !!id);
  if (!id) return null;
  const text = log.data?.text ?? (log.data?.lines || []).join('\n');
  return <Panel title="Worker log">{log.error ? <ErrorState error={log.error} /> : <CodeBlock className="log" text={text || 'No output yet.'} />}</Panel>;
}
