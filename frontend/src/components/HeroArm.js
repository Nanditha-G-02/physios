// RawBot Studio: animated hero for the Home page.
//
// A small 3D scene drawn as SVG (no 3D library): a six-part manipulator (base, turntable,
// shoulder, upper arm, elbow, forearm, wrist, parallel gripper), a cube and a tray, seen
// in three-quarter perspective. Cylinders and boxes are projected through a perspective
// camera, shaded from one light and sorted back to front; soft shadows fall on the floor.
// The arm repeats the task the platform is used for - pick up the cube, place it in the
// tray - with base rotation and two-link inverse kinematics, so the gripper really reaches
// both. Purely decorative: it is NOT driven by robot data (the live, joint-driven model
// is the Simulation view in Record). Static for prefers-reduced-motion.

import React, { useEffect, useState } from 'react';

// ---------------------------------------------------------------- scene geometry (mm)
const H_SHOULDER = 168; // shoulder axis height above the floor
const L1 = 182; // upper arm
const L2 = 170; // forearm
const WRIST_DROP = 96; // wrist axis -> fingertips (gripper points down)
const CUBE = 44;
const TRAY = { r: 250, psi: 62, w: 128, d: 96, h: 16 };
const OPEN = 34; // finger half-gap
const CLOSED = CUBE / 2 + 4;

// fingertip waypoints: [radius, azimuth deg, height]
const W = {
  home: [175, 36, 230],
  aboveCube: [255, 8, 120],
  grasp: [255, 8, 12],
  lift: [255, 8, 150],
  aboveTray: [TRAY.r, TRAY.psi, 150],
  place: [TRAY.r, TRAY.psi, TRAY.h + 12],
  rise: [TRAY.r, TRAY.psi, 160],
};
// [duration s, from, to, gripper from, to]
const PHASES = [
  [0.9, 'home', 'home', OPEN, OPEN],
  [1.8, 'home', 'aboveCube', OPEN, OPEN],
  [1.1, 'aboveCube', 'grasp', OPEN, OPEN],
  [0.7, 'grasp', 'grasp', OPEN, CLOSED],
  [1.1, 'grasp', 'lift', CLOSED, CLOSED],
  [2.2, 'lift', 'aboveTray', CLOSED, CLOSED],
  [1.1, 'aboveTray', 'place', CLOSED, CLOSED],
  [0.7, 'place', 'place', CLOSED, OPEN],
  [1.0, 'place', 'rise', OPEN, OPEN],
  [1.9, 'rise', 'home', OPEN, OPEN],
  [1.0, 'home', 'home', OPEN, OPEN],
];
const CYCLE = PHASES.reduce((s, p) => s + p[0], 0);

// quintic smootherstep: zero velocity and acceleration at both ends
const smooth = (u) => u * u * u * (u * (u * 6 - 15) + 10);
const lerp = (a, b, u) => a + (b - a) * u;

function stateAt(t) {
  let tt = ((t % CYCLE) + CYCLE) % CYCLE;
  for (let i = 0; i < PHASES.length; i += 1) {
    const [d, from, to, g0, g1] = PHASES[i];
    if (tt <= d || i === PHASES.length - 1) {
      const u = smooth(Math.min(1, tt / d));
      const a = W[from];
      const b = W[to];
      // lift before swinging and swing before lowering: height leads on the way up,
      // azimuth leads on the way across, which keeps the path clear of the table
      const uh = b[2] > a[2] ? smooth(Math.min(1, u * 1.35)) : smooth(Math.max(0, u * 1.35 - 0.35));
      return {
        r: lerp(a[0], b[0], u),
        psi: lerp(a[1], b[1], u),
        h: lerp(a[2], b[2], from === to ? u : uh),
        grip: lerp(g0, g1, u),
        phase: i,
        u,
      };
    }
    tt -= d;
  }
  return null;
}

// --------------------------------------------------------------------------- vectors
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const Z = [0, 0, 1];
const rad = (d) => (d * Math.PI) / 180;

