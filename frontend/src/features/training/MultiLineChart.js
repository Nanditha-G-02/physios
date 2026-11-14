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

// Several series on one axis (run comparison). Colours follow a fixed
// categorical order (validated palette) and stay with the run, not its rank.

import React, { useMemo, useRef, useState } from 'react';
import { fmt } from './LineChart';

// black, white and blue theme: brand blue, black, light blue, greys
export const SERIES = ['#2457E6', '#0B0C0E', '#7AA2FF', '#5E636C', '#A9C1FF', '#9B9FA7'];

const W = 640;
const H = 220;
const M = { l: 48, r: 12, t: 12, b: 24 };

function ticks(lo, hi, n) {
  if (!(hi > lo)) return [lo];
  const span = hi - lo;
  const mag = 10 ** Math.floor(Math.log10(span / n));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(+v.toPrecision(12));
  return out;
}

export default function MultiLineChart({ series, log, xLabel = 'step', yLabel = 'loss' }) {
  const ref = useRef(null);
  const [hx, setHx] = useState(null);
  const clean = useMemo(
    () =>
      series.map((s) => ({
        ...s,
        points: (s.points || []).filter((p) => p.y != null && Number.isFinite(p.y) && (!log || p.y > 0)),
      })),
    [series, log],
  );
  const g = useMemo(() => {
    const all = clean.flatMap((s) => s.points);
    if (!all.length) return null;
    const tf = (y) => (log ? Math.log10(y) : y);
    const x0 = Math.min(...all.map((p) => p.x));
    let x1 = Math.max(...all.map((p) => p.x));
    if (x1 === x0) x1 = x0 + 1;
    let y0 = Math.min(...all.map((p) => tf(p.y)));
    let y1 = Math.max(...all.map((p) => tf(p.y)));
    if (y1 === y0) {
      y1 += 1;
      y0 -= 1;
    }
    const sx = (x) => M.l + ((x - x0) / (x1 - x0)) * (W - M.l - M.r);
    const sy = (y) => M.t + (1 - (tf(y) - y0) / (y1 - y0)) * (H - M.t - M.b);
    return {
      sx,
      sy,
      x0,
      x1,
      yt: log ? ticks(y0, y1, 3).map((v) => 10 ** v) : ticks(y0, y1, 4),
      xt: ticks(x0, x1, 5),
    };
  }, [clean, log]);

  if (!g) {
    return (
      <div className="h-[220px] grid place-items-center rounded-2xl bg-paper text-[12.5px] text-ink-3">
        No loss values logged yet.
      </div>
    );
  }
  const near = (pts, x) => pts.reduce((b, p) => (Math.abs(p.x - x) < Math.abs(b.x - x) ? p : b), pts[0]);

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]" aria-label="Legend">
        {clean.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-1.5 min-w-0">
            <span className="h-[3px] w-4 rounded-full shrink-0" style={{ background: s.color }} />
            <span className="truncate max-w-[220px] text-ink-2">{s.label}</span>
          </span>
        ))}
      </div>
      <div className="relative">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto select-none"
          role="img"
          aria-label={`${yLabel} by ${xLabel}`}
          onPointerMove={(e) => {
            const r = ref.current.getBoundingClientRect();
            const px = ((e.clientX - r.left) / r.width) * W;
            setHx(g.x0 + ((px - M.l) / (W - M.l - M.r)) * (g.x1 - g.x0));
          }}
          onPointerLeave={() => setHx(null)}
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
              {fmt(v, 3)}
            </text>
          ))}
          {clean.map(
            (s) =>
              s.points.length > 0 && (
                <path
                  key={s.id}
                  d={s.points.map((p, i) => `${i ? 'L' : 'M'}${g.sx(p.x).toFixed(1)},${g.sy(p.y).toFixed(1)}`).join('')}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeDasharray={s.dashed ? '5 4' : undefined}
                />
              ),
          )}
          {hx != null && (
            <g>
              <line x1={g.sx(hx)} x2={g.sx(hx)} y1={M.t} y2={H - M.b} stroke="#0B0C0E" strokeOpacity="0.25" />
              {clean.map((s) => {
                if (!s.points.length) return null;
                const p = near(s.points, hx);
                return <circle key={s.id} cx={g.sx(p.x)} cy={g.sy(p.y)} r="4" fill={s.color} stroke="#fff" strokeWidth="2" />;
              })}
            </g>
          )}
        </svg>
        {hx != null && (
          <div
            className="pointer-events-none absolute top-1 rounded-xl bg-ink px-2.5 py-1.5 text-[11px] text-white shadow-lift grid gap-0.5"
            style={{ left: `${Math.min(70, (g.sx(hx) / W) * 100)}%` }}
          >
            {clean.map((s) => {
              if (!s.points.length) return null;
              const p = near(s.points, hx);
              return (
                <div key={s.id} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                  <span className="text-white/60 truncate max-w-[140px]">{s.label}</span>
                  <span className="num">
                    {fmt(p.y, 4)} <span className="text-white/50">@{p.x}</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
