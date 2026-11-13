// RawBot Studio: animated hero for the Home page.
//
// A shaded robot arm (two links, motor housings, cable, turntable base, parallel gripper)
// repeats the task the platform is used for: pick up the cube and place it in the tray.
// The pose comes from two-link inverse kinematics, so the gripper really reaches the
// cube and the tray. Purely decorative: it is NOT driven by robot data (the live,
// joint-driven model is the Simulation view in Record).

import React, { useEffect, useState } from 'react';

const SHOULDER = { x: 190, y: 250 };
const L1 = 140; // upper arm
const L2 = 128; // forearm
const WRIST_TO_TIP = 62; // wrist centre -> fingertips (gripper points down)
const FLOOR = 330;
const CUBE = 26;
const TRAY = { x: 430, w: 70, h: 16, floor: 326 };
const OPEN = 20; // finger half-gap
const CLOSED = CUBE / 2 + 0.5;

// fingertip waypoints
const P = {
  home: [270, 190],
  aboveCube: [320, 250],
  grasp: [320, FLOOR - 6],
  lift: [320, 230],
  aboveTray: [TRAY.x, 230],
  place: [TRAY.x, TRAY.floor - 6],
  rise: [TRAY.x, 200],
};

// [duration s, from, to, grip from, grip to, label]
const PHASES = [
  [0.6, 'home', 'home', OPEN, OPEN, 'Ready'],
  [1.2, 'home', 'aboveCube', OPEN, OPEN, 'Approach'],
  [0.9, 'aboveCube', 'grasp', OPEN, OPEN, 'Approach'],
  [0.5, 'grasp', 'grasp', OPEN, CLOSED, 'Grasp'],
  [0.9, 'grasp', 'lift', CLOSED, CLOSED, 'Lift'],
  [1.4, 'lift', 'aboveTray', CLOSED, CLOSED, 'Transfer'],
  [0.9, 'aboveTray', 'place', CLOSED, CLOSED, 'Place'],
  [0.5, 'place', 'place', CLOSED, OPEN, 'Release'],
  [0.7, 'place', 'rise', OPEN, OPEN, 'Retract'],
  [1.3, 'rise', 'home', OPEN, OPEN, 'Return'],
  [0.6, 'home', 'home', OPEN, OPEN, 'Ready'],
];
const CYCLE = PHASES.reduce((s, p) => s + p[0], 0);

const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const lerp = (a, b, u) => a + (b - a) * u;

function stateAt(t) {
  let tt = t % CYCLE;
  for (let i = 0; i < PHASES.length; i += 1) {
    const [d, from, to, g0, g1, label] = PHASES[i];
    if (tt <= d || i === PHASES.length - 1) {
      const u = ease(Math.min(1, tt / d));
      return {
        tip: [lerp(P[from][0], P[to][0], u), lerp(P[from][1], P[to][1], u)],
        grip: lerp(g0, g1, u),
        phase: i,
        u,
        label,
      };
    }
    tt -= d;
  }
  return null;
}

// two-link IK, elbow above the line shoulder -> wrist
function solve(wx, wy) {
  const dx = wx - SHOULDER.x;
  const dy = wy - SHOULDER.y;
  const d = Math.min(Math.hypot(dx, dy), L1 + L2 - 0.01);
  const base = Math.atan2(dy, dx);
  const off = Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))));
  const cands = [base - off, base + off].map((a) => ({
    a,
    ex: SHOULDER.x + L1 * Math.cos(a),
    ey: SHOULDER.y + L1 * Math.sin(a),
  }));
  const e = cands[0].ey < cands[1].ey ? cands[0] : cands[1];
  return { a1: e.a, ex: e.ex, ey: e.ey, a2: Math.atan2(wy - e.ey, wx - e.ex) };
}

const deg = (r) => (r * 180) / Math.PI;

function Link({ x, y, angle, length, width, grad }) {
  const a = deg(angle);
  return (
    <>
      {/* far side plate: gives the link thickness */}
      <g transform={`translate(${x + 3} ${y + 4}) rotate(${a})`}>
        <rect x={-width / 2} y={-width / 2} width={length + width} height={width} rx={width / 2} fill="#3A3F48" />
      </g>
      <g transform={`translate(${x} ${y}) rotate(${a})`}>
        <rect x={-width / 2} y={-width / 2} width={length + width} height={width} rx={width / 2} fill={`url(#${grad})`} stroke="#7C838E" strokeWidth="0.6" />
        {/* machined groove and highlight */}
        <rect x={width * 0.4} y={-width * 0.12} width={length - width * 0.8} height={width * 0.24} rx={width * 0.12} fill="#1E2228" opacity="0.18" />
        <line x1={width * 0.3} y1={-width * 0.36} x2={length - width * 0.3} y2={-width * 0.36} stroke="#FFFFFF" strokeWidth="1.2" strokeLinecap="round" opacity="0.75" />
      </g>
    </>
  );
}

