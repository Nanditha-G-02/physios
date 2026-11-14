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

// Simulation-style view. The arm pose comes ONLY from the live follower
// JointState topic (via rosbridge); when no data arrives the view says so and
// freezes - it never animates on its own. Object/target boxes are the *planned*
// positions of the current plan episode, not sensed positions.
//
// SO-101 family robots use an approximate kinematic model (link lengths from
// the public design; zero pose, signs and offsets are adjustable because they
// depend on the calibration). Other robots get a live joint-value panel.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../../components/ThemeToggle';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import ROSLIB from 'roslib';
import { useSelector } from 'react-redux';
import clsx from 'clsx';
import rosConnectionManager from '../../utils/rosConnectionManager';
import { usePlanningService } from '../../hooks/usePlanningService';
import { Segmented } from '../../components/ui';

// line-drawing palette: light theme as before; dark theme (light lines on charcoal), chosen
// when the scene is built
const PAL_LIGHT = { ink: 0x121414, rule: 0xcdd0cb, fill: 0xffffff, bg: 0xffffff };
const PAL_DARK = { ink: 0xe9ecf1, rule: 0x2c323d, fill: 0x161a22, bg: 0x0f1218 };
let PAL = PAL_LIGHT;
const SKY = 0xccdaff;

const SO101_JOINTS = [
  { key: 'pan', match: /pan|joint1$|^j1$/i, axis: 'z' },
  { key: 'lift', match: /lift|shoulder(?!_pan)|joint2$/i, axis: 'y' },
  { key: 'elbow', match: /elbow|joint3$/i, axis: 'y' },
  { key: 'wrist_flex', match: /wrist_flex|wrist_pitch|joint4$/i, axis: 'y' },
  { key: 'wrist_roll', match: /roll|joint5$/i, axis: 'x' },
  { key: 'gripper', match: /grip|jaw|joint6$/i, axis: 'g' },
];

const DEFAULT_CAL = {
  units: 'rad', // 'rad' | 'deg'
  gripperRange: 1.0, // value that means fully open
  joints: {
    pan: { sign: 1, offset: 0 },
    lift: { sign: 1, offset: 0 },
    elbow: { sign: 1, offset: 0 },
    wrist_flex: { sign: 1, offset: 0 },
    wrist_roll: { sign: 1, offset: 0 },
  },
};

function loadCal(robotType) {
  try {
    const raw = window.localStorage.getItem(`pam.simcal.${robotType}`);
    return raw ? { ...DEFAULT_CAL, ...JSON.parse(raw) } : DEFAULT_CAL;
  } catch (e) {
    return DEFAULT_CAL;
  }
}

function edgeBox(w, d, h, fill = PAL.fill, opacity = 1) {
  const g = new THREE.BoxGeometry(w, d, h);
  const mesh = new THREE.Mesh(
    g,
    new THREE.MeshBasicMaterial({ color: fill, transparent: opacity < 1, opacity, polygonOffset: true, polygonOffsetFactor: 1 })
  );
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: PAL.ink }));
  mesh.add(edges);
  return mesh;
}

function mapJoints(names) {
  const used = new Set();
  return SO101_JOINTS.map((j, i) => {
    let idx = names.findIndex((n, k) => !used.has(k) && j.match.test(n));
    if (idx < 0 && names.length >= 6) idx = i; // fall back to order
    if (idx >= 0) used.add(idx);
    return idx;
  });
}

