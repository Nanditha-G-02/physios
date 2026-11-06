// Interactive SVG charts (no chart library): multi-series line chart with hover read-out,
// bar chart and sparkline. Sizes follow the container width.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';

export type Series = { name: string; points: [number, number][]; color?: string; dashed?: boolean };
const PALETTE = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(160, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceTicks(lo: number, hi: number, n = 5) {
  if (!isFinite(lo) || !isFinite(hi)) return [];
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(10));
  return out;
}
const short = (v: number) => {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(0) + 'k';
  if (a < 1e-2 || a >= 1e4) return v.toExponential(0);
  return +v.toPrecision(3) + '';
};

export function LineChart({ series, height = 220, log, xLabel, yLabel, markers, yFormat }: {
  series: Series[]; height?: number; log?: boolean; xLabel?: string; yLabel?: string;
  markers?: { x: number; label: string; color?: string }[]; yFormat?: (v: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 52, r: 14, t: 10, b: xLabel ? 34 : 24 };
  const tf = (v: number) => (log ? Math.log10(Math.max(v, 1e-12)) : v);
  const all = useMemo(() => series.flatMap((s) => s.points.filter((p) => isFinite(p[0]) && isFinite(p[1]) && (!log || p[1] > 0))), [series, log]);
  if (!all.length) return <div ref={ref} className="state" style={{ height }}><p>No data points yet.</p></div>;
  const xs = all.map((p) => p[0]); const ys = all.map((p) => tf(p[1]));
  let x0 = Math.min(...xs); let x1 = Math.max(...xs); if (x0 === x1) { x0 -= 1; x1 += 1; }
  let y0 = Math.min(...ys); let y1 = Math.max(...ys);
  const yp = (y1 - y0 || Math.abs(y1) || 1) * 0.08; y0 -= yp; y1 += yp;
  const W = width; const H = height;
  const sx = (x: number) => pad.l + ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const sy = (y: number) => pad.t + (1 - (tf(y) - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const yt = log ? niceTicks(y0, y1, 4).map((t) => Math.pow(10, t)) : niceTicks(y0, y1, 4);
  const xt = niceTicks(x0, x1, Math.max(2, Math.floor(W / 110)));
  const hx = hover != null ? x0 + ((hover - pad.l) / (W - pad.l - pad.r)) * (x1 - x0) : null;
  const near = hx == null ? [] : series.map((s, i) => {
    let best: [number, number] | null = null;
    for (const p of s.points) if (!best || Math.abs(p[0] - hx) < Math.abs(best[0] - hx)) best = p;
    return { s, i, p: best };
  }).filter((n) => n.p);
  const fy = yFormat || short;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <svg className="chart" width={W} height={H} onMouseMove={(e) => setHover(e.clientX - e.currentTarget.getBoundingClientRect().left)} onMouseLeave={() => setHover(null)} role="img" aria-label={yLabel || 'chart'}>
        {yt.map((t) => <g key={'y' + t}><line className="grid-line" x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} /><text x={pad.l - 6} y={sy(t) + 3} textAnchor="end">{fy(t)}</text></g>)}
        {xt.map((t) => <text key={'x' + t} x={sx(t)} y={H - pad.b + 14} textAnchor="middle">{short(t)}</text>)}
        {xLabel && <text x={(W + pad.l) / 2} y={H - 4} textAnchor="middle">{xLabel}</text>}
        {yLabel && <text x={10} y={pad.t + 8}>{yLabel}</text>}
        {(markers || []).map((m, i) => m.x >= x0 && m.x <= x1 && (
          <g key={'m' + i}><line x1={sx(m.x)} x2={sx(m.x)} y1={pad.t} y2={H - pad.b} stroke={m.color || 'var(--warn)'} strokeDasharray="3 3" /><text x={sx(m.x) + 4} y={pad.t + 10} style={{ fill: m.color || 'var(--warn)' }}>{m.label}</text></g>
        ))}
        {series.map((s, i) => {
          const pts = s.points.filter((p) => isFinite(p[1]) && (!log || p[1] > 0));
          if (!pts.length) return null;
          const d = pts.map((p, j) => `${j ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('');
          return <path key={s.name} d={d} fill="none" stroke={s.color || PALETTE[i % PALETTE.length]} strokeWidth={1.7} strokeDasharray={s.dashed ? '5 4' : undefined} />;
        })}
        {hover != null && hover > pad.l && hover < W - pad.r && <line x1={hover} x2={hover} y1={pad.t} y2={H - pad.b} stroke="var(--line-strong)" />}
        {near.map((n) => <circle key={n.s.name} cx={sx(n.p![0])} cy={sy(n.p![1])} r={3.5} fill={n.s.color || PALETTE[n.i % PALETTE.length]} />)}
      </svg>
      {hover != null && near.length > 0 && hover > pad.l && (
        <div className="chart-tip" style={{ left: Math.min(hover + 12, W - 170), top: 8 }}>
          <div className="muted">x = {short(near[0].p![0])}</div>
          {near.map((n) => <div key={n.s.name}><span style={{ color: n.s.color || PALETTE[n.i % PALETTE.length] }}>●</span> {n.s.name}: <b className="num">{fy(n.p![1])}</b></div>)}
        </div>
      )}
      {series.length > 1 && (
        <div className="chart-legend" style={{ marginTop: 6 }}>
          {series.map((s, i) => <span key={s.name}><i style={{ background: s.color || PALETTE[i % PALETTE.length] }} />{s.name}</span>)}
        </div>
      )}
    </div>
  );
}

export function BarChart({ data, height = 180, format }: { data: { label: string; value: number; color?: string }[]; height?: number; format?: (v: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  if (!data.length) return <div ref={ref} className="state" style={{ height }}><p>No data.</p></div>;
  const max = Math.max(...data.map((d) => d.value), 1e-9);
  const padB = 38; const bw = Math.min(54, (width - 20) / data.length - 10);
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={height}>
        {data.map((d, i) => {
          const x = 10 + i * ((width - 20) / data.length) + ((width - 20) / data.length - bw) / 2;
          const h = (d.value / max) * (height - padB - 16);
          return (
            <g key={d.label}>
              <rect x={x} y={height - padB - h} width={bw} height={h} rx={3} fill={d.color || PALETTE[i % PALETTE.length]} opacity={0.85}><title>{d.label}: {format ? format(d.value) : d.value}</title></rect>
              <text x={x + bw / 2} y={height - padB - h - 4} textAnchor="middle">{format ? format(d.value) : short(d.value)}</text>
              <text x={x + bw / 2} y={height - padB + 14} textAnchor="middle">{d.label.length > 12 ? d.label.slice(0, 11) + '…' : d.label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function Sparkline({ values, width = 120, height = 32, color = 'var(--accent)' }: { values: number[]; width?: number; height?: number; color?: string }) {
  const v = values.filter((x) => isFinite(x));
  if (v.length < 2) return <svg width={width} height={height} />;
  const lo = Math.min(...v); const hi = Math.max(...v); const span = hi - lo || 1;
  const d = v.map((y, i) => `${i ? 'L' : 'M'}${((i / (v.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((y - lo) / span) * (height - 4)).toFixed(1)}`).join('');
  return <svg width={width} height={height} className="chart"><path d={d} fill="none" stroke={color} strokeWidth={1.5} /></svg>;
}