function Joint({ x, y, r, led }) {
  const bolts = [0, 1, 2, 3, 4, 5].map((i) => {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    return <circle key={i} cx={x + Math.cos(a) * r * 0.78} cy={y + Math.sin(a) * r * 0.78} r={r * 0.07} fill="#9BA3AE" />;
  });
  return (
    <g>
      <circle cx={x + 2} cy={y + 3} r={r} fill="#14171B" opacity="0.35" />
      <circle cx={x} cy={y} r={r} fill="url(#housing)" />
      <circle cx={x} cy={y} r={r - 1.2} fill="none" stroke="#2457E6" strokeWidth="1.4" opacity="0.85" />
      <circle cx={x} cy={y} r={r * 0.62} fill="url(#cap)" stroke="#59606B" strokeWidth="0.5" />
      {bolts}
      <circle cx={x} cy={y} r={r * 0.2} fill="#1A1D22" />
      <circle cx={x - r * 0.06} cy={y - r * 0.06} r={r * 0.07} fill="#FFFFFF" opacity="0.7" />
      <circle cx={x + r * 0.7} cy={y - r * 0.7} r={1.6} fill="#38BDF8" opacity={led} />
    </g>
  );
}

function Cube({ x, bottom, opacity = 1 }) {
  const s = CUBE;
  const top = bottom - s;
  const dx = 7;
  const dy = 5;
  return (
    <g opacity={opacity}>
      <path d={`M${x - s / 2} ${top} l${dx} ${-dy} h${s} l${-dx} ${dy} Z`} fill="#F07A7E" />
      <path d={`M${x + s / 2} ${top} l${dx} ${-dy} v${s} l${-dx} ${dy} Z`} fill="#B8333A" />
      <rect x={x - s / 2} y={top} width={s} height={s} fill="#E5484D" />
      <rect x={x - s / 2} y={top} width={s} height={s} fill="url(#cubeShine)" />
    </g>
  );
}

