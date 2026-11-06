// PHYSIOS application shell: rail navigation, header with live connection indicators,
// robot selector, notifications and theme switch.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { I, Logo } from '@/design/icons';
import { Badge, Button, Dot, fmt, toneOf, useToast } from '@/design/ui';
import { ros } from '@/api/gateway';
import { useLoad } from '@/hooks/data';
import { Link, useRouter } from './router';
import { useSystem } from './system';

export type NavItem = { to: string; label: string; icon: (p: any) => JSX.Element; group: string; match?: string };
export const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: I.dashboard, group: 'Overview' },
  { to: '/planning', label: 'Planning Studio', icon: I.planning, group: 'Collect' },
  { to: '/recording', label: 'Recording Studio', icon: I.record, group: 'Collect' },
  { to: '/datasets', label: 'Dataset Library', icon: I.datasets, group: 'Collect' },
  { to: '/training', label: 'Training Studio', icon: I.training, group: 'Learn' },
  { to: '/optimization', label: 'Optimization Studio', icon: I.optimize, group: 'Learn' },
  { to: '/evaluation', label: 'Evaluation Studio', icon: I.evaluation, group: 'Learn' },
  { to: '/inference', label: 'Inference Studio', icon: I.inference, group: 'Deploy' },
  { to: '/rollout', label: 'Robot Rollout', icon: I.rollout, group: 'Deploy' },
  { to: '/robots', label: 'Robot Management', icon: I.robot, group: 'System' },
  { to: '/settings', label: 'Settings', icon: I.settings, group: 'System' },
];

export function activeNav(path: string) {
  return [...NAV].sort((a, b) => b.to.length - a.to.length).find((n) => (n.to === '/' ? path === '/' : path === n.to || path.startsWith(n.to + '/'))) || NAV[0];
}

