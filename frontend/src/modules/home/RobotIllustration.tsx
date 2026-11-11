// Decorative robot arm drawing from the Physical AI Manager home page (same drawing,
// typed for PHYSIOS). The arm idles, or leans toward the pointer when `aim` is given.
import { useEffect, useRef, useState } from 'react';

const INK = '#121414';
const SKY = '#A8D3E3';

export default function RobotIllustration({ animate = true, className, label, aim = null }: { animate?: boolean; className?: string; label?: string; aim?: { x: number; y: number } | null }) {
  // aim: {x, y} in -1..1 (pointer position over the drawing) - the arm leans
  // toward it; without aim it idles. Purely decorative.
  const [t, setT] = useState(0);
  const aimRef = useRef(aim);
  aimRef.current = aim;
  const smooth = useRef({ x: 0, y: 0 });
  useEffect(() => {
    if (!animate) return undefined;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return undefined;
    let raf = 0;
    const start = performance.now();
    const loop = (now: number) => {
      setT((now - start) / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [animate]);

  const target = aimRef.current || { x: 0, y: 0 };
  smooth.current.x += (target.x - smooth.current.x) * 0.06;
  smooth.current.y += (target.y - smooth.current.y) * 0.06;
  const ax = smooth.current.x;
  const ay = smooth.current.y;
  const idle = aimRef.current ? 0.35 : 1;
  const shoulder = -38 + ax * 26 + Math.sin(t * 0.6) * 8 * idle;
  const elbow = 72 - ay * 28 + Math.sin(t * 0.6 + 1.1) * 10 * idle;
  const wrist = -22 + ay * 14 + Math.sin(t * 0.9 + 0.4) * 9 * idle;
  const grip = 6 + (Math.sin(t * 0.9) + 1) * 4;

  const stroke = { fill: 'none', stroke: INK, strokeWidth: 1.6, strokeLinejoin: 'round' as const };
  const thin = { fill: 'none', stroke: INK, strokeWidth: 0.8 };

  return (
    <svg viewBox="0 0 420 300" className={className} role="img" aria-label={label || 'Robot arm drawing'}>
      <defs>
        <pattern id="hatchHome" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke={INK} strokeWidth="0.6" opacity="0.35" />
        </pattern>
      </defs>
      {/* table line + dimension */}
      <line x1="30" y1="262" x2="390" y2="262" {...thin} />
      <line x1="60" y1="276" x2="200" y2="276" {...thin} />
      <line x1="60" y1="271" x2="60" y2="281" {...thin} />
      <line x1="200" y1="271" x2="200" y2="281" {...thin} />
      <text x="130" y="290" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="8.5" fill={INK}>
        BASE Ø
      </text>
      {/* base */}
      <path d="M70 262 L80 238 L190 238 L200 262 Z" {...stroke} fill="url(#hatchHome)" />
      <rect x="105" y="214" width="60" height="24" {...stroke} fill="#fff" />
      <circle cx="135" cy="214" r="5" {...stroke} fill={SKY} />
      {/* shoulder -> upper arm -> forearm -> wrist -> gripper, nested rotations */}
      <g transform={`translate(135 206) rotate(${shoulder})`}>
        <rect x="-11" y="-11" width="22" height="22" {...stroke} fill="#fff" />
        <rect x="-7" y="-104" width="14" height="96" rx="2" {...stroke} fill="#fff" />
        <line x1="0" y1="-12" x2="0" y2="-100" {...thin} strokeDasharray="3 3" />
        <g transform={`translate(0 -108) rotate(${elbow})`}>
          <circle r="10" {...stroke} fill={SKY} />
          <rect x="-6" y="-92" width="12" height="84" rx="2" {...stroke} fill="#fff" />
          <line x1="0" y1="-10" x2="0" y2="-88" {...thin} strokeDasharray="3 3" />
          <g transform={`translate(0 -96) rotate(${wrist})`}>
            <circle r="7" {...stroke} fill="#fff" />
            <rect x="-9" y="-30" width="18" height="24" {...stroke} fill="#fff" />
            <g transform={`translate(0 -30)`}>
              <path d={`M${-grip - 3} 0 L${-grip - 3} -22 L${-grip + 1} -22 L${-grip + 1} 0`} {...stroke} fill="#fff" />
              <path d={`M${grip - 1} 0 L${grip - 1} -22 L${grip + 3} -22 L${grip + 3} 0`} {...stroke} fill="#fff" />
            </g>
          </g>
        </g>
      </g>
      {/* callouts */}
      <g fontFamily="Geist Mono, monospace" fontSize="9" fill={INK}>
        <line x1="150" y1="214" x2="232" y2="214" {...thin} />
        <text x="236" y="217">J1 · PAN</text>
        <line x1="146" y1="200" x2="232" y2="196" {...thin} />
        <text x="236" y="199">J2 · SHOULDER</text>
      </g>
      {/* object + target on the table */}
      <rect x="292" y="244" width="18" height="18" {...stroke} fill="#D9534F" opacity="0.9" />
      <path d="M330 262 L336 246 L382 246 L388 262 Z" {...stroke} fill="none" />
      <text x="301" y="238" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="8" fill={INK}>
        OBJ
      </text>
      <text x="359" y="240" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="8" fill={INK}>
        TARGET
      </text>
    </svg>
  );
}