export default function HeroArm({ className }) {
  const [t, setT] = useState(5.2);
  useEffect(() => {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return undefined;
    let raf;
    const start = performance.now() - 5200;
    const loop = (now) => {
      setT((now - start) / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const s = stateAt(t);
  const [tx, ty] = s.tip;
  const wx = tx;
  const wy = ty - WRIST_TO_TIP;
  const k = solve(wx, wy);
  const held = s.phase >= 4 && s.phase <= 6;
  const inTray = s.phase >= 7;
  // cube: on the table, in the gripper, or in the tray; a fresh cube fades in at the end
  const cycleT = t % CYCLE;
  const fade = s.phase === 10 ? s.u : 0;
  let cube = { x: P.grasp[0], bottom: FLOOR };
  if (s.phase === 3) cube = { x: P.grasp[0], bottom: FLOOR };
  if (held) cube = { x: tx, bottom: ty + 6 };
  if (inTray) cube = { x: TRAY.x, bottom: TRAY.floor };
  const led = 0.55 + 0.45 * Math.sin(cycleT * 4);
  const shoulderDeg = 90 + deg(k.a1);
  const elbowDeg = deg(k.a2 - k.a1);
  const wristDeg = 90 - deg(k.a2);
  const tipHeight = Math.max(0, FLOOR - ty);
  const palmY = wy + 14;
  const fingerTop = wy + 26;

  const mono = { fontFamily: 'Geist Mono, ui-monospace, monospace' };
  const row = (y, name, val, accent) => (
    <g key={name}>
      <text x="30" y={y} fontSize="8.5" fill="#737A85" {...mono}>{name}</text>
      <text x="128" y={y} fontSize="8.5" fill={accent ? '#2457E6' : '#0B0C0E'} textAnchor="end" {...mono}>{val}</text>
    </g>
  );

  return (
    <svg viewBox="0 0 560 400" className={className} role="img" aria-label="Animated robot arm picking up a cube and placing it in a tray">
      <defs>
        <linearGradient id="linkA" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FBFCFD" />
          <stop offset="0.35" stopColor="#E3E7EC" />
          <stop offset="0.75" stopColor="#B9C0C9" />
          <stop offset="1" stopColor="#8E96A1" />
        </linearGradient>
        <linearGradient id="linkB" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F7F9FB" />
          <stop offset="0.4" stopColor="#DCE1E7" />
          <stop offset="1" stopColor="#8C949F" />
        </linearGradient>
        <radialGradient id="housing" cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#4A505A" />
          <stop offset="0.6" stopColor="#23272D" />
          <stop offset="1" stopColor="#111316" />
        </radialGradient>
        <radialGradient id="cap" cx="0.35" cy="0.3" r="0.85">
          <stop offset="0" stopColor="#F4F6F8" />
          <stop offset="0.7" stopColor="#B8BFC8" />
          <stop offset="1" stopColor="#7F8792" />
        </radialGradient>
        <linearGradient id="column" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#1C1F24" />
          <stop offset="0.3" stopColor="#4B525C" />
          <stop offset="0.55" stopColor="#2A2E35" />
          <stop offset="1" stopColor="#14161A" />
        </linearGradient>
        <linearGradient id="plate" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#B4BBC4" />
          <stop offset="0.35" stopColor="#F2F4F7" />
          <stop offset="1" stopColor="#9AA2AD" />
        </linearGradient>
        <linearGradient id="metal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#8E96A1" />
          <stop offset="0.4" stopColor="#EEF1F4" />
          <stop offset="1" stopColor="#7A828D" />
        </linearGradient>
        <linearGradient id="cubeShine" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.28" />
          <stop offset="0.6" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="floorFade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="1" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="frustum" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2457E6" stopOpacity="0.10" />
          <stop offset="1" stopColor="#2457E6" stopOpacity="0.02" />
        </linearGradient>
        <radialGradient id="shadow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#0B0C0E" stopOpacity="0.28" />
          <stop offset="1" stopColor="#0B0C0E" stopOpacity="0" />
        </radialGradient>
        <mask id="floorMask">
          <rect x="0" y={FLOOR} width="560" height="70" fill="url(#floorFade)" />
        </mask>
      </defs>

      {/* perspective floor */}
      <g mask="url(#floorMask)" stroke="#0B0C0E" strokeWidth="0.6" opacity="0.22">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => {
          const y = FLOOR + Math.pow(i / 6, 1.5) * 70;
          return <line key={`h${i}`} x1="0" y1={y} x2="560" y2={y} />;
        })}
        {Array.from({ length: 15 }, (_, i) => {
          const x0 = -60 + i * 50;
          const vx = 290;
          const vy = 180;
          const x1 = vx + ((x0 - vx) * (400 - vy)) / (FLOOR - vy);
          return <line key={`v${i}`} x1={x0} y1={FLOOR} x2={x1} y2={400} />;
        })}
      </g>
      <line x1="20" y1={FLOOR} x2="540" y2={FLOOR} stroke="#0B0C0E" strokeWidth="0.8" opacity="0.35" />

      {/* overhead camera and its field of view */}
      <path d={`M478 76 L350 ${FLOOR} L540 ${FLOOR} Z`} fill="url(#frustum)" />
      <line x1="478" y1="76" x2="350" y2={FLOOR} stroke="#2457E6" strokeWidth="0.7" strokeDasharray="3 4" opacity="0.45" />
      <line x1="478" y1="76" x2="540" y2={FLOOR} stroke="#2457E6" strokeWidth="0.7" strokeDasharray="3 4" opacity="0.45" />
      <g>
        <rect x="462" y="58" width="32" height="18" rx="4" fill="url(#housing)" />
        <circle cx="478" cy="76" r="5.5" fill="#111316" stroke="#59606B" strokeWidth="0.8" />
        <circle cx="478" cy="76" r="2.4" fill="#2457E6" />
        <circle cx="489" cy="63" r="1.4" fill="#38BDF8" opacity={led} />
        <text x="500" y="66" fontSize="8" fill="#737A85" {...mono}>CAM 1</text>
      </g>

      {/* shadows */}
      <ellipse cx={SHOULDER.x} cy={FLOOR + 2} rx="84" ry="9" fill="url(#shadow)" />
      <ellipse cx={tx} cy={FLOOR + 1} rx={22 - Math.min(14, tipHeight / 12)} ry="4" fill="url(#shadow)" opacity={Math.max(0.25, 1 - tipHeight / 160)} />
      <ellipse cx={TRAY.x + 4} cy={FLOOR + 1.5} rx="44" ry="5" fill="url(#shadow)" />

      {/* tray (back) */}
      <path d={`M${TRAY.x - TRAY.w / 2 + 6} ${FLOOR - TRAY.h - 6} h${TRAY.w} l-6 6 h${-TRAY.w} Z`} fill="#C9D3E3" />
      <rect x={TRAY.x - TRAY.w / 2} y={FLOOR - TRAY.h} width={TRAY.w} height="2" fill="#AEB8C8" />

      {/* cube: table / gripper / tray, and a fresh one at the end of the cycle */}
      {!inTray && <Cube x={cube.x} bottom={cube.bottom} />}
      {inTray && <Cube x={TRAY.x} bottom={TRAY.floor} opacity={1 - fade} />}
      {s.phase === 10 && <Cube x={P.grasp[0]} bottom={FLOOR} opacity={fade} />}

      {/* tray (front) */}
      <path d={`M${TRAY.x - TRAY.w / 2} ${FLOOR - TRAY.h} h${TRAY.w} l6 -6 v${TRAY.h} l-6 6 Z`} fill="#8FA0BA" opacity="0.9" />
      <rect x={TRAY.x - TRAY.w / 2} y={FLOOR - TRAY.h} width={TRAY.w} height={TRAY.h} rx="1.5" fill="#B7C5DA" opacity="0.92" />
      <rect x={TRAY.x - TRAY.w / 2 + 4} y={FLOOR - TRAY.h + 3} width={TRAY.w - 8} height="1.4" fill="#FFFFFF" opacity="0.6" />

      {/* base: plate + turntable column */}
      <rect x={SHOULDER.x - 70} y={FLOOR - 12} width="140" height="12" fill="url(#plate)" />
      <ellipse cx={SHOULDER.x} cy={FLOOR - 12} rx="70" ry="10" fill="#F6F8FA" stroke="#A9B1BB" strokeWidth="0.6" />
      <rect x={SHOULDER.x - 28} y={SHOULDER.y} width="56" height={FLOOR - 12 - SHOULDER.y} fill="url(#column)" />
      <ellipse cx={SHOULDER.x} cy={FLOOR - 12} rx="28" ry="6" fill="#1A1D22" opacity="0.5" />
      <ellipse cx={SHOULDER.x} cy={SHOULDER.y} rx="28" ry="7" fill="#4B525C" />
      <rect x={SHOULDER.x - 28} y={SHOULDER.y + 26} width="56" height="3" fill="#2457E6" opacity="0.8" />
      <circle cx={SHOULDER.x + 16} cy={SHOULDER.y + 44} r="1.8" fill="#38BDF8" opacity={led} />

      {/* cable from the base to the forearm */}
      <path
        d={`M${SHOULDER.x - 20} ${SHOULDER.y + 20} Q ${(SHOULDER.x + k.ex) / 2 - 26} ${(SHOULDER.y + k.ey) / 2 + 4} ${k.ex - 8} ${k.ey + 10}`}
        fill="none" stroke="#1A1D22" strokeWidth="2.4" strokeLinecap="round" opacity="0.85"
      />

      {/* upper arm, elbow, forearm */}
      <Link x={SHOULDER.x} y={SHOULDER.y} angle={k.a1} length={L1} width={30} grad="linkA" />
      <Link x={k.ex} y={k.ey} angle={k.a2} length={L2} width={24} grad="linkB" />
      <Joint x={SHOULDER.x} y={SHOULDER.y} r={22} led={led} />
      <Joint x={k.ex} y={k.ey} r={18} led={led} />

      {/* wrist, wrist camera and parallel gripper (always pointing down) */}
      <rect x={wx - 9} y={wy} width="18" height="16" fill="url(#metal)" />
      <rect x={wx - 24} y={palmY} width="48" height="12" rx="3" fill="url(#housing)" />
      <rect x={wx - 22} y={palmY + 4.5} width="44" height="1.5" fill="#2457E6" opacity="0.8" />
      <rect x={wx + 14} y={palmY - 7} width="11" height="8" rx="2" fill="#23272D" />
      <circle cx={wx + 19.5} cy={palmY - 3} r="2" fill="#2457E6" />
      {[-1, 1].map((side) => (
        <g key={side}>
          <rect x={wx + side * s.grip - (side < 0 ? 7 : 0)} y={fingerTop} width="7" height="34" rx="2" fill="url(#metal)" stroke="#7C838E" strokeWidth="0.5" />
          <rect x={wx + side * s.grip - (side < 0 ? 1.5 : 0)} y={fingerTop + 16} width="1.5" height="16" fill="#1A1D22" opacity="0.6" />
        </g>
      ))}
      <Joint x={wx} y={wy} r={13} led={led} />

      {/* live readout */}
      <g>
        <rect x="18" y="18" width="122" height="98" rx="8" fill="#FFFFFF" opacity="0.78" stroke="#DADDE2" strokeWidth="0.8" />
        <circle cx="31" cy="33" r="2.6" fill="#2457E6" opacity={led} />
        <text x="39" y="36" fontSize="8.5" fill="#0B0C0E" fontWeight="600" {...mono}>{s.label.toUpperCase()}</text>
        {row(54, 'J2 SHOULDER', `${shoulderDeg.toFixed(1)}°`)}
        {row(68, 'J3 ELBOW', `${elbowDeg.toFixed(1)}°`)}
        {row(82, 'J4 WRIST', `${wristDeg.toFixed(1)}°`)}
        {row(96, 'GRIPPER', s.grip < OPEN - 1 ? 'closed' : 'open', s.grip < OPEN - 1)}
        {row(110, 'TCP HEIGHT', `${(tipHeight / 10).toFixed(1)} cm`)}
      </g>
    </svg>
  );
}
