// Pieces shared by several modules: page frame, service gates, camera view, live joints.
import { useEffect, useState } from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { files, ros } from '@/api/gateway';
import { useAvailability, useSystem } from '@/app/system';
import { Link } from '@/app/router';
import { I } from '@/design/icons';
import { Button, Callout, Empty, Loading } from '@/design/ui';
import { useNow, useTopic } from '@/hooks/data';

/** Page frame in the Physical AI Manager style: "05 · Training" label, a light fading
 *  title, a short grey intro, and status chips / segmented tabs on the right. */
export function Page({ code, label, title, intro, actions, tabs, children, orb = true }: {
  code?: string; label?: string; title?: ReactNode; intro?: ReactNode; actions?: ReactNode; tabs?: ReactNode; children: ReactNode; orb?: boolean;
}) {
  return (
    <div className="page">
      {(title || intro || actions || tabs) && (
        <div className="hero-head">
          {orb && <div className="orb" style={{ top: -40, right: 96, width: 160, height: 160 }} aria-hidden />}
          <div style={{ position: 'relative', minWidth: 0 }}>
            {(code || label) && <div className="label">{[code, label].filter(Boolean).join(' · ')}</div>}
            {title && <h1 className="fade-text">{title}</h1>}
            {intro && <p className="page-intro">{intro}</p>}
          </div>
          {(actions || tabs) && <div className="hero-right">{actions}{tabs}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

/** Page-level segmented tabs that navigate between routes. */
export function RouteTabs({ items }: { items: { to: string; label: ReactNode; active: boolean }[] }) {
  return (
    <div className="seg" role="tablist" data-testid="page-tabs">
      {items.map((t) => <Link key={t.to} to={t.to} role="tab" aria-selected={t.active} className="tab" style={{ textDecoration: 'none' }}>{t.label}</Link>)}
    </div>
  );
}

/** Renders children only when the backend a module depends on is reachable; otherwise a
 *  disconnected state with the backend's own hint. */
export function Requires({ service, children, what }: { service: 'trainer' | 'ros'; children: ReactNode; what: string }) {
  const av = useAvailability();
  const { refreshHealth } = useSystem();
  if (!av.known) return <Loading label="Checking services…" />;
  const ok = service === 'trainer' ? av.trainer : av.ros;
  if (ok) return <>{children}</>;
  const hint = service === 'trainer' ? av.hint('trainer') : av.rosbridge ? av.hint('ros_node') : av.hint('rosbridge');
  return (
    <div className="panel" data-disconnected={service}>
      <Empty icon={<I.link />} title={service === 'trainer' ? 'Training service disconnected' : 'Robot side (ROS 2) disconnected'}
        action={<Button size="sm" icon={<I.refresh />} onClick={refreshHealth}>Check again</Button>}>
        {what} needs {service === 'trainer' ? 'the host training service (pam_trainer)' : 'physical_ai_server through rosbridge'}. {hint}
      </Empty>
    </div>
  );
}

export function RosNotice() {
  const av = useAvailability();
  if (!av.known || av.ros) return null;
  return <Callout tone="warn" title="Robot side not connected">{av.rosbridge ? av.hint('ros_node') : av.hint('rosbridge')}</Callout>;
}

/** Live MJPEG camera through the gateway with loading / error / retry states. */
export function CameraView({ topic, label, recording, quality = 60 }: { topic: string; label?: string; recording?: boolean; quality?: number }) {
  const [state, setState] = useState<'loading' | 'live' | 'error'>('loading');
  const [nonce, setNonce] = useState(0);
  useEffect(() => setState('loading'), [topic, nonce]);
  useEffect(() => {
    if (state !== 'error') return;
    const id = setTimeout(() => setNonce((n) => n + 1), 4000);
    return () => clearTimeout(id);
  }, [state]);
  return (
    <div className="camera" data-camera={topic} data-state={state}>
      <img key={nonce} src={`${files.cameraStream(topic, quality)}&n=${nonce}`} alt={label || topic}
        onLoad={() => setState('live')} onError={() => setState('error')} style={{ opacity: state === 'live' ? 1 : 0 }} />
      {state !== 'live' && <div className="camera-state">{state === 'loading' ? <div className="spinner" /> : <span>No image from {topic}<br /><span style={{ opacity: 0.7 }}>retrying…</span></span>}</div>}
      <div className="camera-label">{label || topic}</div>
      {recording && <div className="rec-dot">REC</div>}
    </div>
  );
}

/** Joint positions from a sensor_msgs/JointState topic, with staleness. */
export function LiveJoints({ topic, limits, title }: { topic: string; limits?: Record<string, [number, number]>; title?: string }) {
  const { msg, at } = useTopic<any>(topic, 'sensor_msgs/msg/JointState', 100);
  const now = useNow(500);
  const stale = !at || now - at > 1500;
  if (!msg) return <div className="small muted" data-live-joints={topic}>{title ? `${title}: ` : ''}waiting for {topic}…</div>;
  const names: string[] = msg.name || [];
  const pos: number[] = msg.position || [];
  return (
    <div className="stack-sm" data-live-joints={topic} data-stale={stale}>
      <div className="row-between small"><span className="text-2">{title || topic}</span><span className={stale ? 'muted' : ''} style={{ color: stale ? undefined : 'var(--ok)' }}>{stale ? 'stale' : '● live'}</span></div>
      {names.map((n, i) => {
        const [lo, hi] = limits?.[n] || [-Math.PI, Math.PI];
        const v = pos[i];
        const pct = Math.max(0, Math.min(100, ((v - lo) / (hi - lo || 1)) * 100));
        return (
          <div className="joint-bar" key={n}>
            <span className="ellipsis mono">{n}</span>
            <div className="joint-track"><span style={{ left: `${pct}%` }} /></div>
            <span className="num right mono">{v?.toFixed(3)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Console frame of the Physical AI Manager record / inference pages: robot type and
 *  connection at the top left (under optional tabs), the live work area in the middle, a
 *  white side sheet on the right and the control bar across the bottom. */
export function Console({ tabs, top, center, side, bar, sideTestId }: {
  tabs?: ReactNode; top?: ReactNode; center: ReactNode; side?: ReactNode; bar?: ReactNode; sideTestId?: string;
}) {
  const { robotType, heartbeatAt } = useSystem();
  const now = useNow(1000);
  const hb = !!heartbeatAt && now - heartbeatAt < 4000;
  return (
    <div className="console">
      <div className="console-main">
        <div className="console-top">
          <div className="stack-sm" style={{ gap: 12 }}>
            {tabs}
            <div className="robot-type-card">Robot Type <b>{robotType || 'none'}</b></div>
            <div><span className={`conn-chip${hb ? '' : ' off'}`}><span className="dot" style={{ background: 'currentColor' }} />{hb ? 'Connected' : 'No heartbeat'}</span></div>
          </div>
          {top}
          <div style={{ width: 120 }} className="hide-sm" />
        </div>
        <div className="console-center">{center}</div>
      </div>
      <aside className="console-side" data-testid={sideTestId}>{side}</aside>
      {bar && <div className="console-bottom">{bar}</div>}
    </div>
  );
}

/** Square control-bar button (Start / Stop / Retry …). */
export function BigButton({ icon, children, tone, busy, ...rest }: { icon?: ReactNode; children: ReactNode; tone?: 'primary' | 'danger'; busy?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`big-btn${tone ? ' ' + tone : ''}`} {...rest} disabled={rest.disabled || busy}>{busy ? <span className="spinner" /> : icon}{children}</button>;
}

/** Bottom control bar: buttons, a status column with time / progress, an optional ring and
 *  the host resources reported in /task/status. */
export function ControlBar({ buttons, title, dot = 'var(--ink-4)', time, pct = 0, barColor = 'var(--ink)', hint, ring, testId, phase }: {
  buttons: ReactNode; title: ReactNode; dot?: string; time?: ReactNode; pct?: number; barColor?: string; hint?: ReactNode;
  ring?: { value: number; total: number; label: string; sub?: ReactNode }; testId?: string; phase?: string | number;
}) {
  const { taskStatus: t } = useSystem();
  const res: [string, number | undefined, number | undefined, (v: number) => string][] = [
    ['CPU', t?.used_cpu, 100, (v) => `${v.toFixed(0)}%`],
    ['RAM', t?.used_ram_size, t?.total_ram_size, (v) => `${v.toFixed(1)} / ${(t?.total_ram_size || 0).toFixed(0)} GB`],
    ['DISK', t?.used_storage_size, t?.total_storage_size, (v) => `${v.toFixed(0)} / ${(t?.total_storage_size || 0).toFixed(0)} GB`],
  ];
  return (
    <div className="control-bar" data-testid={testId} data-phase={phase ?? ''}>
      <div className="cb-buttons">{buttons}</div>
      <div className="cb-status">
        <div className="row-between" style={{ flexWrap: 'nowrap' }}>
          <span className="row" style={{ fontSize: 16, fontWeight: 600, gap: 8 }}><span className="dot" style={{ background: dot }} />{title}</span>
          {time != null && <span className="num" style={{ fontSize: 18 }}>{time}</span>}
        </div>
        <div className="progress" style={{ height: 6 }}><span style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: barColor }} /></div>
        {hint && <div className="tiny muted">{hint}</div>}
      </div>
      {ring && (
        <div className="cb-progress">
          <Ring value={ring.value} total={ring.total} />
          <div><div className="label" style={{ fontSize: 9.5 }}>{ring.label}</div><div className="num" style={{ fontSize: 20, fontWeight: 300 }}>{ring.value} <span className="muted" style={{ fontSize: 14 }}>/ {ring.total}</span></div>{ring.sub && <div className="tiny muted">{ring.sub}</div>}</div>
        </div>
      )}
      <div className="cb-res">
        {res.map(([k, v, m, f]) => (
          <div key={k}><div className="row-between"><span>{k}</span><span>{v != null ? f(v) : '—'}</span></div><div className="progress"><span style={{ width: `${m ? Math.min(100, (100 * (v || 0)) / m) : 0}%`, background: 'var(--ink-3)' }} /></div></div>
        ))}
      </div>
    </div>
  );
}

export function Ring({ value, total }: { value: number; total: number }) {
  const p = total ? Math.min(1, value / total) : 0;
  const r = 22; const c = 2 * Math.PI * r;
  return (
    <svg className="ring" viewBox="0 0 54 54" aria-hidden>
      <circle cx="27" cy="27" r={r} fill="none" stroke="var(--paper-2)" strokeWidth="5" />
      <circle cx="27" cy="27" r={r} fill="none" stroke="var(--ok)" strokeWidth="5" strokeDasharray={`${c * p} ${c}`} transform="rotate(-90 27 27)" strokeLinecap="round" />
      <text x="27" y="31" textAnchor="middle" style={{ font: '600 11px var(--font-mono)', fill: 'var(--ink)' }}>{Math.round(p * 100)}%</text>
    </svg>
  );
}

/** Side-sheet section with a small uppercase heading. */
export function SideSec({ label, actions, children, ...rest }: { label?: ReactNode; actions?: ReactNode; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="side-sec" {...rest}>
      {(label || actions) && <div className="row-between" style={{ marginBottom: 10 }}><span className="label">{label}</span>{actions}</div>}
      {children}
    </div>
  );
}

/** The robot's live camera topics from physical_ai_server, side by side. */
export function RobotCameras({ recording, extra }: { recording?: boolean; extra?: [string, string][] }) {
  const av = useAvailability();
  const { robotType } = useSystem();
  const [topics, setTopics] = useState<string[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (extra?.length || !av.ros) return;
    let live = true;
    ros.cameras().then((c: any) => live && setTopics(c.topics || []), (e) => live && setErr(e));
    return () => { live = false; };
  }, [av.ros, robotType, extra?.length]);
  const list: [string, string][] = extra?.length ? extra : (topics || []).map((t) => [t, t]);
  if (!list.length) return <Empty icon={<I.camera />} title={!av.ros ? 'Cameras need the robot side' : err ? 'Camera list unavailable' : topics ? 'No camera topics' : 'Loading cameras…'}>{!av.ros ? 'physical_ai_server streams the camera topics.' : 'Select a robot type on Home; its camera topics appear here.'}</Empty>;
  return <div className={list.length > 1 ? 'grid g2' : ''} style={{ alignItems: 'center' }}>{list.map(([k, t]) => <CameraView key={k} topic={t} label={k === t ? undefined : k.split('.').pop()} quality={50} recording={recording} />)}</div>;
}
