// PHYSIOS application shell, laid out like the Physical AI Manager: a 96 px rail with the
// numbered workflow (01 Home … 06 Inference, R Robots), line-drawn glyphs, a black capsule for
// the current page, and the Link / Robot status card at the bottom. Pages draw their own
// header (see modules/shared.tsx Page).
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { I } from '@/design/icons';
import { Button, Dot, fmt, toneOf, useToast } from '@/design/ui';
import { Link, useRouter } from './router';
import { useSystem } from './system';

export type NavItem = { to: string; code: string; label: string; needs: 'robot' | 'link' | null; glyph: string; title: string };
export const NAV: NavItem[] = [
  { to: '/', code: '01', label: 'Home', needs: null, glyph: 'home', title: 'Home' },
  { to: '/planning', code: '02', label: 'Planning', needs: 'robot', glyph: 'planning', title: 'Planning' },
  { to: '/recording', code: '03', label: 'Record', needs: 'robot', glyph: 'record', title: 'Record' },
  { to: '/datasets', code: '04', label: 'Data', needs: 'link', glyph: 'data', title: 'Data' },
  { to: '/training', code: '05', label: 'Training', needs: null, glyph: 'training', title: 'Training' },
  { to: '/inference', code: '06', label: 'Inference', needs: 'robot', glyph: 'inference', title: 'Inference' },
];
// Not a workflow step: the robot library (always reachable)
const EXTRA: NavItem[] = [{ to: '/robots', code: 'R', label: 'Robots', needs: null, glyph: 'robots', title: 'Robots' }];

export function activeNav(path: string) {
  if (path.startsWith('/settings')) return { to: '/settings', code: 'S', label: 'Settings', needs: null, glyph: '', title: 'Settings' } as NavItem;
  return [...NAV, ...EXTRA].sort((a, b) => b.to.length - a.to.length).find((n) => (n.to === '/' ? path === '/' : path === n.to || path.startsWith(n.to + '/'))) || NAV[0];
}

/** Line-drawn glyphs in the Physical AI Manager drawing style. */
export function NavGlyph({ name }: { name: string }) {
  const c = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 };
  switch (name) {
    case 'home': return <svg viewBox="0 0 24 24" aria-hidden><path {...c} d="M4 11 12 4l8 7v9H4z" /><path {...c} d="M10 20v-5h4v5" /></svg>;
    case 'planning': return <svg viewBox="0 0 24 24" aria-hidden><rect {...c} x="3.5" y="3.5" width="17" height="17" /><path {...c} d="M3.5 9.5h17M9.5 3.5v17" strokeDasharray="2 2" /><circle cx="14.5" cy="14.5" r="2" fill="currentColor" /></svg>;
    case 'record': return <svg viewBox="0 0 24 24" aria-hidden><rect {...c} x="3" y="6" width="13" height="12" /><path {...c} d="m16 10 5-3v10l-5-3" /><circle cx="7" cy="10" r="1.3" fill="currentColor" /></svg>;
    case 'data': return <svg viewBox="0 0 24 24" aria-hidden><ellipse {...c} cx="12" cy="6" rx="7.5" ry="2.5" /><path {...c} d="M4.5 6v12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V6" /><path {...c} d="M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5" /></svg>;
    case 'training': return <svg viewBox="0 0 24 24" aria-hidden><path {...c} d="M4 19V5M4 19h16" /><path {...c} d="m7 15 4-5 3 3 5-7" /><circle cx="19" cy="6" r="1.4" fill="currentColor" /></svg>;
    case 'robots': return <svg viewBox="0 0 24 24" aria-hidden><path {...c} d="M5 20h14M8 20v-3h8v3M12 17V11" /><circle {...c} cx="12" cy="9" r="2" /><path {...c} d="m13.5 7.5 4-3.5 2 2" /></svg>;
    case 'inference': return <svg viewBox="0 0 24 24" aria-hidden><rect {...c} x="6" y="6" width="12" height="12" /><rect {...c} x="9.5" y="9.5" width="5" height="5" /><path {...c} d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></svg>;
    default: return <svg viewBox="0 0 24 24" aria-hidden><path {...c} d="M4 18 9 12l4 3 7-9" /></svg>;
  }
}