// -------------------------------------------------------------------------- camera
const VIEW = { w: 760, h: 540 };
const CAM = { yaw: rad(-32), pitch: rad(21), f: 1600, scale: 1.02, cx: 372, cy: 292, target: [110, 120, 130] };
const cY = Math.cos(CAM.yaw);
const sY = Math.sin(CAM.yaw);
const cP = Math.cos(CAM.pitch);
const sP = Math.sin(CAM.pitch);
function viewOf(p) {
  const x = p[0] - CAM.target[0];
  const y = p[1] - CAM.target[1];
  const z = p[2] - CAM.target[2];
  const x1 = x * cY - y * sY;
  const y1 = x * sY + y * cY;
  return { x: x1, depth: y1 * cP - z * sP, up: z * cP + y1 * sP };
}
function proj(p) {
  const v = viewOf(p);
  const k = CAM.f / (CAM.f + v.depth);
  return [CAM.cx + v.x * k * CAM.scale, CAM.cy - v.up * k * CAM.scale, v.depth, k];
}
// direction of a world vector along the view axis: < 0 faces the camera
const towards = (n) => (n[0] * sY + n[1] * cY) * cP - n[2] * sP;
const LIGHT = norm([-0.45, -0.75, 0.9]);

const pts = (arr) => arr.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
function hull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const crs = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  p.forEach((q) => {
    while (lower.length >= 2 && crs(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  });
  const upper = [];
  for (let i = p.length - 1; i >= 0; i -= 1) {
    const q = p[i];
    while (upper.length >= 2 && crs(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
function basis(axis) {
  const a = norm(axis);
  const ref = Math.abs(a[2]) < 0.9 ? Z : [1, 0, 0];
  const e1 = norm(cross(a, ref));
  return [a, e1, cross(a, e1)];
}
function circle(c, axis, r, n = 36) {
  const [, e1, e2] = basis(axis);
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return add(c, add(mul(e1, Math.cos(t) * r), mul(e2, Math.sin(t) * r)));
  });
}
const shade = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${ch(n >> 16)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
};

// ------------------------------------------------------------------------ primitives
// Each primitive returns {depth, el}; the scene is drawn back to front.
const MATERIALS = {
  white: { stops: ['#9AA3AF', '#E9EDF2', '#FFFFFF', '#D9DEE5', '#8F98A4'] },
  graphite: { stops: ['#0E1013', '#2B3037', '#4A515B', '#23272D', '#0C0E10'] },
  steel: { stops: ['#7E8691', '#D7DCE2', '#F7F9FB', '#BAC1CA', '#737B86'] },
};

function cylinder(key, c, axis, r, half, mat, cap) {
  const a = norm(axis);
  const c0 = add(c, mul(a, -half));
  const c1 = add(c, mul(a, half));
  const ring0 = circle(c0, a, r).map(proj);
  const ring1 = circle(c1, a, r).map(proj);
  const body = hull(ring0.concat(ring1));
  const p0 = proj(c0);
  const p1 = proj(c1);
  let px = -(p1[1] - p0[1]);
  let py = p1[0] - p0[0];
  if (Math.hypot(px, py) < 1e-3) {
    px = 1;
    py = 0;
  }
  const l = Math.hypot(px, py);
  px /= l;
  py /= l;
  const along = body.map((q) => q[0] * px + q[1] * py);
  const lo = Math.min(...along);
  const hi = Math.max(...along);
  const mid = proj(c);
  const base = mid[0] * px + mid[1] * py;
  const g = `g-${key}`;
  const stops = MATERIALS[mat].stops;
  const capFront = towards(a) < 0 ? { ring: ring1, center: c1, n: a } : { ring: ring0, center: c0, n: mul(a, -1) };
  const visibleCap = towards(capFront.n) < -0.02;
  const el = (
    <g key={key}>
      <defs>
        <linearGradient
          id={g}
          gradientUnits="userSpaceOnUse"
          x1={mid[0] + px * (lo - base)}
          y1={mid[1] + py * (lo - base)}
          x2={mid[0] + px * (hi - base)}
          y2={mid[1] + py * (hi - base)}
        >
          {stops.map((s, i) => (
            <stop key={i} offset={[0, 0.28, 0.4, 0.7, 1][i]} stopColor={s} />
          ))}
        </linearGradient>
      </defs>
      <polygon points={pts(body)} fill={`url(#${g})`} />
      {visibleCap && cap && cap(capFront.ring, capFront.center, capFront.n)}
      {visibleCap && !cap && <polygon points={pts(capFront.ring)} fill={stops[3]} />}
    </g>
  );
  return { depth: proj(c)[2], el };
}

// joint cap: machined disc, blue ring, bolt circle, hub
function jointCap(key, r, led) {
  return (ring, center, n) => {
    const disc = circle(center, n, r * 0.74).map(proj);
    const blue = circle(center, n, r * 0.9).map(proj);
    const hub = circle(add(center, mul(n, 0.5)), n, r * 0.26).map(proj);
    const bolts = circle(center, n, r * 0.56, 6).map(proj);
    const ledP = proj(add(center, mul(norm(cross(n, Z)), r * 0.62)));
    return (
      <g key={`${key}-cap`}>
        <polygon points={pts(ring)} fill="#1A1D22" />
        <polygon points={pts(blue)} fill="none" stroke="#2457E6" strokeWidth={1.8 * ring[0][3]} />
        <polygon points={pts(disc)} fill="url(#capMetal)" />
        {bolts.map((b, i) => (
          <circle key={i} cx={b[0]} cy={b[1]} r={1.6 * b[3]} fill="#8B939E" />
        ))}
        <polygon points={pts(hub)} fill="#2A2F36" />
        <circle cx={ledP[0]} cy={ledP[1]} r={1.9} fill="#38BDF8" opacity={led} />
      </g>
    );
  };
}

function box(key, c, ex, ey, half, color, opts = {}) {
  const ez = norm(cross(ex, ey));
  const axes = [norm(ex), norm(ey), ez];
  const corner = (sx, sy, sz) =>
    add(c, add(mul(axes[0], sx * half[0]), add(mul(axes[1], sy * half[1]), mul(axes[2], sz * half[2]))));
  const faces = [];
  [0, 1, 2].forEach((ax) => {
    [-1, 1].forEach((s) => {
      const n = mul(axes[ax], s);
      if (towards(n) >= -0.001) return;
      const quad = [];
      const o1 = (ax + 1) % 3;
      const o2 = (ax + 2) % 3;
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].forEach(([a1, a2]) => {
        const v = [0, 0, 0];
        v[ax] = s;
        v[o1] = a1;
        v[o2] = a2;
        quad.push(proj(corner(v[0], v[1], v[2])));
      });
      const light = 0.62 + 0.42 * Math.max(0, dot(n, LIGHT));
      faces.push({ quad, fill: shade(color, light), top: ax === 2 && s > 0 });
    });
  });
  const el = (
    <g key={key} opacity={opts.opacity == null ? 1 : opts.opacity}>
      {faces.map((f, i) => (
        <polygon key={i} points={pts(f.quad)} fill={f.fill} stroke={shade(color, 0.7)} strokeWidth="0.4" strokeLinejoin="round" />
      ))}
      {opts.inset &&
        faces
          .filter((f) => f.top)
          .map((f, i) => {
            const cx = f.quad.reduce((s, q) => s + q[0], 0) / 4;
            const cy = f.quad.reduce((s, q) => s + q[1], 0) / 4;
            const ins = f.quad.map((q) => [cx + (q[0] - cx) * 0.8, cy + (q[1] - cy) * 0.74]);
            return <polygon key={`in${i}`} points={pts(ins)} fill={shade(color, 0.86)} />;
          })}
    </g>
  );
  return { depth: proj(c)[2] + (opts.bias || 0), el };
}

// ------------------------------------------------------------------------ kinematics
function pose(s) {
  const psi = rad(s.psi);
  const u = [Math.cos(psi), Math.sin(psi), 0];
  const a = [-Math.sin(psi), Math.cos(psi), 0]; // joint axis, horizontal
  const S = [0, 0, H_SHOULDER];
  const wristH = s.h + WRIST_DROP;
  const rho = s.r;
  const dz = wristH - H_SHOULDER;
  const D = Math.max(-1, Math.min(1, (rho * rho + dz * dz - L1 * L1 - L2 * L2) / (2 * L1 * L2)));
  const q2 = Math.acos(D);
  const q1 = Math.atan2(dz, rho) + Math.atan2(L2 * Math.sin(q2), L1 + L2 * Math.cos(q2));
  const E = add(S, add(mul(u, L1 * Math.cos(q1)), mul(Z, L1 * Math.sin(q1))));
  const Wr = add(mul(u, rho), [0, 0, wristH]);
  return { u, a, S, E, Wr, tip: add(Wr, [0, 0, -WRIST_DROP]) };
}

const cyl = (r, psiDeg) => [r * Math.cos(rad(psiDeg)), r * Math.sin(rad(psiDeg)), 0];

export default function HeroArm({ className }) {
  const [t, setT] = useState(7.2);
  useEffect(() => {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return undefined;
    let raf;
    const start = performance.now() - 7200;
    const loop = (now) => {
      setT((now - start) / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const s = stateAt(t);
  const k = pose(s);
  const led = 0.55 + 0.45 * Math.sin(t * 3.2);

  // cube: on the table, held, or in the tray; a fresh one fades in at the end
  const cubeHome = cyl(W.grasp[0], W.grasp[1]);
  const trayC = cyl(TRAY.r, TRAY.psi);
  const held = s.phase >= 4 && s.phase <= 6;
  const inTray = s.phase >= 7;
  const fadeNew = s.phase === 10 ? s.u : 0;
  const cubeYaw = held ? rad(s.psi) : inTray ? rad(TRAY.psi) : rad(W.grasp[1]);
  const cubeAt = held
    ? add(k.tip, [0, 0, CUBE / 2 - 12])
    : inTray
    ? add(trayC, [0, 0, TRAY.h + CUBE / 2])
    : add(cubeHome, [0, 0, CUBE / 2]);
  const cubeEx = [Math.cos(cubeYaw), Math.sin(cubeYaw), 0];
  const cubeEy = [-Math.sin(cubeYaw), Math.cos(cubeYaw), 0];

  const parts = [];
  // base: plate, column, turntable
  parts.push(cylinder('plate', [0, 0, 9], Z, 96, 9, 'graphite'));
  parts.push(cylinder('column', [0, 0, 66], Z, 58, 48, 'white', (ring) => <polygon key="colcap" points={pts(ring)} fill="#EEF1F4" />));
  parts.push(cylinder('band', [0, 0, 116], Z, 59, 3, 'graphite'));
  parts.push(cylinder('turntable', [0, 0, 136], Z, 50, 17, 'graphite', (ring) => <polygon key="ttcap" points={pts(ring)} fill="#2E333A" />));
  // arm
  parts.push(cylinder('upper', add(k.S, mul(add(k.E, mul(k.S, -1)), 0.5)), add(k.E, mul(k.S, -1)), 25, L1 / 2, 'white'));
  parts.push(cylinder('fore', add(k.E, mul(add(k.Wr, mul(k.E, -1)), 0.5)), add(k.Wr, mul(k.E, -1)), 19, L2 / 2, 'white'));
  const joints = [
    ['shoulder', k.S, 36, 34],
    ['elbow', k.E, 29, 28],
    ['wrist', k.Wr, 22, 22],
  ];
  joints.forEach(([name, c, r, half]) => {
    const j = cylinder(name, c, k.a, r, half, 'graphite', jointCap(name, r, led));
    parts.push({ ...j, depth: j.depth - 70 });
  });
  // wrist roll, gripper body, fingers
  parts.push(cylinder('roll', add(k.Wr, [0, 0, -36]), Z, 15, 16, 'graphite', (ring) => <polygon key="rollcap" points={pts(ring)} fill="#2457E6" />));
  parts.push(box('palm', add(k.Wr, [0, 0, -60]), k.a, k.u, [40, 17, 9], '#2B3037', { bias: -10 }));
  [-1, 1].forEach((side) => {
    parts.push(
      box(`finger${side}`, add(k.Wr, add(mul(k.a, side * (s.grip + 4)), [0, 0, -WRIST_DROP + 23])), k.a, k.u, [4, 12, 23], '#C9CFD6', {
        bias: -12,
      })
    );
  });
  // tray and cube
  parts.push(box('tray', add(trayC, [0, 0, TRAY.h / 2]), cyl(1, TRAY.psi), cyl(1, TRAY.psi + 90), [TRAY.w / 2, TRAY.d / 2, TRAY.h / 2], '#C7D2E4', { inset: true, bias: 30 }));
  parts.push(box('cube', cubeAt, cubeEx, cubeEy, [CUBE / 2, CUBE / 2, CUBE / 2], '#E5484D', { opacity: inTray ? 1 - fadeNew : 1, bias: held ? 0 : 6 }));
  if (fadeNew > 0) {
    parts.push(box('cube-new', add(cubeHome, [0, 0, CUBE / 2]), cyl(1, W.grasp[1]), cyl(1, W.grasp[1] + 90), [CUBE / 2, CUBE / 2, CUBE / 2], '#E5484D', { opacity: fadeNew, bias: 6 }));
  }
  parts.sort((p, q) => q.depth - p.depth);

  // floor: grid, stage light, soft shadows (projected straight down)
  const grid = [];
  for (let i = -8; i <= 10; i += 1) {
    const a0 = proj([i * 50, -420, 0]);
    const a1 = proj([i * 50, 480, 0]);
    const b0 = proj([-420, i * 50, 0]);
    const b1 = proj([520, i * 50, 0]);
    grid.push(<line key={`gx${i}`} x1={a0[0]} y1={a0[1]} x2={a1[0]} y2={a1[1]} />);
    grid.push(<line key={`gy${i}`} x1={b0[0]} y1={b0[1]} x2={b1[0]} y2={b1[1]} />);
  }
  const stage = circle([120, 110, 0], Z, 330, 72).map(proj);
  const floorPt = (p) => proj([p[0], p[1], 0]);
  const sh = [k.S, k.E, k.Wr, k.tip].map(floorPt);
  const tipLift = Math.max(0, s.h);
  const cubeShadow = circle([cubeAt[0] + 6, cubeAt[1] - 6, 0], Z, CUBE * 0.62, 20).map(proj);
  const base0 = proj([0, 0, 0]);

  return (
    <svg viewBox={`0 0 ${VIEW.w} ${VIEW.h}`} className={className} role="img" aria-label="Animated robot arm picking up a cube and placing it in a tray">
      <defs>
        <radialGradient id="stageLight" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="0.5" stopColor="#F1F4FB" stopOpacity="0.55" />
          <stop offset="0.95" stopColor="#F1F4FB" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="gridFade" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="1" />
          <stop offset="0.55" stopColor="#FFFFFF" stopOpacity="0.55" />
          <stop offset="0.92" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <mask id="gridMask">
          <polygon points={pts(stage)} fill="url(#gridFade)" />
        </mask>
        <radialGradient id="capMetal" cx="0.35" cy="0.3" r="0.9">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.55" stopColor="#C9CFD7" />
          <stop offset="1" stopColor="#7D8590" />
        </radialGradient>
        <filter id="softShadow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        <filter id="tightShadow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="3.5" />
        </filter>
      </defs>

      <polygon points={pts(stage)} fill="url(#stageLight)" />
      <g mask="url(#gridMask)" stroke="#5B6573" strokeWidth="0.55" opacity="0.32">
        {grid}
      </g>

      {/* shadows */}
      <ellipse cx={base0[0]} cy={base0[1]} rx={112 * base0[3]} ry={40 * base0[3]} fill="#0B0C0E" opacity="0.22" filter="url(#softShadow)" />
      <polyline
        points={pts(sh)}
        fill="none"
        stroke="#0B0C0E"
        strokeWidth="22"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.1}
        filter="url(#softShadow)"
      />
      <polygon points={pts(cubeShadow)} fill="#0B0C0E" opacity={held ? Math.max(0.06, 0.24 - tipLift / 900) : 0.24} filter="url(#tightShadow)" />

      {parts.map((p) => p.el)}
    </svg>
  );
}