export default function SimulationView({ episode, plan, active = true, compact }) {
  const robotType = useSelector((s) => s.tasks.taskStatus.robotType);
  const rosbridgeUrl = useSelector((s) => s.ros.rosbridgeUrl);
  const { call } = usePlanningService();
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const jointsRef = useRef({ names: [], position: [], stamp: 0 });
  const [topic, setTopic] = useState('');
  const [profileKey, setProfileKey] = useState('');
  const [live, setLive] = useState({ age: null, values: [], names: [] });
  const [cal, setCal] = useState(() => loadCal(robotType));
  const [showCal, setShowCal] = useState(false);
  const [problem, setProblem] = useState('');
  const calRef = useRef(cal);
  calRef.current = cal;

  useEffect(() => {
    try {
      window.localStorage.setItem(`pam.simcal.${robotType}`, JSON.stringify(cal));
    } catch (e) {
      /* ignore */
    }
  }, [cal, robotType]);

  // which topic carries the follower joints?
  useEffect(() => {
    let cancelled = false;
    call('robot.profile', {})
      .then((res) => {
        if (cancelled) return;
        setProfileKey(res.profile?.key || 'generic');
        const entry = (res.params?.joint_topic_list || []).find((e) => /^follower/i.test(e)) || '';
        const t = entry.includes(':') ? entry.slice(entry.indexOf(':') + 1) : entry;
        setTopic(t);
        if (!t) setProblem('No follower joint topic in the robot configuration (joint_topic_list).');
      })
      .catch((e) => !cancelled && setProblem(e.message));
    return () => {
      cancelled = true;
    };
  }, [call, robotType]);

  // subscribe
  useEffect(() => {
    if (!active || !topic) return undefined;
    let sub;
    let cancelled = false;
    rosConnectionManager
      .getConnection(rosbridgeUrl)
      .then((ros) => {
        if (cancelled) return;
        sub = new ROSLIB.Topic({
          ros,
          name: topic,
          messageType: 'sensor_msgs/msg/JointState',
          throttle_rate: 33,
          queue_length: 1,
        });
        sub.subscribe((msg) => {
          jointsRef.current = { names: msg.name || [], position: msg.position || [], stamp: performance.now() };
        });
      })
      .catch((e) => setProblem(`Cannot subscribe to ${topic}: ${e.message}`));
    return () => {
      cancelled = true;
      if (sub) sub.unsubscribe();
    };
  }, [active, topic, rosbridgeUrl]);

  // HUD refresh (4 Hz)
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => {
      const j = jointsRef.current;
      setLive({ age: j.stamp ? performance.now() - j.stamp : null, values: j.position, names: j.names });
    }, 250);
    return () => clearInterval(id);
  }, [active]);

  const isSo101 = profileKey === 'so101';
  const dark = useTheme() === 'dark';

  // three.js scene (SO-101 only)
  useEffect(() => {
    if (!active || !isSo101 || !mountRef.current) return undefined;
    const el = mountRef.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    PAL = dark ? PAL_DARK : PAL_LIGHT;
    renderer.setClearColor(PAL.bg);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10);
    camera.up.set(0, 0, 1);
    camera.position.set(0.75, -0.55, 0.55);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0.15, 0, 0.08);
    controls.enableDamping = true;

    // table grid (10 cm) in the table frame: x forward, y left, z up
    const grid = new THREE.GridHelper(0.8, 16, PAL.rule, PAL.rule);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(0.2, 0, 0);
    scene.add(grid);

    // arm
    const base = edgeBox(0.11, 0.11, 0.05);
    base.position.z = 0.025;
    scene.add(base);
    const j1 = new THREE.Group();
    j1.position.z = 0.05;
    scene.add(j1);
    const turret = edgeBox(0.06, 0.07, 0.06);
    turret.position.set(0, 0, 0.03);
    j1.add(turret);
    const j2 = new THREE.Group();
    j2.position.set(0.0, 0, 0.065);
    j1.add(j2);
    const upper = edgeBox(0.035, 0.04, 0.116, SKY);
    upper.position.z = 0.058;
    j2.add(upper);
    const j3 = new THREE.Group();
    j3.position.z = 0.116;
    j2.add(j3);
    const fore = edgeBox(0.135, 0.032, 0.03);
    fore.position.x = 0.0675;
    j3.add(fore);
    const j4 = new THREE.Group();
    j4.position.x = 0.135;
    j3.add(j4);
    const wrist = edgeBox(0.05, 0.035, 0.03, SKY);
    wrist.position.x = 0.025;
    j4.add(wrist);
    const j5 = new THREE.Group();
    j5.position.x = 0.05;
    j4.add(j5);
    const palm = edgeBox(0.03, 0.05, 0.02);
    palm.position.x = 0.015;
    j5.add(palm);
    const jawA = edgeBox(0.06, 0.008, 0.016);
    const jawB = edgeBox(0.06, 0.008, 0.016);
    jawA.position.set(0.06, 0.012, 0);
    jawB.position.set(0.06, -0.012, 0);
    j5.add(jawA);
    j5.add(jawB);
    const tip = new THREE.Object3D();
    tip.position.x = 0.09;
    j5.add(tip);

    // trail of the gripper tip
    const trailN = 120;
    const trailPos = new Float32Array(trailN * 3);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
    trailGeo.setDrawRange(0, 0);
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0x2457e6 }));
    scene.add(trail);
    let trailCount = 0;

    const planGroup = new THREE.Group();
    scene.add(planGroup);
    sceneRef.current = { planGroup };

    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let raf;
    let lastStamp = 0;
    const tmp = new THREE.Vector3();
    const render = () => {
      raf = requestAnimationFrame(render);
      const j = jointsRef.current;
      const c = calRef.current;
      if (j.stamp && j.stamp !== lastStamp) {
        lastStamp = j.stamp;
        const idx = mapJoints(j.names);
        const conv = (v) => (c.units === 'deg' ? (v * Math.PI) / 180 : v);
        const val = (k, i) => {
          const raw = idx[i] >= 0 ? j.position[idx[i]] : undefined;
          if (raw === undefined || raw === null || Number.isNaN(raw)) return 0;
          const jc = c.joints[k] || { sign: 1, offset: 0 };
          return jc.sign * conv(raw) + (jc.offset * Math.PI) / 180;
        };
        j1.rotation.z = val('pan', 0);
        j2.rotation.y = val('lift', 1);
        j3.rotation.y = val('elbow', 2);
        j4.rotation.y = val('wrist_flex', 3);
        j5.rotation.x = val('wrist_roll', 4);
        const graw = idx[5] >= 0 ? Number(j.position[idx[5]]) || 0 : 0;
        const open = Math.max(0, Math.min(1, Math.abs(graw) / (c.gripperRange || 1)));
        jawA.position.y = 0.006 + open * 0.025;
        jawB.position.y = -0.006 - open * 0.025;
        tip.getWorldPosition(tmp);
        trailPos.copyWithin(3, 0, (trailN - 1) * 3);
        trailPos[0] = tmp.x;
        trailPos[1] = tmp.y;
        trailPos[2] = tmp.z;
        trailCount = Math.min(trailN, trailCount + 1);
        trailGeo.setDrawRange(0, trailCount);
        trailGeo.attributes.position.needsUpdate = true;
      }
      const stale = !j.stamp || performance.now() - j.stamp > 1000;
      upper.material.color.setHex(stale ? 0xe3e4dc : SKY);
      wrist.material.color.setHex(stale ? 0xe3e4dc : SKY);
      controls.update();
      renderer.render(scene, camera);
    };
    render();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
  }, [active, isSo101, dark]);

  // planned workspace / items overlay
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const g = s.planGroup;
    while (g.children.length) {
      const c = g.children.pop();
      c.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    if (!plan) return;
    const ws = plan.task.workspace;
    const mm = (v) => v / 1000;
    const rectLine = (r, color, dashed) => {
      const pts = [
        [r.x_min_mm, r.y_min_mm],
        [r.x_max_mm, r.y_min_mm],
        [r.x_max_mm, r.y_max_mm],
        [r.x_min_mm, r.y_max_mm],
        [r.x_min_mm, r.y_min_mm],
      ].map(([x, y]) => new THREE.Vector3(mm(x), mm(y), 0.001));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = dashed
        ? new THREE.LineDashedMaterial({ color, dashSize: 0.01, gapSize: 0.006 })
        : new THREE.LineBasicMaterial({ color });
      const line = new THREE.Line(geo, mat);
      if (dashed) line.computeLineDistances();
      return line;
    };
    g.add(rectLine(ws, PAL.ink, false));
    const reach = new THREE.EllipseCurve(0, 0, mm(ws.reach_max_mm), mm(ws.reach_max_mm), -Math.PI / 2, Math.PI / 2);
    const reachLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(reach.getPoints(64).map((p) => new THREE.Vector3(p.x, p.y, 0.001))),
      new THREE.LineDashedMaterial({ color: PAL.ink, dashSize: 0.012, gapSize: 0.008 })
    );
    reachLine.computeLineDistances();
    g.add(reachLine);
    (plan.task.regions || []).forEach((r) => g.add(rectLine(r, 0x6a7171, true)));
    if (episode) {
      episode.placements.forEach((p) => {
        const item = plan.task.items.find((i) => i.id === p.item_id);
        if (!item) return;
        const size = mm(item.size_mm || 30);
        const h = item.role === 'target' ? 0.012 : size;
        const color = new THREE.Color(item.color || '#D9534F').getHex();
        const box = edgeBox(size, size, h, color, item.role === 'target' ? 0.15 : 0.45);
        box.position.set(mm(p.x_mm), mm(p.y_mm), h / 2);
        box.rotation.z = ((p.yaw_deg || 0) * Math.PI) / 180;
        g.add(box);
      });
    }
  }, [plan, episode, isSo101, active, dark]);

  const age = live.age;
  const state = age === null ? 'none' : age > 1000 ? 'stale' : 'live';
  const setJ = (k, patch) => setCal((c) => ({ ...c, joints: { ...c.joints, [k]: { ...c.joints[k], ...patch } } }));

  return (
    <div className="relative h-full w-full flex min-h-0 bg-white">
      <div className="relative flex-1 min-w-0">
        {isSo101 ? (
          <div ref={mountRef} className="absolute inset-0" />
        ) : (
          <JointBars names={live.names} values={live.values} />
        )}
        <div className="absolute left-2 top-2 flex flex-wrap gap-1.5">
          <span className="chip-ink">SIMULATION · live joints</span>
          <span className={clsx(state === 'live' ? 'chip-ok' : state === 'stale' ? 'chip-warn' : 'chip-err')}>
            {state === 'live' ? `LIVE · ${Math.round(age)} ms` : state === 'stale' ? 'STALE — no new joint data' : 'NO JOINT DATA'}
          </span>
          {topic && <span className="chip num">{topic}</span>}
        </div>
        <div className="absolute left-2 bottom-2 text-[11px] text-ink-3 bg-white/85 px-1.5 py-0.5">
          {isSo101 ? 'Approximate SO-101 kinematics · ' : ''}boxes = planned positions (not sensed)
        </div>
        {problem && (
          <div className="absolute inset-x-2 top-10 bg-signal-errbg border border-signal-err/40 px-2 py-1 text-[12px]">{problem}</div>
        )}
        {isSo101 && (
          <button className="absolute right-2 top-2 btn btn-sm bg-white/90" onClick={() => setShowCal(!showCal)}>
            {showCal ? 'Close' : 'Joint mapping…'}
          </button>
        )}
      </div>
      {showCal && isSo101 && !compact && (
        <div className="w-[240px] shrink-0 border-l border-ink overflow-y-auto scroll-thin p-3 space-y-3 text-[12px]">
          <p className="text-ink-3">Match the drawing to the real arm once; saved in this browser for {robotType}.</p>
          <div>
            <div className="label mb-1">Joint units</div>
            <Segmented
              size="sm"
              value={cal.units}
              onChange={(v) => setCal({ ...cal, units: v })}
              options={[
                { value: 'rad', label: 'radians' },
                { value: 'deg', label: 'degrees' },
              ]}
            />
          </div>
          {Object.keys(DEFAULT_CAL.joints).map((k) => (
            <div key={k} className="grid grid-cols-[1fr_auto_70px] gap-1.5 items-center">
              <span className="truncate">{k}</span>
              <button className="btn btn-sm px-2" onClick={() => setJ(k, { sign: -(cal.joints[k]?.sign || 1) })}>
                {(cal.joints[k]?.sign || 1) > 0 ? '+' : '−'}
              </button>
              <input
                type="number"
                className="input num py-0.5"
                value={cal.joints[k]?.offset ?? 0}
                onChange={(e) => setJ(k, { offset: Number(e.target.value) })}
                aria-label={`${k} offset degrees`}
              />
            </div>
          ))}
          <label className="block">
            <span className="label">Gripper fully-open value</span>
            <input
              type="number"
              className="input num"
              value={cal.gripperRange}
              onChange={(e) => setCal({ ...cal, gripperRange: Number(e.target.value) || 1 })}
            />
          </label>
          <button className="btn btn-sm w-full" onClick={() => setCal(DEFAULT_CAL)}>
            Reset
          </button>
          <JointBars names={live.names} values={live.values} small />
        </div>
      )}
    </div>
  );
}

