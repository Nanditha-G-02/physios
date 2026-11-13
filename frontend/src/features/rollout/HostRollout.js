// Copyright 2026 ROBOTIS CO., LTD.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Host rollout: run a checkpoint trained on this PC on the robot. The training
// service starts a worker in the conda environment of the run; it talks to the
// robot only through ROS (same topics as the Inference session) and enforces
// the safety limits shown here. The page must stay open while the arm moves.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useTrainer } from '../../hooks/useTrainer';
import { usePlanningService } from '../../hooks/usePlanningService';
import CameraMatchCheck from '../camera/CameraMatchCheck';
import { OUTCOME_COLOR } from '../evaluation/EvaluationPanel';
import { setRolloutTarget } from '../planning/planningSlice';
import { Callout, Field, Modal, NumberInput, Select, Sheet, Spinner, TextInput } from '../../components/ui';

const PHASE = {
  starting: ['chip-sky', 'Starting'],
  loading: ['chip-sky', 'Loading model'],
  connecting: ['chip-sky', 'Connecting to ROS'],
  waiting_for_data: ['chip-warn', 'Waiting for robot data'],
  ready: ['chip-ok', 'Ready — not moving'],
  running: ['chip-err', 'Moving'],
  paused: ['chip-warn', 'Holding'],
  finished: ['chip', 'Finished'],
  stopped: ['chip', 'Stopped'],
  failed: ['chip-err', 'Failed'],
  interrupted: ['chip-err', 'Interrupted'],
};
const LIVE = ['starting', 'loading', 'connecting', 'waiting_for_data', 'ready', 'running', 'paused'];

