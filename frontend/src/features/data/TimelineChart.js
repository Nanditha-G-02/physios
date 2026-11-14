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

// Small-multiple timelines of observation.state (solid ink) and action
// (dashed blue) per joint, with a playhead synced to the episode video.

import React, { useMemo } from 'react';

const W = 640;
const ROW = 46;
const LEFT = 118;
const RIGHT = 8;

export default function TimelineChart({ data, time = 0, onSeek, markers = [] }) {
  const { timestamp = [], state = [], action = [], state_names: names = [] } = data || {};
  const joints = Math.max(state[0]?.length || 0, action[0]?.length || 0);
  const t0 = timestamp[0] || 0;
  const t1 = timestamp[timestamp.length - 1] || 1;
  const H = joints * ROW + 26;

  const series = useMemo(() => {
    const out = [];
    for (let j = 0; j < joints; j += 1) {
      const vals = [];
      state.forEach((r) => r[j] != null && vals.push(r[j]));
      action.forEach((r) => r[j] != null && vals.push(r[j]));
      let lo = Math.min(...vals);
      let hi = Math.max(...vals);
      if (!Number.isFinite(lo)) {
        lo = 0;
        hi = 1;
      }
      if (hi - lo < 1e-6) {
        hi += 0.5;
        lo -= 0.5;
      }
      const x = (t) => LEFT + ((t - t0) / (t1 - t0 || 1)) * (W - LEFT - RIGHT);
      const y = (v) => 6 + j * ROW + (1 - (v - lo) / (hi - lo)) * (ROW - 14);
      const path = (rows) =>
        rows
          .map((r, i) => (r[j] == null ? null : `${i === 0 ? 'M' : 'L'}${x(timestamp[i]).toFixed(1)},${y(r[j]).toFixed(1)}`))
          .filter(Boolean)
          .join(' ');
      out.push({ s: path(state), a: path(action), lo, hi });
    }
    return out;
  }, [state, action, timestamp, joints, t0, t1]);

  if (!joints || !timestamp.length) {
    return <div className="text-[12.5px] text-ink-3 p-4">No state/action data in this episode.</div>;
  }
  const px = LEFT + ((time - t0) / (t1 - t0 || 1)) * (W - LEFT - RIGHT);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-auto select-none"
      role="img"
      aria-label="State and action timelines"
      onClick={(e) => {
        if (!onSeek) return;
        const r = e.currentTarget.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * W;
        const t = t0 + ((x - LEFT) / (W - LEFT - RIGHT)) * (t1 - t0);
        onSeek(Math.max(t0, Math.min(t1, t)) - t0);
      }}
      style={{ cursor: onSeek ? 'pointer' : 'default' }}
    >
      {series.map((s, j) => (
        <g key={j}>
          <rect x={LEFT} y={4 + j * ROW} width={W - LEFT - RIGHT} height={ROW - 10} fill="#fff" stroke="#CDD0CB" />
          <text x={6} y={18 + j * ROW} fontSize="10.5" fontFamily="Geist Sans, sans-serif" fill="#121414">
            {names[j] || `joint ${j + 1}`}
          </text>
          <text x={6} y={31 + j * ROW} fontSize="9" fontFamily="Geist Mono, monospace" fill="#6A7171">
            {s.lo.toFixed(1)} … {s.hi.toFixed(1)}
          </text>
          <path d={s.a} fill="none" stroke="#7AA2FF" strokeWidth="1.1" strokeDasharray="3 2" />
          <path d={s.s} fill="none" stroke="#121414" strokeWidth="1.2" />
        </g>
      ))}
      {markers.map((m, i) => {
        const mx = LEFT + ((m.t + t0 - t0) / (t1 - t0 || 1)) * (W - LEFT - RIGHT);
        return (
          <g key={`${m.phase}-${i}`}>
            <line x1={mx} x2={mx} y1={2} y2={joints * ROW} stroke="#2457E6" strokeOpacity="0.55" strokeDasharray="2 3" />
            <circle cx={mx} cy={6} r={6.5} fill="#2457E6" />
            <text x={mx} y={9} textAnchor="middle" fontSize="8.5" fontFamily="Geist Mono, monospace" fill="#fff">
              {m.n}
            </text>
            <title>{`${m.label} · ${m.t.toFixed(2)} s`}</title>
          </g>
        );
      })}
      <line x1={px} x2={px} y1={2} y2={joints * ROW} stroke="#0B0C0E" strokeWidth="1.5" />
      <g fontSize="9.5" fontFamily="Geist Mono, monospace" fill="#3A4040">
        <text x={LEFT} y={H - 6}>
          0 s
        </text>
        <text x={W - RIGHT} y={H - 6} textAnchor="end">
          {(t1 - t0).toFixed(1)} s
        </text>
        <line x1={LEFT + 120} x2={LEFT + 140} y1={H - 9} y2={H - 9} stroke="#121414" strokeWidth="1.2" />
        <text x={LEFT + 144} y={H - 6}>
          state
        </text>
        <line x1={LEFT + 190} x2={LEFT + 210} y1={H - 9} y2={H - 9} stroke="#7AA2FF" strokeDasharray="3 2" />
        <text x={LEFT + 214} y={H - 6}>
          action
        </text>
      </g>
    </svg>
  );
}