export function Shell({ children }: { children: ReactNode }) {
  const { loc } = useRouter();
  const [open, setOpen] = useState(false);
  const cur = activeNav(loc.path);
  const groups = Array.from(new Set(NAV.map((n) => n.group)));
  const { taskStatus } = useSystem();
  const recording = taskStatus && [1, 2, 3, 4].includes(taskStatus.phase);
  const inferencing = taskStatus?.phase === 6;
  useEffect(() => setOpen(false), [loc.path]);
  useEffect(() => { document.title = cur.to === '/' ? 'PHYSIOS' : `${cur.label} · PHYSIOS`; }, [cur]);
  return (
    <div className="shell">
      <aside className="rail" data-open={open}>
        <div className="brand">
          <Logo />
          <div>
            <div className="brand-name">PHYSIOS</div>
            <div className="brand-sub">The Operating System for Physical Intelligence</div>
          </div>
        </div>
        <nav className="nav" aria-label="Main">
          {groups.map((g) => (
            <div className="nav-group" key={g}>
              <div className="nav-group-label">{g}</div>
              {NAV.filter((n) => n.group === g).map((n) => (
                <Link key={n.to} to={n.to} className="nav-item" aria-current={cur.to === n.to ? 'page' : undefined} data-nav={n.to}>
                  <n.icon />{n.label}
                  {n.to === '/recording' && recording && <span className="nav-badge"><Badge tone="danger">REC</Badge></span>}
                  {n.to === '/rollout' && inferencing && <span className="nav-badge"><Badge tone="warn">LIVE</Badge></span>}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <RailFoot />
      </aside>
      <div className="main">
        <header className="header">
          <Button className="menu-btn" variant="ghost" iconOnly icon={<I.menu />} onClick={() => setOpen((o) => !o)} aria-label="Menu" />
          <div className="header-title">
            <span className="crumb">{cur.group}</span>
            <h1>{cur.label}</h1>
          </div>
          <div className="header-spacer" />
          <ConnectionPills />
          <RobotSelector />
          <Notifications />
          <ThemeToggle />
        </header>
        <main className="content" id="content">{children}</main>
      </div>
    </div>
  );
}

function RailFoot() {
  const { health } = useSystem();
  const v = health?.services?.gateway?.version;
  return (
    <div className="rail-foot">
      <div className="row-between"><span>Gateway {v ? `v${v}` : ''}</span><span className="row" style={{ gap: 6 }}><Dot tone={health ? toneOf(health.status) : 'danger'} />{health ? health.status : 'offline'}</span></div>
    </div>
  );
}

const SERVICES: [key: string, label: string][] = [['trainer', 'Trainer'], ['ros_node', 'ROS 2'], ['camera', 'Cameras']];

function ConnectionPills() {
  const { health, healthError, refreshHealth } = useSystem();
  const [open, setOpen] = useState(false);
  const ref = useOutside<HTMLDivElement>(() => setOpen(false));
  const down = !!healthError && !health;
  return (
    <div className="popover-wrap hide-sm" ref={ref}>
      <button className="pill" style={{ cursor: 'pointer' }} onClick={() => setOpen((o) => !o)} data-testid="connections" aria-expanded={open}>
        {down ? <><Dot tone="danger" /><b>Gateway offline</b></> : SERVICES.map(([k, l]) => {
          const s = health?.services?.[k as keyof typeof health.services];
          return <span key={k} className="row" style={{ gap: 6 }} data-service={k} data-status={s?.status || 'unknown'}><Dot tone={s ? toneOf(s.status) : 'neutral'} pulse={!s} />{l}</span>;
        })}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Service status">
          <div className="panel-head"><h3 className="grow">Services</h3><Button size="sm" variant="ghost" icon={<I.refresh />} onClick={refreshHealth}>Check</Button></div>
          <div className="list">
            {health ? Object.entries(health.services).map(([k, s]) => (
              <div key={k} className="list-item" style={{ alignItems: 'flex-start' }}>
                <Dot tone={toneOf(s.status)} />
                <div className="grow">
                  <div className="row-between"><b style={{ fontWeight: 600 }}>{k.replace('_', ' ')}</b><span className="tiny muted">{s.latency_ms != null ? `${s.latency_ms} ms` : s.status}</span></div>
                  <div className="small text-2">{s.detail}</div>
                  {s.status !== 'ok' && s.hint && <div className="tiny muted" style={{ marginTop: 4 }}>{s.hint}</div>}
                </div>
              </div>
            )) : <div className="list-item small text-2">{(healthError as Error)?.message || 'Checking…'}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function RobotSelector() {
  const { robotType, setRobotTypeLocal, health, taskStatus } = useSystem();
  const toast = useToast();
  const rosOk = health?.services?.ros_node?.status === 'ok';
  const types = useLoad(() => ros.robotTypes(), [rosOk], 0, rosOk);
  const [busy, setBusy] = useState(false);
  const locked = taskStatus && taskStatus.phase !== 0 && taskStatus.phase !== 5;
  if (!rosOk) return null;
  return (
    <label className="pill hide-sm" title={locked ? 'Robot type cannot change while a task runs' : 'Active robot type on physical_ai_server'}>
      <I.robot width={15} height={15} />
      <select
        className="select" style={{ height: 24, border: 0, background: 'transparent', padding: '0 4px', width: 'auto', boxShadow: 'none' }}
        value={robotType} disabled={busy || !!locked} data-testid="robot-select"
        onChange={async (e) => {
          const v = e.target.value;
          if (!v) return;
          setBusy(true);
          try { await ros.setRobotType(v); setRobotTypeLocal(v); toast.ok(`Robot type set to ${v}`); } catch (err) { toast.error(err); } finally { setBusy(false); }
        }}
      >
        <option value="">Select robot…</option>
        {(types.data?.robot_types || []).map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
    </label>
  );
}

function Notifications() {
  const { notices, unread, markRead } = useSystem();
  const [open, setOpen] = useState(false);
  const ref = useOutside<HTMLDivElement>(() => setOpen(false));
  return (
    <div className="popover-wrap" ref={ref}>
      <Button variant="ghost" iconOnly icon={<I.bell />} aria-label="Notifications" data-testid="notifications"
        onClick={() => { setOpen((o) => !o); if (!open) markRead(); }} style={{ position: 'relative' }}>
        {unread > 0 && <span style={{ position: 'absolute', top: 3, right: 3, minWidth: 16, height: 16, borderRadius: 8, background: 'var(--danger)', color: '#fff', fontSize: 10, display: 'grid', placeItems: 'center', padding: '0 4px' }}>{unread > 9 ? '9+' : unread}</span>}
      </Button>
      {open && (
        <div className="popover" role="dialog" aria-label="Notifications">
          <div className="panel-head"><h3>Activity</h3></div>
          {notices.length ? (
            <div className="list">{notices.slice(0, 60).map((n) => (
              <div key={n.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                <Dot tone={n.level === 'error' ? 'danger' : n.level === 'warn' ? 'warn' : 'ok'} />
                <div className="grow"><div className="small">{n.text}</div><div className="tiny muted">{n.source} · {fmt.ago(n.t)}</div></div>
              </div>
            ))}</div>
          ) : <div className="state"><p>No activity yet.</p></div>}
        </div>
      )}
    </div>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useSystem();
  return <Button variant="ghost" iconOnly icon={theme === 'dark' ? <I.sun /> : <I.moon />} aria-label="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />;
}

function useOutside<T extends HTMLElement>(fn: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) fn(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  });
  return ref;
}