function JointBars({ names, rows, limits }) {
  // one row per joint: allowed range, measured state, raw model action, sent action
  return (
    <div className="grid gap-1.5">
      {names.map((n, i) => {
        const l = limits?.[i];
        if (!l) return null;
        const pad = (l.max - l.min) * 0.3;
        const lo = l.min - pad;
        const hi = l.max + pad;
        const x = (v) => `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100))}%`;
        return (
          <div key={n} className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-2 text-[11.5px]">
            <span className="truncate text-ink-2">{n}</span>
            <div className="relative h-4 rounded-pill bg-paper-2">
              <div
                className="absolute inset-y-0 rounded-pill bg-white border border-rule"
                style={{ left: x(l.min), width: `calc(${x(l.max)} - ${x(l.min)})` }}
              />
              {rows.state && (
                <span
                  className="absolute top-0 h-4 w-[3px] -translate-x-1/2 bg-ink"
                  style={{ left: x(rows.state[i]) }}
                  title={`measured ${rows.state[i]?.toFixed(3)}`}
                />
              )}
              {rows.raw && (
                <span
                  className="absolute top-[3px] h-2.5 w-2.5 -translate-x-1/2 rounded-full border-2 border-[#eb6834] bg-white"
                  style={{ left: x(rows.raw[i]) }}
                  title={`model ${rows.raw[i]?.toFixed(3)}`}
                />
              )}
              {rows.safe && (
                <span
                  className="absolute top-[4px] h-2 w-2 -translate-x-1/2 rounded-full bg-sky-ink"
                  style={{ left: x(rows.safe[i]) }}
                  title={`sent ${rows.safe[i]?.toFixed(3)}`}
                />
              )}
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-3 text-[11px] text-ink-3 pl-[118px]">
        <span className="inline-flex items-center gap-1">
          <span className="h-3 w-[3px] bg-ink" /> measured
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-full border-2 border-[#eb6834]" /> model output
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-sky-ink" /> sent (after limits)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2.5 w-4 rounded-pill bg-white border border-rule" /> allowed range
        </span>
      </div>
    </div>
  );
}

export default function HostRollout() {
  const dispatch = useDispatch();
  const { get, post } = useTrainer();
  const { call } = usePlanningService();
  const target = useSelector((s) => s.planning.rolloutTarget);
  const robotType = useSelector((s) => s.tasks.taskStatus.robotType);
  const rosHost = useSelector((s) => s.ros.rosHost);
  const [runs, setRuns] = useState(null);
  const [offline, setOffline] = useState('');
  const [runId, setRunId] = useState(target?.run_id || '');
  const [ckpts, setCkpts] = useState([]);
  const [step, setStep] = useState(target?.step ? String(target.step) : '');
  const [robot, setRobot] = useState(null);
  const [task, setTask] = useState('');
  const [speed, setSpeed] = useState(30);
  const [maxDur, setMaxDur] = useState(45);
  const [limits, setLimits] = useState(null);
  const [prep, setPrep] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const [ack, setAck] = useState(false);
  const [rollout, setRollout] = useState(null);
  const [moveConfirm, setMoveConfirm] = useState(false);
  const [log, setLog] = useState('');
  const [trial, setTrial] = useState({ outcome: null, notes: '', x: '', y: '' });
  const [unverified, setUnverified] = useState(false);
  const live = rollout && LIVE.includes(rollout.status);

  // ---- data -------------------------------------------------------------------
  const loadRuns = useCallback(async () => {
    try {
      const [r, ro] = await Promise.all([get('/runs'), get('/rollouts')]);
      setRuns(r.runs.filter((x) => x.progress?.step));
      if (ro.active) setRollout((cur) => cur || ro.active);
      setOffline('');
    } catch (e) {
      setOffline(e.message);
    }
  }, [get]);
  useEffect(() => {
    loadRuns();
  }, [loadRuns]);
  useEffect(() => {
    if (target) {
      setRunId(target.run_id);
      setStep(String(target.step));
      dispatch(setRolloutTarget(null));
    }
  }, [target, dispatch]);
  useEffect(() => {
    if (!runId && runs?.length) setRunId(runs.find((r) => r.status === 'succeeded')?.id || runs[0].id);
  }, [runs, runId]);
  useEffect(() => {
    if (!runId) return;
    get(`/runs/${runId}/checkpoints`).then(
      (c) => {
        setCkpts(c.checkpoints);
        setStep((s) => (c.checkpoints.some((k) => String(k.step) === s) ? s : String(c.checkpoints.at(-1)?.step ?? '')));
      },
      (e) => toast.error(e.message),
    );
    setLimits(null);
    setPrep(null);
  }, [runId, get]);
  useEffect(() => {
    call('robot.profile', {}).then(
      (r) => setRobot(r),
      () => setRobot(null),
    );
  }, [call, robotType]);
  const run = (runs || []).find((r) => r.id === runId);

  const request = useMemo(
    () => ({
      run_id: runId,
      step: Number(step),
      robot: robot ? { ...robot.params, robot_type: robot.robot_type } : {},
      task,
      speed_factor: speed / 100,
      max_duration_s: maxDur,
      limits: limits ? { joints: limits } : undefined,
      rosbridge_host: rosHost || '127.0.0.1',
      allow_unverified_publishers: unverified,
    }),
    [runId, step, robot, task, speed, maxDur, limits, rosHost, unverified],
  );

  // prepare (server builds and validates the configuration)
  useEffect(() => {
    if (!runId || !step || !robot || live) return undefined;
    setPreparing(true);
    setAck(false);
    const t = setTimeout(async () => {
      try {
        const p = await post('/rollouts/prepare', request, { timeoutMs: 300000 });
        setPrep(p);
        if (!limits) setLimits(p.config.limits.joints.map((j) => ({ ...j })));
      } catch (e) {
        setPrep({ ok: false, errors: [e.message], warnings: [] });
      } finally {
        setPreparing(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [request, runId, step, robot, live, post, limits]);

  // live status + heartbeat while a rollout exists
  useEffect(() => {
    if (!rollout || !LIVE.includes(rollout.status)) return undefined;
    let alive = true;
    const poll = setInterval(async () => {
      try {
        const r = await get(`/rollouts/${rollout.id}`);
        if (alive) setRollout(r);
        const l = await get(`/rollouts/${rollout.id}/log`);
        if (alive) setLog(l.text);
      } catch (e) {
        /* keep last state */
      }
    }, 400);
    const hb = setInterval(() => post(`/rollouts/${rollout.id}/heartbeat`).catch(() => {}), 500);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(hb);
    };
  }, [rollout?.id, rollout?.status, get, post]); // eslint-disable-line react-hooks/exhaustive-deps

  // final log once a rollout has ended
  useEffect(() => {
    if (rollout && !LIVE.includes(rollout.status)) {
      get(`/rollouts/${rollout.id}/log`).then(
        (l) => setLog(l.text),
        () => {}
      );
    }
  }, [rollout?.id, rollout?.status, get]); // eslint-disable-line react-hooks/exhaustive-deps

  const command = useCallback(
    async (c) => {
      if (!rollout) return;
      try {
        setRollout(await post(`/rollouts/${rollout.id}/command`, { command: c }));
      } catch (e) {
        toast.error(e.message);
      }
    },
    [rollout, post],
  );
  // Escape = emergency stop, anywhere on the page
  const estopRef = useRef(null);
  estopRef.current = () => live && command('estop');
  useEffect(() => {
    const k = (e) => {
      if (e.key === 'Escape') estopRef.current();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const start = async () => {
    try {
      const r = await post('/rollouts', { request, confirm_token: prep.token }, { timeoutMs: 120000 });
      setRollout(r);
      setTrial({ outcome: null, notes: '', x: '', y: '' });
      toast.success('Loading the model — the robot will not move yet');
    } catch (e) {
      toast.error(e.message);
      setPrep(null);
    }
  };

  const saveTrial = async () => {
    try {
      await post('/evaluations', {
        run_id: rollout.config.run_id,
        step: rollout.config.step,
        outcome: trial.outcome,
        notes: trial.notes,
        object: trial.x !== '' && trial.y !== '' ? { x_mm: trial.x, y_mm: trial.y } : null,
        rollout_id: rollout.id,
        duration_s: rollout.live?.elapsed_s,
        conditions: `speed ${Math.round(rollout.config.speed_factor * 100)}%`,
      });
      toast.success('Trial logged in the evaluation log');
      setTrial({ outcome: null, notes: '', x: '', y: '' });
      setRollout(null);
      setPrep(null);
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (offline) {
    return (
      <div className="p-8 max-w-3xl">
        <Callout tone="warn" title="Training service not running">
          Host rollouts run through the PHYSIOS training service on this PC: <code>cd ~/physios && ./start_physios.sh</code>
          . {offline}
        </Callout>
      </div>
    );
  }
  if (!runs) return <Spinner />;

  const lv = rollout?.live || {};
  const [pcls, plabel] = PHASE[rollout?.status] || ['chip', rollout?.status];
  const names = rollout?.config?.action_names || prep?.config?.action_names || [];
  const lim = rollout?.config?.limits?.joints || limits || [];

  return (
    <div className="h-full overflow-auto scroll-thin">
      <div className="mx-auto max-w-[1760px] px-5 py-4 grid gap-4 grid-cols-[minmax(0,1fr)]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="label">06 · Inference · host</div>
            <h1 className="text-[28px] font-light tracking-tight fade-text leading-tight">Run a model trained on this PC</h1>
            <p className="text-[12.5px] text-ink-3 max-w-3xl">
              Uses the LeRobot of the training environment and the same ROS topics as the Inference session. Safety limits are
              enforced by the worker before every command. Keep this page open — the arm holds if it loses contact.
            </p>
          </div>
          {rollout && <span className={clsx(pcls, 'text-[13px] px-3 py-1')}>{plabel}</span>}
        </div>

        {!rollout ? (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="grid gap-4 content-start min-w-0">
              <Sheet title="Model">
                {!runs.length ? (
                  <p className="text-[12.5px] text-ink-3">No trained runs yet — train one in Training.</p>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="Run">
                      <Select
                        value={runId}
                        onChange={setRunId}
                        options={runs.map((r) => ({ value: r.id, label: `${r.job_name} (${r.policy})` }))}
                        data-rollout-run
                      />
                    </Field>
                    <Field label="Checkpoint">
                      <Select
                        value={step}
                        onChange={setStep}
                        options={ckpts.map((c) => ({
                          value: String(c.step),
                          label: `step ${c.step.toLocaleString()}${c.is_last ? ' (last)' : ''}${c.evaluation ? ` · ${Math.round(c.evaluation.rate * 100)}% success` : ''}`,
                        }))}
                      />
                    </Field>
                    <Field
                      label="Task instruction"
                      hint="Sent to language-conditioned models (SmolVLA)"
                      className="md:col-span-2"
                    >
                      <TextInput
                        value={task}
                        onChange={setTask}
                        placeholder="pick up the object and place it at the target location"
                      />
                    </Field>
                  </div>
                )}
              </Sheet>
              <Sheet title="Motion limits">
                <div className="grid gap-3">
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label={`Speed: ${speed}% of the demonstrated speed`}>
                      <input
                        type="range"
                        min={5}
                        max={100}
                        step={5}
                        value={speed}
                        onChange={(e) => setSpeed(Number(e.target.value))}
                        data-rollout-speed
                      />
                    </Field>
                    <Field label="Maximum duration" hint="seconds; then the arm holds">
                      <NumberInput value={maxDur} min={5} max={600} onChange={setMaxDur} />
                    </Field>
                  </div>
                  {limits && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-[12px]">
                        <thead>
                          <tr className="text-left">
                            {['Joint', 'Min', 'Max', 'Max change / step', 'Max lead', 'Demonstrated'].map((h) => (
                              <th key={h} className="label font-medium pb-1.5 pr-2 whitespace-nowrap">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {limits.map((j, i) => (
                            <tr key={j.name} className="border-t border-rule">
                              <td className="py-1 pr-2">{j.name}</td>
                              {['min', 'max', 'max_step', 'max_lead'].map((k) => (
                                <td key={k} className="py-1 pr-1.5 min-w-[84px]">
                                  <NumberInput
                                    value={j[k]}
                                    step="any"
                                    onChange={(v) =>
                                      setLimits(limits.map((x, n) => (n === i ? { ...x, [k]: v === '' ? '' : Number(v) } : x)))
                                    }
                                    className="[&_input]:!py-1 [&_input]:!px-2 [&_input]:!text-[11.5px]"
                                  />
                                </td>
                              ))}
                              <td className="py-1 num text-ink-3 whitespace-nowrap">
                                {j.data_min ?? prep?.proposal?.joints?.[i]?.data_min} …{' '}
                                {j.data_max ?? prep?.proposal?.joints?.[i]?.data_max}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2 items-center">
                    <button
                      className="btn-ghost btn-sm"
                      onClick={() => prep?.proposal && setLimits(prep.proposal.joints.map((j) => ({ ...j })))}
                    >
                      Reset to the training data
                    </button>
                    <button
                      className="btn btn-sm"
                      disabled={!prep?.ok}
                      onClick={async () => {
                        try {
                          await post('/rollouts/limits', { dataset_id: prep.config.dataset_id, limits: { joints: limits } });
                          toast.success('Saved as the default limits for this dataset');
                        } catch (e) {
                          toast.error(e.message);
                        }
                      }}
                    >
                      Save as default
                    </button>
                    <span className="text-[11px] text-ink-3">
                      Limits start from the range the arm covered in the demonstrations (+5%); they can be tightened, and widened
                      by at most 10%. Units are those of the dataset.
                    </span>
                  </div>
                </div>
              </Sheet>
              <Sheet title="Cameras vs training data">
                <CameraMatchCheck datasetId={run?.dataset} />
              </Sheet>
            </div>

            <div className="grid gap-4 content-start min-w-0">
              <Sheet title="Review" actions={preparing && <Spinner />}>
                {!prep ? (
                  <p className="text-[12.5px] text-ink-3">
                    {robot
                      ? 'Preparing…'
                      : 'Waiting for the robot configuration (connect to physical_ai_server and select the robot on Home).'}
                  </p>
                ) : (
                  <div className="grid gap-3 grid-cols-[minmax(0,1fr)]">
                    {prep.errors.map((e) => (
                      <Callout key={e} tone="err">
                        {e}
                      </Callout>
                    ))}
                    {prep.warnings.map((e) => (
                      <Callout key={e} tone="warn">
                        {e}
                      </Callout>
                    ))}
                    {prep.config && (
                      <div className="night-panel p-4 text-[11.5px] font-mono text-[#dfe8ff] grid gap-1">
                        <div className="text-white/50">
                          worker in conda env “{prep.config.env}” · {prep.config.device} · {prep.config.fps} Hz
                        </div>
                        <div>model {prep.config.checkpoint}</div>
                        {Object.entries(prep.config.cameras).map(([k, t]) => (
                          <div key={k}>
                            reads {t} → {k}
                          </div>
                        ))}
                        <div>
                          reads {prep.config.state_topic} ({prep.config.state_names.length} joints)
                        </div>
                        <div className="text-[#ffb4a1]">
                          commands {prep.config.action_topic} ({prep.config.action_names.join(', ')})
                        </div>
                        <div>
                          limits speed {Math.round(prep.config.speed_factor * 100)}% · max {prep.config.max_duration_s}s ·
                          envelope from {prep.limits_source}
                        </div>
                        <div>rosbridge {prep.config.rosbridge_url}</div>
                      </div>
                    )}
                    <label className="flex items-start gap-2 text-[12px] text-ink-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={unverified}
                        onChange={(e) => setUnverified(e.target.checked)}
                      />
                      <span>
                        If rosapi is not available: I have checked myself that nothing else (Inference session, teleoperation)
                        commands the arm.
                      </span>
                    </label>
                    <label className="flex items-start gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={ack}
                        onChange={(e) => setAck(e.target.checked)}
                        disabled={!prep.ok}
                        data-rollout-ack
                      />
                      <span>
                        I reviewed this configuration. Load the model (the arm does not move until I press “Start moving”).
                      </span>
                    </label>
                    <button
                      className="btn-primary justify-self-start"
                      disabled={!prep.ok || !ack || preparing || !!prep.busy}
                      onClick={start}
                      data-rollout-load
                    >
                      Load model
                    </button>
                  </div>
                )}
              </Sheet>
            </div>
          </div>
        ) : (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div className="grid gap-4 content-start min-w-0">
              <Sheet title={`${rollout.config.policy} · step ${rollout.config.step} · ${rollout.config.dataset_id}`}>
                <div className="grid gap-4">
                  {rollout.error && (
                    <Callout tone="err" title="Stopped">
                      {rollout.error}
                    </Callout>
                  )}
                  {lv.pause_reason && rollout.status === 'paused' && (
                    <Callout tone="warn">Holding position: {lv.pause_reason}</Callout>
                  )}
                  {rollout.status === 'ready' && lv.preview && (
                    <Callout
                      tone={lv.preview.verdict === 'unsafe' ? 'err' : lv.preview.verdict === 'clamped' ? 'warn' : 'ok'}
                      title="Dry run (nothing sent)"
                    >
                      {lv.preview.verdict === 'ok'
                        ? 'The first action is inside all limits.'
                        : lv.preview.verdict === 'clamped'
                          ? `The first action would be limited (${lv.preview.notes.join(', ')}). This is normal at low speed.`
                          : `The first action is unsafe: ${lv.preview.notes.join(' ')} Starting would stop immediately.`}
                    </Callout>
                  )}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="rounded-2xl bg-paper px-4 py-3">
                      <div className="label">Steps sent</div>
                      <div className="text-[26px] font-light tabular-nums">{lv.step ?? 0}</div>
                    </div>
                    <div className="rounded-2xl bg-paper px-4 py-3">
                      <div className="label">Control rate</div>
                      <div className="text-[26px] font-light tabular-nums">{lv.rate_hz ?? '—'}</div>
                      <div className="text-[11px] text-ink-3">target {rollout.config.fps} Hz</div>
                    </div>
                    <div className="rounded-2xl bg-paper px-4 py-3">
                      <div className="label">Elapsed</div>
                      <div className="text-[26px] font-light tabular-nums">{lv.elapsed_s ?? 0}s</div>
                      <div className="text-[11px] text-ink-3">max {rollout.config.max_duration_s}s</div>
                    </div>
                    <div className="rounded-2xl bg-paper px-4 py-3">
                      <div className="label">Limited by safety</div>
                      <div className="text-[26px] font-light tabular-nums">
                        {lv.clamps ? lv.clamps.clamped_range + lv.clamps.clamped_speed + lv.clamps.clamped_lead : 0}
                      </div>
                      <div className="text-[11px] text-ink-3">
                        {lv.clamps
                          ? `range ${lv.clamps.clamped_range} · speed ${lv.clamps.clamped_speed} · lead ${lv.clamps.clamped_lead}`
                          : ''}
                      </div>
                    </div>
                  </div>
                  <JointBars names={names} limits={lim} rows={lv.last || lv.preview || {}} />
                </div>
              </Sheet>
              <section className="night-panel">
                <div className="px-5 pt-4 text-[12px] text-white/60 font-mono">rollout.log</div>
                <pre className="m-4 mt-2 h-[220px] overflow-auto scroll-thin rounded-2xl bg-black/30 p-3 text-[11px] text-[#cfe0ff] font-mono whitespace-pre-wrap break-all">
                  {log || '…'}
                </pre>
              </section>
            </div>

            <div className="grid gap-4 content-start">
              {live ? (
                <>
                  <button
                    className="h-40 rounded-card bg-[#d42020] text-white text-[26px] font-bold tracking-wide shadow-[0_18px_40px_-18px_rgba(212,32,32,0.9)] active:scale-[0.98] transition"
                    onClick={() => command('estop')}
                    data-estop
                  >
                    EMERGENCY STOP
                    <div className="text-[12px] font-normal opacity-80 mt-1">or press Esc</div>
                  </button>
                  {rollout.status === 'ready' || rollout.status === 'paused' ? (
                    <button className="btn-primary py-3 text-[15px]" onClick={() => setMoveConfirm(true)} data-rollout-run-btn>
                      ▶ {rollout.status === 'ready' ? 'Start moving' : 'Continue'}
                    </button>
                  ) : rollout.status === 'running' ? (
                    <button className="btn py-3 text-[15px]" onClick={() => command('pause')}>
                      ❚❚ Hold position
                    </button>
                  ) : null}
                  <button className="btn" onClick={() => command('stop')}>
                    End rollout
                  </button>
                </>
              ) : (
                <Sheet title="How did it go?">
                  <div className="grid gap-3">
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries({
                        success: 'Success',
                        failed_grasp: 'Failed grasp',
                        missed_place: 'Missed placement',
                        collision: 'Collision',
                        timeout: 'Did not finish',
                        other: 'Other',
                      }).map(([k, l]) => (
                        <button
                          key={k}
                          className={clsx(
                            'rounded-pill px-3 py-1.5 text-[12.5px] flex items-center gap-1.5',
                            trial.outcome === k ? 'bg-ink text-white' : 'bg-paper',
                          )}
                          onClick={() => setTrial({ ...trial, outcome: k })}
                          data-rollout-outcome={k}
                        >
                          <span className="h-2.5 w-2.5 rounded-full" style={{ background: OUTCOME_COLOR[k] }} />
                          {l}
                        </button>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <NumberInput
                        value={trial.x}
                        onChange={(v) => setTrial({ ...trial, x: v })}
                        suffix="x mm"
                        placeholder="object x"
                      />
                      <NumberInput
                        value={trial.y}
                        onChange={(v) => setTrial({ ...trial, y: v })}
                        suffix="y mm"
                        placeholder="object y"
                      />
                    </div>
                    <TextInput
                      value={trial.notes}
                      onChange={(v) => setTrial({ ...trial, notes: v })}
                      placeholder="what happened?"
                    />
                    <div className="flex gap-2">
                      <button className="btn-primary" disabled={!trial.outcome} onClick={saveTrial} data-rollout-save-trial>
                        Save to evaluation log
                      </button>
                      <button
                        className="btn-ghost"
                        onClick={() => {
                          setRollout(null);
                          setPrep(null);
                        }}
                      >
                        Skip
                      </button>
                    </div>
                    <p className="text-[11px] text-ink-3">
                      Logged trials give each checkpoint a success rate (Training → Evaluate).
                    </p>
                  </div>
                </Sheet>
              )}
            </div>
          </div>
        )}
      </div>
      <Modal
        open={moveConfirm}
        title="The arm will move"
        onClose={() => setMoveConfirm(false)}
        footer={
          <>
            <button className="btn" onClick={() => setMoveConfirm(false)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              data-rollout-confirm-move
              onClick={() => {
                setMoveConfirm(false);
                command('run');
              }}
            >
              Start moving
            </button>
          </>
        }
      >
        <ul className="text-[13px] list-disc pl-5 grid gap-1">
          <li>The workspace is clear and the object is in place.</li>
          <li>You can reach the emergency stop (button or Esc) and the robot's power switch.</li>
          <li>
            Speed is limited to {Math.round((rollout?.config?.speed_factor || 0) * 100)}% and motion to the limits you reviewed.
          </li>
        </ul>
      </Modal>
    </div>
  );
}
