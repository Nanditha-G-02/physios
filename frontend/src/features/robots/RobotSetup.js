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

// "Robot Configuration" and "Robot Readiness" tabs of a custom robot.
//
// Configuration is data only. Readiness walks the stages: ROS checks (read-only: topic list and
// subscriptions over rosbridge), connect, the supervised one-joint hardware test (the ONLY place
// that publishes a command, and only after the operator has authorised it on the server AND
// pressed Start), and the data/training compatibility check.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import ROSLIB from 'roslib';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Callout, Field, NumberInput, Select, Sheet, Spinner, TextInput, Toggle } from '../../components/ui';
import rosConnectionManager from '../../utils/rosConnectionManager';
import { trainerFetch } from '../../hooks/useTrainer';
import { connectRobot } from './robotsApi';

const api = {
  config: (id) => trainerFetch(`/robots/${id}/config`),
  save: (id, config) => trainerFetch(`/robots/${id}/config`, { method: 'POST', body: { config } }),
  ros: (id, evidence) => trainerFetch(`/robots/${id}/verify/ros`, { method: 'POST', body: { evidence } }),
  authorize: (id, body) => trainerFetch(`/robots/${id}/verify/hardware/authorize`, { method: 'POST', body }),
  result: (id, token, result) => trainerFetch(`/robots/${id}/verify/hardware/result`, { method: 'POST', body: { token, result } }),
  data: (id, body) => trainerFetch(`/robots/${id}/verify/data`, { method: 'POST', body }),
  serverConfig: (id) => trainerFetch(`/robots/${id}/server-config`),
  datasets: () => trainerFetch('/datasets'),
};

const CHECKLIST = [
  ['area_clear', "The robot's workspace is clear of people and objects."],
  ['estop_ready', 'A hardware emergency stop (or power switch) is within reach.'],
  ['robot_supported', 'The robot is mounted/supported so a moving joint cannot make it fall.'],
  ['watching', 'I will watch the robot for the whole test and stop it if anything is wrong.'],
];

// ---- unit conversion (mirrors backend/physios_trainer/robots/readiness.py) ------------------------------
export function toUrdf(j, raw) {
  let v = raw;
  if (j.units === 'deg') v = (v * Math.PI) / 180;
  else if (j.units === 'mm') v /= 1000;
  return j.direction * v + j.offset;
}
export function fromUrdf(j, v) {
  let raw = (v - j.offset) / j.direction;
  if (j.units === 'deg') raw = (raw * 180) / Math.PI;
  else if (j.units === 'mm') raw *= 1000;
  return raw;
}
const fullTopic = (cfg, t) => {
  if (!t) return t;
  if (t.startsWith('/') || !cfg.namespace) return t.startsWith('/') ? t : `/${t}`;
  return `/${cfg.namespace.replace(/^\/|\/$/g, '')}/${t}`;
};
const fmt = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d));

function useRos() {
  const url = useSelector((s) => s.ros.rosbridgeUrl);
  return useCallback(() => rosConnectionManager.getConnection(url), [url]);
}