export function Mark() {
  return (
    <svg viewBox="0 0 28 16" style={{ height: 16, width: 28 }} aria-label="PHYSIOS">
      <path d="M2 13 7 3l5 10 5-10 5 10" fill="none" stroke="#0B0C0E" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="25" cy="4" r="2" fill="#2457E6" />
    </svg>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { loc, go } = useRouter();
  const toast = useToast();
  const { taskStatus, robotType, rosLink, heartbeatAt } = useSystem();
  const cur = activeNav(loc.path);
  const activeIndex = NAV.findIndex((n) => n.to === cur.to);
  const recording = taskStatus && [1, 2, 3, 4].includes(taskStatus.phase);
  const inferencing = taskStatus?.phase === 6;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const hb = heartbeatAt ? (now - heartbeatAt < 3000 ? 'ok' : 'warn') : 'idle';
  useEffect(() => { document.title = cur.to === '/' ? 'PHYSIOS' : `${cur.title} · PHYSIOS`; }, [cur]);

  const navigate = (e: React.MouseEvent, item: NavItem) => {
    e.preventDefault();
    if (item.needs === 'robot' && !robotType) { toast.error('Select and confirm a robot on Home first.'); return; }
    if (item.needs === 'link' && rosLink !== 'open') { toast.error('Server is not reachable (rosbridge). Check that physical_ai_server is running.'); return; }
    if (recording && cur.to === '/recording' && item.to !== '/recording') toast.info('Recording keeps running in the background.');
    go(item.to);
  };

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-logo"><Link to="/" aria-label="PHYSIOS home"><Mark /></Link></div>
        <nav className="nav" aria-label="Sessions">
          {[...NAV, ...EXTRA].map((item, i) => {
            const active = item.to === cur.to;
            const done = activeIndex > -1 && i < activeIndex && i < NAV.length;
            const blocked = (item.needs === 'robot' && !robotType) || (item.needs === 'link' && rosLink !== 'open');
            return (
              <a key={item.to} href={item.to} className="nav-item" aria-current={active ? 'page' : undefined} data-blocked={blocked} data-nav={item.to}
                title={blocked ? `${item.label} (needs ${item.needs === 'robot' ? 'a robot' : 'the server'})` : item.label} onClick={(e) => navigate(e, item)}>
                <span className={`nav-code${done && !active ? ' done' : ''}`}>{done && !active ? '✓' : item.code}</span>
                <NavGlyph name={item.glyph} />
                <span className="nav-label">{item.label}</span>
                {item.to === '/recording' && recording && <span className="nav-flag" title="recording" />}
                {item.to === '/inference' && inferencing && <span className="nav-flag" title="policy running on the robot" />}
              </a>
            );
          })}
        </nav>
        <div className="rail-foot">
          <div className="foot-row" title="rosbridge websocket"><Dot tone={rosLink === 'open' ? 'ok' : 'danger'} />Link</div>
          <div className="foot-row" title="physical_ai_server heartbeat"><Dot tone={hb === 'ok' ? 'ok' : hb === 'warn' ? 'warn' : 'neutral'} pulse={hb === 'ok'} />Robot</div>
          <RailTools />
        </div>
      </aside>
      <div className="main">
        <main className="content" id="content">{children}</main>
      </div>
    </div>
  );
}

/** Services, notifications and settings: small tools under the status card. */
function RailTools() {
  const { notices, unread, markRead, health, refreshHealth } = useSystem();
  const [open, setOpen] = useState<'' | 'services' | 'notes'>('');
  const ref = useOutside<HTMLDivElement>(() => setOpen(''));
  const svcDown = health ? Object.values(health.services).some((s) => s.status !== 'ok') : true;
  return (
    <div className="rail-tools popover-wrap" ref={ref}>
      <button onClick={() => setOpen(open === 'services' ? '' : 'services')} aria-label="Services" title="Services" data-testid="connections">
        <I.layers />{svcDown && <span className="count" style={{ background: 'var(--warn)', minWidth: 8, height: 8, top: -1, right: -1, padding: 0 }} />}
      </button>
      <button onClick={() => { setOpen(open === 'notes' ? '' : 'notes'); markRead(); }} aria-label="Notifications" title="Activity" data-testid="notifications">
        <I.bell />{unread > 0 && <span className="count">{unread > 9 ? '9+' : unread}</span>}
      </button>
      <Link to="/settings" aria-label="Settings" title="Settings"><I.settings /></Link>
      {open === 'services' && (
        <div className="popover" role="dialog" aria-label="Service status">
          <div className="panel-head"><h3 className="grow">Services</h3><Button size="sm" variant="ghost" icon={<I.refresh />} onClick={refreshHealth}>Check</Button></div>
          <div className="list">
            {health ? Object.entries(health.services).map(([k, s]) => (
              <div key={k} className="list-item" style={{ alignItems: 'flex-start' }} data-service={k} data-status={s.status}>
                <Dot tone={toneOf(s.status)} />
                <div className="grow">
                  <div className="row-between"><b style={{ fontWeight: 600 }}>{k.replace('_', ' ')}</b><span className="tiny muted">{s.latency_ms != null ? `${s.latency_ms} ms` : s.status}</span></div>
                  <div className="small text-2">{s.detail}</div>
                  {s.status !== 'ok' && s.hint && <div className="tiny muted" style={{ marginTop: 4 }}>{s.hint}</div>}
                </div>
              </div>
            )) : <div className="list-item small text-2">PHYSIOS gateway not reachable.</div>}
          </div>
        </div>
      )}
      {open === 'notes' && (
        <div className="popover" role="dialog" aria-label="Notifications">
          <div className="panel-head"><h3>Activity</h3></div>
          {notices.length ? (
            <div className="list">{notices.slice(0, 60).map((n) => (
              <div key={n.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                <Dot tone={n.level === 'error' ? 'danger' : n.level === 'warn' ? 'warn' : 'ok'} />
                <div className="grow"><div className="small">{n.text}</div><div className="tiny muted">{n.source} · {fmt.ago(n.t)}</div></div>
              </div>
            ))}</div>
          ) : <div style={{ padding: '0 20px 12px' }} className="small muted">No activity yet.</div>}
        </div>
      )}
    </div>
  );
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
