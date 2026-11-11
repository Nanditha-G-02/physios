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

// Top-down workspace drawing (millimetres). Table frame: origin at the robot base,
// +x away from the robot (drawn upward), +y to the robot's left (drawn leftward).

import React, { useCallback, useMemo, useRef, useState } from 'react';

const INK = '#121414';
const SKY = '#A8D3E3';
const SKY_INK = '#1C5A72';
const WARN = '#C76B1C';

export function itemColor(item) {
  return item?.color || (item?.role === 'target' ? '#8A6D3B' : '#D9534F');
}

export default function WorkspaceCanvas({
  workspace,
  regions = [],
  items = [],
  placements = [], // [{item_id, x_mm, y_mm, yaw_deg}] - editable markers
  ghosts = [], // [{placements:[...], id}] - faint markers for other episodes
  bounds = [], // [{item_id, x_min_mm,...}] - randomisation bounds
  highlightRegions = [], // region ids drawn as selected
  onMove, // (item_id, x_mm, y_mm) => void ; enables dragging
  onRegionClick,
  dots = [], // [{x_mm, y_mm, color, title, ring}] - e.g. evaluation outcomes
  onPick, // (x_mm, y_mm) => void ; click on the table
  height = 360,
  className,
  showRegions = true,
  caption,
}) {
  const svgRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [hover, setHover] = useState(null);
  const ws = workspace;

  const geom = useMemo(() => {
    if (!ws) return null;
    const pad = 46;
    const spanY = ws.y_max_mm - ws.y_min_mm;
    const xMax = Math.max(ws.x_max_mm, ws.reach_max_mm) + 20;
    const xMin = Math.min(-ws.base_keepout_mm - 30, 0);
    const spanX = xMax - xMin;
    const W = 560;
    const scale = (W - 2 * pad) / Math.max(spanY, 1);
    const H = spanX * scale + 2 * pad;
    const toPx = (x, y) => [pad + (ws.y_max_mm - y) * scale, pad + (xMax - x) * scale];
    const toMm = (px, py) => [xMax - (py - pad) / scale, ws.y_max_mm - (px - pad) / scale];
    return { W, H, pad, scale, toPx, toMm, xMax, xMin };
  }, [ws]);

  const itemsById = useMemo(() => Object.fromEntries(items.map((i) => [i.id, i])), [items]);

  const svgPoint = useCallback(
    (evt) => {
      const svg = svgRef.current;
      const pt = svg.createSVGPoint();
      pt.x = evt.clientX;
      pt.y = evt.clientY;
      const p = pt.matrixTransform(svg.getScreenCTM().inverse());
      return geom.toMm(p.x, p.y);
    },
    [geom],
  );

  if (!ws || !geom) return null;
  const { W, H, scale, toPx } = geom;
  const [bx, by] = toPx(0, 0);

  const rectPx = (r) => {
    const [x1, y1] = toPx(r.x_max_mm, r.y_max_mm);
    const [x2, y2] = toPx(r.x_min_mm, r.y_min_mm);
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  };
  const wsRect = rectPx(ws);

  const onPointerMove = (e) => {
    if (!drag || !onMove) return;
    const [x, y] = svgPoint(e);
    onMove(drag, Math.round(x), Math.round(y), false);
  };
  const endDrag = (e) => {
    if (drag && onMove) {
      const [x, y] = svgPoint(e);
      onMove(drag, Math.round(x), Math.round(y), true);
    }
    setDrag(null);
  };

  // grid ticks every 50 mm
  const ticksX = [];
  for (let x = Math.ceil(geom.xMin / 50) * 50; x <= geom.xMax; x += 50) ticksX.push(x);
  const ticksY = [];
  for (let y = Math.ceil(ws.y_min_mm / 50) * 50; y <= ws.y_max_mm; y += 50) ticksY.push(y);

  const marker = (p, opts = {}) => {
    const item = itemsById[p.item_id];
    if (!item) return null;
    const [px, py] = toPx(p.x_mm, p.y_mm);
    const size = Math.max(6, (item.size_mm || 30) * scale);
    const color = itemColor(item);
    const isTarget = item.role === 'target';
    const yaw = -(p.yaw_deg || 0);
    if (opts.ghost) {
      return isTarget ? (
        <rect
          key={`${opts.key}`}
          x={px - size / 2}
          y={py - size / 2}
          width={size}
          height={size}
          fill="none"
          stroke={color}
          strokeOpacity="0.25"
          strokeWidth="1"
        />
      ) : (
        <circle key={opts.key} cx={px} cy={py} r={2.4} fill={color} fillOpacity="0.35" />
      );
    }
    const draggable = !!onMove;
    return (
      <g
        key={p.item_id}
        transform={`translate(${px} ${py}) rotate(${yaw})`}
        style={{ cursor: draggable ? (drag === p.item_id ? 'grabbing' : 'grab') : 'default' }}
        onPointerDown={(e) => {
          if (!draggable) return;
          e.currentTarget.ownerSVGElement.setPointerCapture(e.pointerId);
          setDrag(p.item_id);
        }}
        onPointerEnter={() => setHover(p.item_id)}
        onPointerLeave={() => setHover(null)}
      >
        {isTarget ? (
          <>
            <rect
              x={-size / 2}
              y={-size / 2}
              width={size}
              height={size}
              fill="white"
              fillOpacity="0.7"
              stroke={INK}
              strokeWidth="1.4"
            />
            <rect
              x={-size / 2 + 3}
              y={-size / 2 + 3}
              width={size - 6}
              height={size - 6}
              fill="none"
              stroke={color}
              strokeWidth="1.2"
              strokeDasharray="3 2"
            />
          </>
        ) : (
          <rect x={-size / 2} y={-size / 2} width={size} height={size} fill={color} stroke={INK} strokeWidth="1.4" />
        )}
        <line x1="0" y1="0" x2="0" y2={-size / 2 - 6} stroke={INK} strokeWidth="1" />
        {(hover === p.item_id || drag === p.item_id) && (
          <circle r={size / 2 + 6} fill="none" stroke={SKY_INK} strokeDasharray="2 2" />
        )}
      </g>
    );
  };

  return (
    <figure className={className}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height, touchAction: 'none', cursor: onPick ? 'crosshair' : undefined }}
        onClick={(e) => {
          if (!onPick || drag) return;
          const [x, y] = svgPoint(e);
          onPick(Math.round(x), Math.round(y));
        }}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={() => setDrag(null)}
        role="img"
        aria-label="Top-down workspace map"
      >
        <defs>
          <pattern id="wsHatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="7" stroke={WARN} strokeWidth="1.2" opacity="0.55" />
          </pattern>
          <pattern id="wsHatchInk" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke={INK} strokeWidth="0.8" opacity="0.3" />
          </pattern>
          <clipPath id="wsClip">
            <rect x={wsRect.x} y={wsRect.y} width={wsRect.w} height={wsRect.h} />
          </clipPath>
        </defs>
        <rect x="0" y="0" width={W} height={H} fill="#fff" />
        {/* grid */}
        {ticksX.map((x) => {
          const [, py] = toPx(x, 0);
          return (
            <g key={`gx${x}`}>
              <line x1={geom.pad - 6} x2={W - geom.pad + 6} y1={py} y2={py} stroke={INK} strokeOpacity={x === 0 ? 0.25 : 0.06} />
              <text
                x={geom.pad - 10}
                y={py + 3}
                textAnchor="end"
                fontSize="9"
                fontFamily="Geist Mono, monospace"
                fill={INK}
                fillOpacity="0.55"
              >
                {x}
              </text>
            </g>
          );
        })}
        {ticksY.map((y) => {
          const [px] = toPx(0, y);
          return (
            <g key={`gy${y}`}>
              <line x1={px} x2={px} y1={geom.pad - 6} y2={H - geom.pad + 6} stroke={INK} strokeOpacity={y === 0 ? 0.25 : 0.06} />
              <text
                x={px}
                y={H - geom.pad + 18}
                textAnchor="middle"
                fontSize="9"
                fontFamily="Geist Mono, monospace"
                fill={INK}
                fillOpacity="0.55"
              >
                {y}
              </text>
            </g>
          );
        })}
        {/* unreachable parts of the table: hatched */}
        <g clipPath="url(#wsClip)">
          <rect x={wsRect.x} y={wsRect.y} width={wsRect.w} height={wsRect.h} fill="url(#wsHatch)" />
          <circle cx={bx} cy={by} r={ws.reach_max_mm * scale} fill="#fff" />
          <circle cx={bx} cy={by} r={Math.max(ws.reach_min_mm, ws.base_keepout_mm) * scale} fill="url(#wsHatch)" />
        </g>
        <rect x={wsRect.x} y={wsRect.y} width={wsRect.w} height={wsRect.h} fill="none" stroke={INK} strokeWidth="1.4" />
        <circle cx={bx} cy={by} r={ws.reach_max_mm * scale} fill="none" stroke={INK} strokeDasharray="5 4" strokeOpacity="0.6" />
        <circle cx={bx} cy={by} r={ws.reach_min_mm * scale} fill="none" stroke={INK} strokeDasharray="2 3" strokeOpacity="0.5" />
        {/* keep-outs */}
        {(ws.keepouts || []).map((k, i) => {
          const r = rectPx(k);
          return (
            <rect
              key={`k${i}`}
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              fill="url(#wsHatchInk)"
              stroke={INK}
              strokeDasharray="3 2"
            />
          );
        })}
        {/* regions */}
        {showRegions &&
          regions.map((reg) => {
            const r = rectPx(reg);
            const on = highlightRegions.includes(reg.id);
            return (
              <g
                key={reg.id}
                onClick={() => onRegionClick && onRegionClick(reg.id)}
                style={{ cursor: onRegionClick ? 'pointer' : 'default' }}
              >
                <rect
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                  fill={on ? SKY : 'transparent'}
                  fillOpacity={on ? 0.32 : 0}
                  stroke={on ? SKY_INK : INK}
                  strokeOpacity={on ? 0.9 : 0.35}
                  strokeDasharray={on ? '' : '4 3'}
                />
                <text
                  x={r.x + 6}
                  y={r.y + 14}
                  fontSize="11"
                  fontFamily="Geist Mono, monospace"
                  fill={on ? SKY_INK : INK}
                  fillOpacity={on ? 1 : 0.6}
                >
                  {reg.id} · {reg.name}
                </text>
              </g>
            );
          })}
        {/* randomisation bounds */}
        {bounds.map((b, i) => {
          const r = rectPx(b);
          const item = itemsById[b.item_id];
          return (
            <rect
              key={`b${i}`}
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              fill="none"
              stroke={itemColor(item)}
              strokeWidth="1.2"
              strokeDasharray="6 3"
            />
          );
        })}
        {/* robot base */}
        <circle cx={bx} cy={by} r={ws.base_keepout_mm * scale} fill="#fff" stroke={INK} strokeWidth="1.4" />
        <circle cx={bx} cy={by} r={4} fill={INK} />
        <text
          x={bx}
          y={by + ws.base_keepout_mm * scale + 13}
          textAnchor="middle"
          fontSize="9.5"
          fontFamily="Geist Mono, monospace"
          fill={INK}
        >
          ROBOT BASE
        </text>
        {/* other episodes */}
        {ghosts.map((g) => g.placements.map((p, k) => marker(p, { ghost: true, key: `${g.id}-${k}` })))}
        {/* data dots (e.g. evaluation trials) */}
        {dots.map((d, k) => {
          const [px, py] = toPx(d.x_mm, d.y_mm);
          return (
            <circle
              key={`d${k}`}
              cx={px}
              cy={py}
              r={d.r_mm ? Math.max(4, d.r_mm * scale) : d.r || 6}
              fill={d.color || INK}
              fillOpacity={d.ring ? 0 : 0.85}
              stroke={d.ring ? d.color : '#fff'}
              strokeWidth={d.ring ? 2.5 : 2}
              pointerEvents={onPick ? 'none' : 'auto'}
            >
              {d.title && <title>{d.title}</title>}
            </circle>
          );
        })}
        {/* editable markers */}
        {placements.map((p) => marker(p))}
        {/* axis key */}
        <g fontSize="9" fontFamily="Geist Mono, monospace" fill={INK}>
          <line x1={W - 40} y1={30} x2={W - 40} y2={12} stroke={INK} markerEnd="" />
          <text x={W - 36} y={16}>
            +x
          </text>
          <line x1={W - 40} y1={30} x2={W - 58} y2={30} stroke={INK} />
          <text x={W - 72} y={33}>
            +y
          </text>
          <text x={geom.pad} y={18}>
            mm · top view
          </text>
        </g>
      </svg>
      {(caption || drag || hover) && (
        <figcaption className="mt-1 flex justify-between text-[11.5px] text-ink-3">
          <span>{caption}</span>
          {(drag || hover) &&
            (() => {
              const p = placements.find((q) => q.item_id === (drag || hover));
              return p ? (
                <span className="num">
                  {itemsById[p.item_id]?.name}: x {Math.round(p.x_mm)} · y {Math.round(p.y_mm)} · yaw {p.yaw_deg || 0}°
                </span>
              ) : null;
            })()}
        </figcaption>
      )}
    </figure>
  );
}
