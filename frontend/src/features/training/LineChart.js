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

// One-series line chart with a crosshair tooltip. Values come straight from the
// training process (parsed log) or the resource sampler - nothing is smoothed
// unless `smooth` is set, and then the raw line is still drawn underneath.

import React, { useMemo, useRef, useState } from 'react';

const W = 520;
const H = 170;
const M = { l: 46, r: 12, t: 12, b: 24 };

function niceTicks(lo, hi, n = 4) {
  if (!(hi > lo)) return [lo];
  const span = hi - lo;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(+v.toPrecision(12));
  return out;
}

export function fmt(v, digits = 3) {
  if (v == null || Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(1);
  return Number(v.toPrecision(digits)).toString();
}

export default function LineChart({
  points,
  xLabel = 'step',
  yLabel,
  color = '#2457E6',
  log,
  yMin,
  yMax,
  smooth,
  unit = '',
  empty,
  xFormat,
}) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const data = useMemo(
    () => (points || []).filter((p) => p.y != null && Number.isFinite(p.y) && (!log || p.y > 0)),
    [points, log],
  );

  const g = useMemo(() => {
    if (!data.length) return null;
    const xs = data.map((p) => p.x);
    const ys = data.map((p) => (log ? Math.log10(p.y) : p.y));
    let x0 = Math.min(...xs);
    let x1 = Math.max(...xs);
    if (x1 === x0) x1 = x0 + 1;
    let y0 = yMin != null ? (log ? Math.log10(yMin) : yMin) : Math.min(...ys);
    let y1 = yMax != null ? (log ? Math.log10(yMax) : yMax) : Math.max(...ys);
    if (y1 === y0) {
      y1 += Math.abs(y1) * 0.1 || 1;
      y0 -= Math.abs(y0) * 0.1 || 0;
    }
    const sx = (x) => M.l + ((x - x0) / (x1 - x0)) * (W - M.l - M.r);
    const sy = (y) => M.t + (1 - ((log ? Math.log10(y) : y) - y0) / (y1 - y0)) * (H - M.t - M.b);
    const path = (arr) => arr.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
    let sm = null;
    if (smooth && data.length > 8) {
      const a = 0.85;
      // exponential moving average with bias correction (as TensorBoard does),
      // so the first values are not pulled towards the very first point
      let acc = 0;
      sm = data.map((p, i) => {
        acc = a * acc + (1 - a) * p.y;
        return { x: p.x, y: acc / (1 - a ** (i + 1)) };
      });
    }
    const yt = log ? niceTicks(y0, y1, 3).map((v) => 10 ** v) : niceTicks(y0, y1, 4);
    return {
      sx,
      sy,
      x0,
      x1,
      raw: path(data),
      sm: sm && path(sm),
      yt,
      xt: niceTicks(x0, x1, 4),
    };
  }, [data, log, smooth, yMin, yMax]);

  if (!g) {
    return (
      <div className="h-[170px] grid place-items-center rounded-2xl bg-paper text-[12.5px] text-ink-3">
        {empty || 'Waiting for the first values from the training log…'}
      </div>
    );
  }

  const onMove = (e) => {
    const r = ref.current.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = data[0];
    data.forEach((p) => {
      if (Math.abs(g.sx(p.x) - px) < Math.abs(g.sx(best.x) - px)) best = p;
    });
    setHover(best);
  };

  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto select-none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`${yLabel || 'value'} by ${xLabel}`}
      >
        {g.yt.map((v) => (
          <g key={`y${v}`}>
            <line x1={M.l} x2={W - M.r} y1={g.sy(v)} y2={g.sy(v)} stroke="#E7E9ED" />
            <text x={M.l - 6} y={g.sy(v) + 3} textAnchor="end" fontSize="9.5" fill="#7E848D" fontFamily="Geist Mono, monospace">
              {fmt(v, 2)}
            </text>
          </g>
        ))}
        {g.xt.map((v) => (
          <text
            key={`x${v}`}
            x={g.sx(v)}
            y={H - 6}
            textAnchor="middle"
            fontSize="9.5"
            fill="#7E848D"
            fontFamily="Geist Mono, monospace"
          >
            {xFormat ? xFormat(v) : fmt(v, 3)}
          </text>
        ))}
        <path
          d={g.raw}
          fill="none"
          stroke={color}
          strokeOpacity={g.sm ? 0.28 : 1}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {g.sm && <path d={g.sm} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />}
        {hover && (
          <g>
            <line x1={g.sx(hover.x)} x2={g.sx(hover.x)} y1={M.t} y2={H - M.b} stroke="#0B0C0E" strokeOpacity="0.25" />
            <circle cx={g.sx(hover.x)} cy={g.sy(hover.y)} r="4" fill={color} stroke="#fff" strokeWidth="2" />
          </g>
        )}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute top-1 rounded-xl bg-ink px-2.5 py-1 text-[11px] text-white shadow-lift"
          style={{ left: `${Math.min(78, (g.sx(hover.x) / W) * 100)}%` }}
        >
          <span className="text-white/60">{xLabel} </span>
          <span className="num">{xFormat ? xFormat(hover.x) : hover.x}</span>
          <span className="text-white/60"> · {yLabel} </span>
          <span className="num">
            {fmt(hover.y, 4)}
            {unit}
          </span>
        </div>
      )}
    </div>
  );
}