function JointBars({ names = [], values = [], small }) {
  const rows = useMemo(() => names.map((n, i) => [n, values[i]]), [names, values]);
  if (!rows.length) {
    return (
      <div className={clsx('h-full grid place-items-center text-[12.5px] text-ink-3', small && 'h-auto py-2')}>
        Waiting for joint states…
      </div>
    );
  }
  return (
    <div className={clsx('space-y-1.5', small ? '' : 'p-6 pt-12 max-w-xl')}>
      {rows.map(([n, v]) => {
        const x = Number(v) || 0;
        const pct = Math.max(-1, Math.min(1, x / Math.PI));
        return (
          <div key={n} className="grid grid-cols-[110px_1fr_64px] gap-2 items-center text-[12px]">
            <span className="truncate">{n}</span>
            <div className="relative h-2 border border-ink bg-white">
              <div className="absolute top-0 bottom-0 left-1/2 w-px bg-ink/30" />
              <div
                className="absolute top-0 bottom-0 bg-sky-ink"
                style={{ left: pct >= 0 ? '50%' : `${50 + pct * 50}%`, width: `${Math.abs(pct) * 50}%` }}
              />
            </div>
            <span className="num text-right">{x.toFixed(3)}</span>
          </div>
        );
      })}
    </div>
  );
}