function IssueList({ issues }) {
  if (!issues || !issues.length) return null;
  return (
    <ul className="space-y-1 text-[12.5px]" data-issues>
      {issues.map((i, k) => (
        <li key={k} className="flex gap-2">
          <span className={clsx('text-[10px] shrink-0 mt-[2px]', i.level === 'error' ? 'chip-err' : i.level === 'warning' ? 'chip-warn' : 'chip-ok')}>
            {i.level === 'ok' ? 'ok' : i.level}
          </span>
          <span>
            {i.field ? <span className="font-mono text-ink-3">{i.field}: </span> : null}
            {i.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ================================ configuration ================================
function ConfigTab({ robot, refresh }) {
  const [cfg, setCfg] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.config(robot.id).then((r) => setCfg(r.config)).catch((e) => toast.error(e.message));
  }, [robot.id]);
  if (robot.state !== 'registered') {
    return (
      <Sheet title="Robot configuration">
        <Callout tone="warn">Register the URDF (Stage 1) before configuring the robot.</Callout>
      </Sheet>
    );
  }
  if (!cfg) return <div className="p-6 flex justify-center"><Spinner /></div>;
  const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }));
  const setJ = (i, k, v) => setCfg((c) => ({ ...c, joints: c.joints.map((j, n) => (n === i ? { ...j, [k]: v } : j)) }));
  const setCam = (i, k, v) => setCfg((c) => ({ ...c, cameras: c.cameras.map((m, n) => (n === i ? { ...m, [k]: v } : m)) }));
  const save = async () => {
    setBusy(true);
    try {
      const p = await api.save(robot.id, cfg);
      setCfg(p.config);
      const errs = (p.config_issues || []).filter((i) => i.level === 'error').length;
      if (errs) toast.error(`Saved with ${errs} error(s) — see the list`);
      else toast.success('Configuration saved');
      if (p.stage < robot.stage) toast(`Verification reset to Stage ${p.stage} because verified settings changed.`, { icon: '!' });
      refresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-4" data-config-tab>
      <Callout tone="info" title="Configuration only — nothing is sent to the robot">
        Changing topics or joint names resets ROS verification; changing the mapping, units, calibration or safety limits resets the
        hardware verification. Earlier stages stay as they are.
      </Callout>
      {robot.config_issues && robot.config_issues.length > 0 && (
        <Sheet title="Configuration check">
          <IssueList issues={robot.config_issues} />
        </Sheet>
      )}
      <Sheet title="ROS interface">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="ROS distro">
            <Select value={cfg.ros_distro} onChange={(v) => set('ros_distro', v)} options={['jazzy', 'humble', 'rolling', 'other']} />
          </Field>
          <Field label="Namespace" hint="Optional, prefixes relative topics">
            <TextInput value={cfg.namespace} onChange={(v) => set('namespace', v)} placeholder="(none)" />
          </Field>
          <Field label="Driver / hardware interface" hint="For your records, e.g. dynamixel ros2_control">
            <TextInput value={cfg.driver} onChange={(v) => set('driver', v)} />
          </Field>
          <Field label="Control frequency">
            <NumberInput value={cfg.control_frequency_hz} onChange={(v) => set('control_frequency_hz', v)} min={1} max={1000} suffix="Hz" />
          </Field>
          <Field label="Joint state topic" hint="sensor_msgs/msg/JointState">
            <TextInput value={cfg.joint_state_topic} onChange={(v) => set('joint_state_topic', v)} data-cfg="joint_state_topic" />
          </Field>
          <Field label="Command interface">
            <Select
              value={cfg.command_interface}
              onChange={(v) => set('command_interface', v)}
              options={[
                { value: 'joint_trajectory', label: 'JointTrajectory (trajectory_msgs)' },
                { value: 'float64_array', label: 'Float64MultiArray (forward controller)' },
                { value: 'none', label: 'None (read-only)' },
              ]}
            />
          </Field>
          <Field label="Command topic">
            <TextInput value={cfg.command_topic} onChange={(v) => set('command_topic', v)} disabled={cfg.command_interface === 'none'} data-cfg="command_topic" />
          </Field>
          <Field label="Leader / teleop topic" hint="Action source for recording (optional)">
            <TextInput value={cfg.leader_topic} onChange={(v) => set('leader_topic', v)} placeholder="/leader/joint_trajectory" />
          </Field>
        </div>
      </Sheet>
      <Sheet title="Joint-to-motor mapping, units and soft limits">
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]" data-joint-map>
            <thead>
              <tr className="text-left label">
                <th className="py-1 pr-2">URDF joint</th>
                <th className="pr-2">ROS joint name</th>
                <th className="pr-2">Motor ID</th>
                <th className="pr-2">Direction</th>
                <th className="pr-2">Offset (rad/m)</th>
                <th className="pr-2">Units on ROS</th>
                <th className="pr-2">Soft lower</th>
                <th className="pr-2">Soft upper</th>
                <th>Enabled</th>
              </tr>
            </thead>
            <tbody>
              {cfg.joints.map((j, i) => (
                <tr key={j.urdf_joint} className="border-t border-rule">
                  <td className="py-1 pr-2 font-mono">{j.urdf_joint}</td>
                  <td className="pr-2"><TextInput value={j.ros_joint} onChange={(v) => setJ(i, 'ros_joint', v)} className="py-1" data-map-ros={j.urdf_joint} /></td>
                  <td className="pr-2 w-[80px]"><TextInput value={j.motor_id ?? ''} onChange={(v) => setJ(i, 'motor_id', v === '' ? null : v.replace(/\D/g, ''))} className="py-1" /></td>
                  <td className="pr-2">
                    <Select value={String(j.direction)} onChange={(v) => setJ(i, 'direction', Number(v))} options={[{ value: '1', label: '+1' }, { value: '-1', label: '−1' }]} className="py-1" />
                  </td>
                  <td className="pr-2 w-[100px]"><NumberInput value={j.offset} onChange={(v) => setJ(i, 'offset', v)} step={0.01} className="py-1" /></td>
                  <td className="pr-2">
                    <Select value={j.units} onChange={(v) => setJ(i, 'units', v)} options={['rad', 'deg', 'm', 'mm']} className="py-1" />
                  </td>
                  <td className="pr-2 w-[100px]"><NumberInput value={j.soft_lower} onChange={(v) => setJ(i, 'soft_lower', v)} step={0.01} className="py-1" /></td>
                  <td className="pr-2 w-[100px]"><NumberInput value={j.soft_upper} onChange={(v) => setJ(i, 'soft_upper', v)} step={0.01} className="py-1" /></td>
                  <td><input type="checkbox" checked={j.enabled} onChange={(e) => setJ(i, 'enabled', e.target.checked)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11.5px] text-ink-3">
          URDF value = direction × (ROS value converted to rad/m) + offset. Soft limits are in URDF units and must stay inside the URDF
          limits; the hardware test never leaves them.
        </p>
      </Sheet>
      <div className="grid gap-4 lg:grid-cols-3">
        <Sheet title="Calibration">
          <div className="space-y-3">
            <Field label="Method">
              <TextInput value={cfg.calibration.method} onChange={(v) => set('calibration', { ...cfg.calibration, method: v })} />
            </Field>
            <Toggle
              checked={cfg.calibration.done}
              onChange={(v) => set('calibration', { ...cfg.calibration, done: v })}
              label="The robot has been calibrated (zero pose and directions checked)"
            />
            <Field label="Notes">
              <textarea className="input min-h-[60px]" value={cfg.calibration.notes} onChange={(e) => set('calibration', { ...cfg.calibration, notes: e.target.value })} />
            </Field>
          </div>
        </Sheet>
        <Sheet title="Cameras">
          <div className="space-y-2" data-cameras>
            {cfg.cameras.map((c, i) => (
              <div key={i} className="rounded-xl bg-paper p-2 space-y-1.5">
                <div className="flex gap-2">
                  <TextInput value={c.name} onChange={(v) => setCam(i, 'name', v)} placeholder="name" className="py-1 w-[110px]" data-cam-name={i} />
                  <TextInput value={c.topic} onChange={(v) => setCam(i, 'topic', v)} placeholder="/camera/image_raw/compressed" className="py-1 flex-1" data-cam-topic={i} />
                </div>
                <div className="flex gap-2 items-center">
                  <Select
                    value={c.msg_type}
                    onChange={(v) => setCam(i, 'msg_type', v)}
                    options={['sensor_msgs/msg/CompressedImage', 'sensor_msgs/msg/Image']}
                    className="py-1 flex-1"
                  />
                  <button className="btn-ghost btn-sm" onClick={() => set('cameras', cfg.cameras.filter((_, n) => n !== i))}>Remove</button>
                </div>
              </div>
            ))}
            <button
              className="btn btn-sm"
              onClick={() => set('cameras', [...cfg.cameras, { name: `camera${cfg.cameras.length + 1}`, topic: '', msg_type: 'sensor_msgs/msg/CompressedImage' }])}
              data-action="add-camera"
            >
              + Add camera
            </button>
          </div>
        </Sheet>
        <Sheet title="Safety limits">
          <div className="space-y-3">
            <Field label="Velocity limit" hint="rad/s (prismatic: m/s ÷ 10)">
              <NumberInput value={cfg.safety.max_velocity} onChange={(v) => set('safety', { ...cfg.safety, max_velocity: v })} step={0.05} min={0} />
            </Field>
            <Field label="Hardware test velocity" hint="Capped at 0.5 and at 25% of the URDF joint velocity">
              <NumberInput value={cfg.safety.test_velocity} onChange={(v) => set('safety', { ...cfg.safety, test_velocity: v })} step={0.05} min={0} />
            </Field>
            <p className="text-[11.5px] text-ink-3">A hardware emergency stop is always required for the hardware test. The software Stop button is not an emergency stop.</p>
          </div>
        </Sheet>
      </div>
      <div className="flex justify-end">
        <button className="btn-primary" onClick={save} disabled={busy} data-action="save-config">
          {busy && <Spinner className="border-paper border-t-transparent" />} Save configuration
        </button>
      </div>
    </div>
  );
}

// ================================ readiness ================================
function StageList({ readiness }) {
  return (
    <ol className="grid gap-2 md:grid-cols-4" data-stages>
      {readiness.stages.map((s) => (
        <li
          key={s.n}
          className={clsx('rounded-2xl p-3', s.status === 'done' ? 'bg-signal-okbg' : s.status === 'locked' ? 'bg-paper opacity-60' : 'bg-paper')}
          data-stage-row={s.n}
          data-status={s.status}
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-ink-3">Stage {s.n}</span>
            <span className={clsx('text-[10px]', s.status === 'done' ? 'chip-ok' : s.status === 'locked' ? 'chip' : s.status === 'blocked' ? 'chip-warn' : 'chip-sky')}>
              {s.status}
            </span>
          </div>
          <div className="text-[13.5px] font-semibold mt-0.5">{s.name}</div>
          {s.verified_at && <div className="text-[11px] text-ink-3">{new Date(s.verified_at).toLocaleString()}</div>}
          {s.status !== 'done' && s.blockers.length > 0 && (
            <ul className="mt-1 text-[11.5px] text-ink-2 list-disc pl-4">
              {s.blockers.map((b) => <li key={b}>{b}</li>)}
            </ul>
          )}
          <div className="mt-1 text-[11px] text-ink-3">Unlocks: {s.unlocks}</div>
        </li>
      ))}
    </ol>
  );
}

function RosCheck({ robot, refresh }) {
  const getRos = useRos();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(robot.verifications?.ros_last || null);
  const cfg = robot.config;
  const run = async () => {
    setBusy(true);
    const ev = { collected_at: Date.now() / 1000, rosbridge: false, topics: {}, joint_state: { received: false }, cameras: {} };
    try {
      const ros = await getRos();
      ev.rosbridge = !!(ros && ros.isConnected);
      const t = await new Promise((res, rej) => ros.getTopics(res, rej));
      (t.topics || []).forEach((name, i) => {
        ev.topics[name] = (t.types || [])[i];
      });
      const listen = (name, type, ms, onMsg) =>
        new Promise((res) => {
          const topic = new ROSLIB.Topic({ ros, name, messageType: type });
          const cb = (m) => onMsg(m);
          topic.subscribe(cb);
          setTimeout(() => {
            topic.unsubscribe(cb);
            res();
          }, ms);
        });
      const js = fullTopic(cfg, cfg.joint_state_topic);
      const stamps = [];
      let lastMsg = null;
      await listen(js, 'sensor_msgs/msg/JointState', 3000, (m) => {
        stamps.push(performance.now());
        lastMsg = m;
      });
      if (lastMsg) {
        const rate = stamps.length > 1 ? ((stamps.length - 1) * 1000) / (stamps[stamps.length - 1] - stamps[0]) : 0;
        const positions = {};
        (lastMsg.name || []).forEach((n, i) => {
          positions[n] = lastMsg.position[i];
        });
        ev.joint_state = { received: true, rate_hz: rate, names: lastMsg.name || [], positions };
      }
      await Promise.all(
        cfg.cameras.map((c) => {
          const tp = fullTopic(cfg, c.topic);
          ev.cameras[tp] = { received: false };
          return listen(tp, c.msg_type, 4000, () => {
            ev.cameras[tp].received = true;
          });
        })
      );
    } catch (e) {
      toast.error(`ROS check: ${e && e.message ? e.message : e}`);
    }
    try {
      const r = await api.ros(robot.id, ev);
      setLast({ ok: r.ok, checks: r.checks, at: new Date().toISOString() });
      if (r.ok) toast.success('Stage 2 verified');
      else toast.error('ROS checks failed');
      refresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="Stage 2 · ROS checks" actions={
      <button className="btn-primary btn-sm" onClick={run} disabled={busy || !cfg} data-action="run-ros-checks">
        {busy && <Spinner className="border-paper border-t-transparent" />} Run ROS checks
      </button>
    }>
      <p className="text-[12.5px] text-ink-3 mb-2">
        Read-only: lists the topics, listens to the joint states for 3 s and to each camera for 4 s. Nothing is published.
      </p>
      {last ? (
        <div data-ros-result={last.ok ? 'ok' : 'failed'}>
          <IssueList issues={last.checks.map((c) => ({ level: c.level, text: c.text }))} />
        </div>
      ) : (
        <div className="text-[12.5px] text-ink-3">Not run yet.</div>
      )}
    </Sheet>
  );
}

function LiveJoints({ robot }) {
  const getRos = useRos();
  const [vals, setVals] = useState({});
  const [age, setAge] = useState(null);
  const lastT = useRef(0);
  const cfg = robot.config;
  useEffect(() => {
    let topic;
    let cb;
    let alive = true;
    getRos().then((ros) => {
      if (!alive) return;
      topic = new ROSLIB.Topic({ ros, name: fullTopic(cfg, cfg.joint_state_topic), messageType: 'sensor_msgs/msg/JointState', throttle_rate: 100 });
      cb = (m) => {
        const v = {};
        (m.name || []).forEach((n, i) => {
          v[n] = m.position[i];
        });
        lastT.current = performance.now();
        setVals(v);
      };
      topic.subscribe(cb);
    }).catch(() => {});
    const iv = setInterval(() => setAge(lastT.current ? performance.now() - lastT.current : null), 500);
    return () => {
      alive = false;
      clearInterval(iv);
      if (topic && cb) topic.unsubscribe(cb);
    };
  }, [getRos, cfg]);
  return (
    <div data-live-joints>
      <div className="label mb-1">
        Live joints {age === null ? '· waiting for data' : age > 1000 ? `· stale (${(age / 1000).toFixed(1)} s)` : '· live'}
      </div>
      <div className="grid gap-1.5 md:grid-cols-3">
        {cfg.joints.map((j) => {
          const raw = vals[j.ros_joint];
          const u = raw === undefined ? null : toUrdf(j, raw);
          const pct = u === null ? 0 : ((u - j.soft_lower) / (j.soft_upper - j.soft_lower)) * 100;
          return (
            <div key={j.urdf_joint} className="rounded-xl bg-paper px-2 py-1.5 text-[12px]">
              <div className="flex justify-between"><span className="font-mono">{j.urdf_joint}</span><span className="font-mono">{fmt(u)}</span></div>
              <div className="h-1 mt-1 bg-paper-3 rounded-pill relative">
                <div className={clsx('absolute top-0 h-1 w-1.5 rounded-pill', pct < 0 || pct > 100 ? 'bg-signal-err' : 'bg-ink')} style={{ left: `${Math.max(0, Math.min(100, pct))}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Runs an authorised plan. Returns {outcome, reason, samples}. Publishes only while running.
async function runHardwareTest({ ros, cfg, plan, stopRef, onProgress }) {
  const joints = cfg.joints.filter((j) => j.enabled);
  const test = joints.find((j) => j.urdf_joint === plan.joint);
  let last = null;
  let lastAt = 0;
  const sub = new ROSLIB.Topic({ ros, name: plan.joint_state_topic, messageType: 'sensor_msgs/msg/JointState' });
  const cb = (m) => {
    const v = {};
    (m.name || []).forEach((n, i) => {
      v[n] = m.position[i];
    });
    last = v;
    lastAt = performance.now();
  };
  sub.subscribe(cb);
  const pub = new ROSLIB.Topic({
    ros,
    name: plan.command_topic,
    messageType: plan.command_interface === 'joint_trajectory' ? 'trajectory_msgs/msg/JointTrajectory' : 'std_msgs/msg/Float64MultiArray',
  });
  const urdfNow = () => {
    const o = {};
    joints.forEach((j) => {
      if (last && last[j.ros_joint] !== undefined) o[j.urdf_joint] = toUrdf(j, last[j.ros_joint]);
    });
    return o;
  };
  const send = (target) => {
    const raw = joints.map((j) => fromUrdf(j, target[j.urdf_joint]));
    const dt = Math.round(1e9 / plan.rate_hz);
    if (plan.command_interface === 'joint_trajectory') {
      pub.publish({
        header: { stamp: { sec: 0, nanosec: 0 }, frame_id: '' },
        joint_names: joints.map((j) => j.ros_joint),
        points: [{ positions: raw, velocities: [], accelerations: [], effort: [], time_from_start: { sec: 0, nanosec: dt } }],
      });
    } else {
      pub.publish({ layout: { dim: [], data_offset: 0 }, data: raw });
    }
  };
  const samples = [];
  const finish = (outcome, reason) => {
    // on any abort: one command that holds the measured position, then stop publishing
    if (outcome !== 'success' && last) {
      const hold = urdfNow();
      if (Object.keys(hold).length === joints.length) send(hold);
    }
    sub.unsubscribe(cb);
    return { outcome, reason, samples: samples.filter((x) => x.phase !== 'hold') };
  };
  const t0 = performance.now();
  while (!last && performance.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 30));
  if (!last) return finish('aborted', 'No joint state received.');
  const start = urdfNow();
  if (Object.keys(start).length !== joints.length) return finish('aborted', 'Joint state does not contain every mapped joint.');
  const s0 = start[test.urdf_joint];
  const periodMs = 1000 / plan.rate_hz;
  const mid = (plan.soft_lower + plan.soft_upper) / 2;
  const sign = s0 <= mid ? 1 : -1;
  const target = s0 + sign * plan.amplitude;
  if (target < plan.soft_lower || target > plan.soft_upper || s0 < plan.soft_lower || s0 > plan.soft_upper) {
    return finish('aborted', 'The joint is outside its soft limits or too close to them. Move it toward the middle first.');
  }
  // Pre-hold: command the measured position for 0.6 s. With a correct mapping nothing moves;
  // if something does, direction/offset/units are wrong and the test stops before any motion
  // is intended.
  const tHold = performance.now();
  while (performance.now() - tHold < 600) {
    if (stopRef.current) return finish('aborted', 'Stopped by the operator.');
    if (performance.now() - lastAt > plan.stale_ms) return finish('aborted', 'Joint state stopped arriving.');
    const now = urdfNow();
    const dev = Math.max(...joints.map((j) => Math.abs(now[j.urdf_joint] - start[j.urdf_joint])));
    samples.push({ t: -(600 - (performance.now() - tHold)) / 1000, pos: now[test.urdf_joint], cmd: s0, others_dev: 0, phase: 'hold' });
    if (dev > plan.tolerance) {
      return finish('aborted', 'Holding the current position moved a joint — the direction, offset or units in the mapping are wrong. Fix the configuration before testing again.');
    }
    send(start);
    if (onProgress) onProgress({ t: 0, total: 1, pos: now[test.urdf_joint], cmd: s0, s0, phase: 'pre-hold' });
    await new Promise((r) => setTimeout(r, periodMs));
  }
  const moveS = plan.amplitude / plan.velocity;
  const profile = (t) => {
    if (t < moveS) return s0 + sign * plan.velocity * t;
    if (t < moveS + plan.hold_s) return target;
    if (t < 2 * moveS + plan.hold_s) return target - sign * plan.velocity * (t - moveS - plan.hold_s);
    return s0;
  };
  const total = 2 * moveS + plan.hold_s + 1.0;
  const tStart = performance.now();
  for (;;) {
    const t = (performance.now() - tStart) / 1000;
    if (stopRef.current) return finish('aborted', 'Stopped by the operator.');
    if (performance.now() - lastAt > plan.stale_ms) return finish('aborted', 'Joint state stopped arriving.');
    if (t > plan.timeout_s) return finish('aborted', 'Timed out.');
    const now = urdfNow();
    const cmd = profile(t);
    let others = 0;
    joints.forEach((j) => {
      if (j.urdf_joint !== test.urdf_joint) others = Math.max(others, Math.abs(now[j.urdf_joint] - start[j.urdf_joint]));
    });
    const pos = now[test.urdf_joint];
    samples.push({ t, pos, cmd, others_dev: others });
    if (others > plan.others_tolerance * 2) return finish('aborted', 'Another joint moved — check the mapping.');
    if (pos < plan.soft_lower - plan.tolerance || pos > plan.soft_upper + plan.tolerance) return finish('aborted', 'The joint left its soft limits.');
    if (Math.abs(pos - s0) > plan.amplitude + 2 * plan.tolerance) return finish('aborted', 'The joint moved further than commanded — check units and direction.');
    if (t >= total) return finish('success', '');
    const tgt = { ...start, [test.urdf_joint]: cmd };
    send(tgt);
    if (onProgress) onProgress({ t, total, pos, cmd, s0 });
    await new Promise((r) => setTimeout(r, periodMs));
  }
}

function HardwareTest({ robot, refresh }) {
  const getRos = useRos();
  const cfg = robot.config;
  const enabled = (cfg?.joints || []).filter((j) => j.enabled);
  const [joint, setJoint] = useState(enabled[0]?.urdf_joint || '');
  const [checks, setChecks] = useState({});
  const [typed, setTyped] = useState('');
  const [auth, setAuth] = useState(null);
  const [state, setState] = useState('idle'); // idle | authorized | running | done
  const [prog, setProg] = useState(null);
  const [result, setResult] = useState(null);
  const stopRef = useRef(false);
  const canAuth = CHECKLIST.every(([k]) => checks[k]) && typed === robot.name && joint;
  const attempts = robot.verifications?.hardware_attempts || [];

  const authorize = async () => {
    try {
      const a = await api.authorize(robot.id, { joint, confirmations: checks, confirm_name: typed });
      setAuth(a);
      setState('authorized');
      setResult(null);
    } catch (e) {
      toast.error(e.message);
    }
  };
  const start = async () => {
    stopRef.current = false;
    setState('running');
    let res;
    try {
      const ros = await getRos();
      res = await runHardwareTest({ ros, cfg, plan: auth.plan, stopRef, onProgress: setProg });
    } catch (e) {
      res = { outcome: 'aborted', reason: `Error: ${e.message || e}`, samples: [] };
    }
    try {
      const r = await api.result(robot.id, auth.token, res);
      setResult({ ...r, outcome: res.outcome, reason: res.reason });
      if (r.ok) toast.success('Stage 3 verified');
      else toast.error('Hardware test did not pass');
    } catch (e) {
      toast.error(e.message);
    }
    setAuth(null);
    setState('done');
    setChecks({});
    setTyped('');
    refresh();
  };
  const cancel = () => {
    setAuth(null);
    setState('idle');
  };

  return (
    <Sheet title="Stage 3 · Supervised one-joint hardware test" soft={state === 'running'}>
      <div className="grid gap-4 lg:grid-cols-2" data-hw-test={state}>
        <div className="space-y-3">
          <Callout tone="warn" title="This moves the real robot">
            One joint moves by a small amount toward the middle of its soft range, holds for 1 s and returns. Speed and distance are
            capped by the server. Stop conditions: Stop button, joint state stale for 0.4 s, another joint moving, overshoot, timeout.
            The software Stop holds the current position; it is <b>not</b> an emergency stop.
          </Callout>
          <Field label="Joint to test">
            <Select value={joint} onChange={setJoint} options={enabled.map((j) => ({ value: j.urdf_joint, label: `${j.urdf_joint} (${j.ros_joint})` }))} disabled={state === 'running' || state === 'authorized'} data-hw-joint />
          </Field>
          <div className="space-y-1.5" data-hw-checklist>
            {CHECKLIST.map(([k, text]) => (
              <label key={k} className="flex items-start gap-2 text-[12.5px]">
                <input type="checkbox" className="mt-[3px]" checked={!!checks[k]} onChange={(e) => setChecks({ ...checks, [k]: e.target.checked })} disabled={state === 'running' || state === 'authorized'} data-check-item={k} />
                {text}
              </label>
            ))}
          </div>
          <Field label={`Type "${robot.name}" to authorise motion`}>
            <TextInput value={typed} onChange={setTyped} disabled={state === 'running' || state === 'authorized'} data-hw-name />
          </Field>
          {state !== 'authorized' && state !== 'running' && (
            <button className="btn-primary" disabled={!canAuth || !robot.connected} onClick={authorize} data-action="hw-authorize">
              Authorise test
            </button>
          )}
          {!robot.connected && <div className="text-[12px] text-signal-warn">Connect the robot first.</div>}
        </div>
        <div className="space-y-3">
          {auth && (
            <div className="rounded-2xl bg-paper p-3 text-[12.5px] space-y-1" data-hw-plan>
              <div className="font-semibold">Authorised plan (valid {auth.expires_in_s} s, single use)</div>
              <div>Joint <span className="font-mono">{auth.plan.joint}</span> ({auth.plan.ros_joint}) · {auth.plan.direction_rule}</div>
              <div>Distance <span className="font-mono">{fmt(auth.plan.amplitude, 3)}</span> {auth.plan.type === 'prismatic' ? 'm' : 'rad'} at <span className="font-mono">{fmt(auth.plan.velocity, 3)}</span>/s · hold {auth.plan.hold_s} s · timeout {auth.plan.timeout_s} s</div>
              <div>Soft range <span className="font-mono">{fmt(auth.plan.soft_lower)} … {fmt(auth.plan.soft_upper)}</span> · commands on <span className="font-mono">{auth.plan.command_topic}</span> at {auth.plan.rate_hz} Hz</div>
            </div>
          )}
          {state === 'authorized' && (
            <div className="flex gap-2">
              <button className="btn-danger" onClick={start} data-action="hw-start">Start motion</button>
              <button className="btn" onClick={cancel}>Cancel</button>
            </div>
          )}
          {state === 'running' && (
            <div className="space-y-2">
              <button
                className="w-full rounded-2xl bg-signal-err text-white text-[18px] font-bold py-5 shadow-lift"
                onClick={() => {
                  stopRef.current = true;
                }}
                data-action="hw-stop"
              >
                STOP
              </button>
              {prog && (
                <div className="text-[12px] font-mono" data-hw-progress>
                  t {prog.t.toFixed(1)} / {prog.total.toFixed(1)} s · cmd {fmt(prog.cmd)} · measured {fmt(prog.pos)}
                </div>
              )}
            </div>
          )}
          {result && (
            <Callout tone={result.ok ? 'ok' : 'err'} title={result.ok ? 'Hardware test passed — Stage 3 verified' : 'Hardware test did not pass'}>
              <div data-hw-result={result.ok ? 'ok' : 'failed'}>
                {result.ok ? <div>The recorded samples matched the plan: the joint moved the commanded distance, returned, and no other joint moved.</div> : null}
                {result.reason ? <div>{result.reason}</div> : null}
                {(result.reasons || []).map((r) => <div key={r}>{r}</div>)}
              </div>
            </Callout>
          )}
          {attempts.length > 0 && (
            <div className="text-[12px]">
              <div className="label mb-1">Previous attempts</div>
              {attempts.slice().reverse().slice(0, 5).map((a, i) => (
                <div key={i} className="flex gap-2">
                  <span className={a.ok ? 'text-signal-ok' : 'text-signal-err'}>{a.ok ? 'passed' : 'failed'}</span>
                  <span className="font-mono">{a.joint}</span>
                  <span className="text-ink-3 truncate">{new Date(a.at).toLocaleString()} {a.reasons?.[0] || a.reason || ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}

function DataCheck({ robot, refresh }) {
  const [policy, setPolicy] = useState('smolvla');
  const [datasets, setDatasets] = useState([]);
  const [ds, setDs] = useState('');
  const [res, setRes] = useState(null);
  const [yaml, setYaml] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.datasets().then((r) => setDatasets(r.datasets || [])).catch(() => {});
  }, []);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.data(robot.id, { policy, dataset_id: ds || null });
      setRes(r);
      if (r.ok) toast.success('Stage 4 verified');
      refresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const exportCfg = async () => {
    try {
      setYaml(await api.serverConfig(robot.id));
    } catch (e) {
      toast.error(e.message);
    }
  };
  const allowed = robot.readiness?.allowed || {};
  return (
    <Sheet title="Stage 4 · Data and training compatibility">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Policy">
              <Select value={policy} onChange={setPolicy} options={['smolvla', 'act', 'diffusion', 'pi0']} data-data-policy />
            </Field>
            <Field label="Existing dataset (optional)">
              <Select value={ds} onChange={setDs} options={[{ value: '', label: '— none —' }, ...datasets.map((d) => ({ value: d.id, label: d.id }))]} />
            </Field>
          </div>
          <button className="btn-primary btn-sm" onClick={run} disabled={busy || !allowed.record} data-action="run-data-check">
            Check compatibility
          </button>
          {!allowed.record && <div className="text-[12px] text-ink-3">Available after Stage 3.</div>}
          {res && (
            <div data-data-result={res.ok ? 'ok' : 'failed'}>
              <IssueList issues={res.checks} />
            </div>
          )}
        </div>
        <div className="space-y-2">
          <div className="label">Recording with physical_ai_server</div>
          <p className="text-[12.5px] text-ink-3">
            Recording goes through physical_ai_server, which reads one config file per robot. Export the generated file, save it in
            <span className="font-mono">data/robot-config/</span> of RawBot Studio, restart the robot runtime, then select the robot on Home.
            This app does not install it for you.
          </p>
          <button className="btn btn-sm" onClick={exportCfg} disabled={!allowed.export_server_config} data-action="export-server-config">
            Export server config
          </button>
          {yaml && (
            <div>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11.5px]">{yaml.filename}</span>
                <button
                  className="btn-ghost text-[11.5px]"
                  onClick={() => {
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(new Blob([yaml.yaml], { type: 'text/yaml' }));
                    a.download = yaml.filename;
                    a.click();
                  }}
                >
                  Download
                </button>
              </div>
              <pre className="rounded-xl bg-paper p-2 text-[11px] max-h-[220px] overflow-auto scroll-thin" data-server-yaml>{yaml.yaml}</pre>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}

function ReadinessTab({ robot, refresh }) {
  const rd = robot.readiness;
  const [busy, setBusy] = useState(false);
  if (!rd) return null;
  const toggle = async () => {
    setBusy(true);
    try {
      await connectRobot(robot.id, !robot.connected);
      refresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-4" data-readiness-tab>
      <Sheet title="Robot readiness" actions={
        rd.allowed.connect ? (
          <button className={robot.connected ? 'btn btn-sm' : 'btn-primary btn-sm'} onClick={toggle} disabled={busy} data-action={robot.connected ? 'disconnect' : 'connect'}>
            {robot.connected ? 'Disconnect' : 'Connect'}
          </button>
        ) : null
      }>
        <StageList readiness={rd} />
        <div className="mt-3 flex gap-2 flex-wrap text-[11.5px]" data-allowed>
          {Object.entries(rd.allowed).map(([k, v]) => (
            <span key={k} className={v ? 'chip-ok' : 'chip'}>{v ? '✓' : '🔒'} {k.replace(/_/g, ' ')}</span>
          ))}
        </div>
        {robot.connected && robot.config && <div className="mt-4"><LiveJoints robot={robot} /></div>}
      </Sheet>
      {robot.state === 'registered' && robot.config && <RosCheck robot={robot} refresh={refresh} />}
      {robot.state === 'registered' && !robot.config && (
        <Callout tone="info">Save a configuration (Robot configuration tab) to run the ROS checks.</Callout>
      )}
      {rd.allowed.hardware_test && robot.config && <HardwareTest robot={robot} refresh={refresh} />}
      {rd.allowed.record && robot.config && <DataCheck robot={robot} refresh={refresh} />}
    </div>
  );
}

export const robotExtraTabs = [
  { value: 'config', label: 'Robot configuration', render: (p) => <ConfigTab key="config" {...p} /> },
  { value: 'readiness', label: 'Robot readiness', render: (p) => <ReadinessTab key="readiness" {...p} /> },
];
