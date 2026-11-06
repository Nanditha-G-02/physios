// Top-down workspace view (robot base at the origin, x forward, y to the left, millimetres).
// Shows reach, regions, keep-outs and item placements; placements can be dragged when
// `onMove` is given (the planning engine re-validates every edit).
import { useRef, useState } from 'react';

type Placement = { item_id: string; role?: string; x_mm: number; y_mm: number; yaw_deg?: number; region?: string | null };
type Item = { id: string; name: string; role: string; size_mm?: number; color?: string };

export function WorkspaceView({ task, placements, ghosts, onMove, height = 360 }: {
  task: any; placements?: Placement[]; ghosts?: Placement[]; onMove?: (itemId: string, x: number, y: number) => void; height?: number;
}) {
  const ws = task?.workspace || { x_min_mm: 0, x_max_mm: 300, y_min_mm: -200, y_max_mm: 200 };
  const items: Item[] = task?.items || [];
  const regions: any[] = task?.regions || [];
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const reach = ws.reach_max_mm || Math.max(ws.x_max_mm, 300);
  const pad = 30;
  // view box in mm: horizontal = -y (left of the robot drawn on the left), vertical = -x
  const yMax = Math.max(ws.y_max_mm, reach) + pad; const yMin = Math.min(ws.y_min_mm, -reach) - pad;
  const xMax = Math.max(ws.x_max_mm, reach) + pad; const xMin = Math.min(0, ws.x_min_mm) - (ws.base_keepout_mm || 60) - pad;
  const vb = { x: -yMax, y: -xMax, w: yMax - yMin, h: xMax - xMin };
  const P = (x: number, y: number) => ({ cx: -y, cy: -x });
  const itemOf = (id: string) => items.find((i) => i.id === id);

  const toMm = (e: React.PointerEvent) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const m = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: Math.round(-m.y), y: Math.round(-m.x) };
  };

  const shown = (placements || []).map((p) => (drag && drag.id === p.item_id ? { ...p, x_mm: drag.x, y_mm: drag.y } : p));
  return (
    <svg ref={svgRef} className="workspace-svg" viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} style={{ maxHeight: height, touchAction: 'none' }}
      onPointerMove={(e) => drag && setDrag({ id: drag.id, ...toMm(e) })}
      onPointerUp={() => { if (drag && onMove) onMove(drag.id, drag.x, drag.y); setDrag(null); }}
      onPointerLeave={() => setDrag(null)} role="img" aria-label="Workspace top view" data-testid="workspace">
      <defs>
        <pattern id="wsgrid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" stroke="var(--line)" strokeWidth="1" /></pattern>
      </defs>
      <rect x={vb.x} y={vb.y} width={vb.w} height={vb.h} fill="url(#wsgrid)" />
      {/* reach annulus */}
      <circle cx={0} cy={0} r={reach} fill="var(--accent-soft)" stroke="var(--accent)" strokeOpacity={0.4} strokeDasharray="6 6" />
      {ws.reach_min_mm ? <circle cx={0} cy={0} r={ws.reach_min_mm} fill="var(--surface-2)" stroke="var(--line-strong)" strokeDasharray="4 4" /> : null}
      {/* workspace bounds */}
      <rect x={-ws.y_max_mm} y={-ws.x_max_mm} width={ws.y_max_mm - ws.y_min_mm} height={ws.x_max_mm - ws.x_min_mm} fill="none" stroke="var(--text-2)" strokeWidth={2} />
      {regions.map((r) => (
        <g key={r.id}>
          <rect x={-r.y_max_mm} y={-r.x_max_mm} width={r.y_max_mm - r.y_min_mm} height={r.x_max_mm - r.x_min_mm} fill="var(--accent-2-soft)" stroke="var(--accent-2)" strokeOpacity={0.5} />
          <text x={-(r.y_max_mm + r.y_min_mm) / 2} y={-r.x_max_mm + 18} textAnchor="middle" fontSize={14} fill="var(--accent-2)">{r.name || r.id}</text>
        </g>
      ))}
      {(ws.keepouts || []).map((k: any, i: number) => (
        <rect key={i} x={-k.y_max_mm} y={-k.x_max_mm} width={k.y_max_mm - k.y_min_mm} height={k.x_max_mm - k.x_min_mm} fill="var(--danger-soft)" stroke="var(--danger)" />
      ))}
      {/* robot base */}
      <circle cx={0} cy={0} r={ws.base_keepout_mm || 60} fill="var(--surface-3)" stroke="var(--line-strong)" strokeWidth={2} />
      <path d="M0 -40 L0 -90" stroke="var(--text-2)" strokeWidth={4} strokeLinecap="round" />
      <text x={0} y={(ws.base_keepout_mm || 60) + 18} textAnchor="middle" fontSize={13} fill="var(--muted)">robot base · x forward</text>
      {(ghosts || []).map((p, i) => {
        const it = itemOf(p.item_id); const c = P(p.x_mm, p.y_mm);
        return <circle key={'g' + i} {...c} r={Math.max(5, (it?.size_mm || 30) / 4)} fill={it?.color || 'var(--muted)'} opacity={0.22} />;
      })}
      {shown.map((p) => {
        const it = itemOf(p.item_id); const c = P(p.x_mm, p.y_mm); const s = it?.size_mm || 30;
        const target = (p.role || it?.role) === 'target';
        return (
          <g key={p.item_id} transform={`translate(${c.cx} ${c.cy}) rotate(${-(p.yaw_deg || 0)})`} style={{ cursor: onMove ? 'grab' : 'default' }}
            onPointerDown={(e) => { if (!onMove) return; (e.target as Element).setPointerCapture?.(e.pointerId); setDrag({ id: p.item_id, ...toMm(e) }); }} data-placement={p.item_id}>
            {target
              ? <rect x={-s / 2} y={-s / 2} width={s} height={s} rx={6} fill={it?.color || '#8A6D3B'} fillOpacity={0.35} stroke={it?.color || '#8A6D3B'} strokeWidth={3} />
              : <rect x={-s / 2} y={-s / 2} width={s} height={s} rx={3} fill={it?.color || '#D9534F'} stroke="#000" strokeOpacity={0.3} />}
            <text y={-s / 2 - 6} textAnchor="middle" fontSize={13} fill="var(--text)" transform={`rotate(${p.yaw_deg || 0})`}>{it?.name || p.item_id}</text>
          </g>
        );
      })}
      {drag && <text x={vb.x + 10} y={vb.y + 20} fontSize={14} fill="var(--text)">x {drag.x} mm · y {drag.y} mm</text>}
    </svg>
  );
}
