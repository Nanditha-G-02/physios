// 01 · Home, laid out like the Physical AI Manager home: version line and status chips,
// the large fading title with the robot drawing, the "Step 1 of 6 · Select your robot" card,
// the six workflow tiles, then the PHYSIOS operations overview below.
import { useEffect, useState } from 'react';
import { planning, data, ros } from '@/api/gateway';
import { trainer } from '@/api/trainer';
import { Link, useRouter } from '@/app/router';
import { useAvailability, useSystem } from '@/app/system';
import { useToast } from '@/design/ui';
import { useLoad } from '@/hooks/data';
import background from '@/assets/home-background.jpg';
import { Overview } from '../dashboard/Dashboard';
import RobotIllustration from './RobotIllustration';

const VERSION = '1.0.0';
// Same families as physical_ai_server/planning/profiles.py
const FAMILIES = [
  { re: /(so[-_]?10[01]|s10[01])/i, key: 'so101', name: 'SO-101 arm' },
  { re: /omx/i, key: 'omx', name: 'OpenMANIPULATOR-X' },
  { re: /omy/i, key: 'omy', name: 'OpenMANIPULATOR-Y' },
  { re: /ffw|ai[_-]?worker/i, key: 'ffw', name: 'AI Worker' },
];
const familyOf = (t: string) => FAMILIES.find((f) => f.re.test(t || '')) || { key: 'generic', name: 'Robot' };
const STAGE = ['draft', 'URDF registered', 'ROS verified', 'hardware verified', 'data & training ready'];

function FamilyGlyph({ family }: { family: string }) {
  const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
  if (family === 'ffw') {
    return <svg viewBox="0 0 40 40" aria-hidden><rect {...s} x="14" y="6" width="12" height="9" /><rect {...s} x="12" y="16" width="16" height="13" /><path {...s} d="M12 18l-6 7 2 6M28 18l6 7-2 6M16 29v7M24 29v7" /></svg>;
  }
  const tall = family === 'omy';
  return (
    <svg viewBox="0 0 40 40" aria-hidden>
      <path {...s} d="M8 35h20M11 35l2-5h10l2 5" />
      <path {...s} d={tall ? 'M18 30V18l9-9 6 4' : 'M18 30l-3-12 12-6 4 5'} />
      <circle cx="18" cy="18" r="2.2" fill="currentColor" />
      <path {...s} d={tall ? 'M33 13l2 3M33 13l3-1' : 'M31 17l2 3M31 17l3-1'} />
    </svg>
  );
}

const DOT: Record<string, string> = { ok: 'var(--ok)', warn: 'var(--warn)', err: 'var(--err)', sky: 'var(--sky-ink)', idle: 'var(--ink-4)' };

export default function Home() {
  const { go } = useRouter();
  const toast = useToast();
  const av = useAvailability();
  const { robotType, setRobotTypeLocal, rosLink, heartbeatAt, taskStatus } = useSystem();
  const types = useLoad(() => ros.robotTypes(), [av.ros], 0, av.ros);
  const customs = useLoad(() => trainer.robots(), [av.trainer], 0, av.trainer);
  const glance = useLoad(async () => {
    const [plans, ds] = await Promise.all([planning('plan.list', {}), data('data.list_datasets')]);
    const active = plans.plans.find((p: any) => p.id === plans.active_plan_id);
    return {
      plans: plans.plans.length, approved: plans.plans.filter((p: any) => p.status === 'approved').length,
      active: active ? { name: active.name, done: (active.progress?.validated || 0) + (active.progress?.recorded || 0), total: active.episodes } : null,
      datasets: ds.datasets.length, pending: ds.datasets.reduce((a: number, d: any) => a + (d.review_counts?.unreviewed || 0) + (d.review_counts?.needs_review || 0), 0),
    };
  }, [av.ros], 15000, av.ros);
  const [selected, setSelected] = useState('');
  const [saving, setSaving] = useState(false);
  const [aim, setAim] = useState<{ x: number; y: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => { if (robotType && !selected) setSelected(robotType); }, [robotType, selected]);
  const busy = taskStatus && taskStatus.phase !== 0 && taskStatus.phase !== 5;
  const hbOk = heartbeatAt && now - heartbeatAt < 3000;
  const linked = rosLink === 'open';
  const status = [
    { key: 'link', label: 'Server link', value: linked ? 'open' : 'closed', tone: linked ? 'ok' : 'err', hint: 'rosbridge :9090' },
    { key: 'server', label: 'Robot server', value: hbOk ? 'alive' : 'waiting', tone: hbOk ? 'ok' : 'idle', pulse: !!hbOk, hint: 'heartbeat' },
    { key: 'robot', label: 'Active robot', value: robotType || 'none', tone: robotType ? 'sky' : 'idle', hint: robotType ? familyOf(robotType).name : 'select below' },
  ];
  const confirm = async () => {
    if (!selected) return;
    setSaving(true);
    try { await ros.setRobotType(selected); setRobotTypeLocal(selected); toast.ok(`Robot type set to ${selected}`); } catch (e) { toast.error(e); } finally { setSaving(false); }
  };
  const g = glance.data;
  const steps = [
    { to: '/', code: '01', name: 'Home', state: robotType ? 'done' : 'current', text: robotType ? `robot ${robotType}` : 'select a robot' },
    { to: '/planning', code: '02', name: 'Planning', state: !robotType ? 'locked' : g?.approved ? 'done' : 'current', text: g ? `${g.plans} plan${g.plans === 1 ? '' : 's'} · ${g.approved} approved` : 'define a collection plan' },
    { to: '/recording', code: '03', name: 'Record', state: !robotType ? 'locked' : g?.active && g.active.done >= g.active.total ? 'done' : 'open', text: g?.active ? `${g.active.name}: ${g.active.done}/${g.active.total} episodes` : 'record demonstrations', pct: g?.active?.total ? (100 * g.active.done) / g.active.total : null },
    { to: '/datasets', code: '04', name: 'Data', state: !linked ? 'locked' : 'open', text: g ? `${g.datasets} dataset${g.datasets === 1 ? '' : 's'} · ${g.pending} pending review` : 'review & publish', badge: g?.pending || 0 },
    { to: '/training', code: '05', name: 'Training', state: 'open', text: 'train a policy on this PC' },
    { to: '/inference', code: '06', name: 'Inference', state: !robotType ? 'locked' : 'open', text: 'run a trained policy' },
  ];
  const list: string[] = types.data?.robot_types || [];
  return (
    <div className="home">
      <img src={background} alt="" aria-hidden className="home-bg" />
      <div className="home-veil" />
      <div className="orb drift" style={{ top: -96, right: '18%', width: 420, height: 420 }} aria-hidden />
      <div className="orb" style={{ bottom: -160, left: '8%', width: 360, height: 360, opacity: 0.5 }} aria-hidden />
      <div className="home-inner">
        <div className="row-between" style={{ animation: 'rise .45s both' }}>
          <div className="row" style={{ gap: 12 }}><span className="label">01 · Home</span><span style={{ height: 1, width: 40, background: 'var(--ink-4)' }} /><span className="label">v{VERSION}</span></div>
          <div className="row">{status.slice(0, 2).map((s) => (
            <span key={s.key} className="pill"><span className="dot" style={{ background: DOT[s.tone], animation: s.pulse ? 'pulsedot 1.4s infinite' : undefined }} />{s.label.toLowerCase()} {s.value}</span>
          ))}</div>
        </div>

        <div className="home-grid">
          <div style={{ minWidth: 0, animation: 'rise .45s 60ms both' }}>
            <h1 className="home-title fade-text">PHYSIOS</h1>
            <p style={{ marginTop: 16, fontSize: 15, color: 'var(--ink-3)', maxWidth: 460 }}>The Operating System for Physical Intelligence. Plan demonstrations, record them on the robot, review the data, train a policy on this PC and run it.</p>
            <div style={{ position: 'relative', marginTop: 24, width: '100%', maxWidth: 520 }}
              onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAim({ x: ((e.clientX - r.left) / r.width) * 2 - 1, y: ((e.clientY - r.top) / r.height) * 2 - 1 }); }}
              onPointerLeave={() => setAim(null)}>
              <RobotIllustration className="robot-drawing" aim={aim} />
            </div>
          </div>

          <section className="panel" style={{ background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(12px)', boxShadow: 'var(--shadow-lift)', animationDelay: '140ms' }} aria-label="Robot selection" data-testid="robot-select-card">
            <header className="panel-head">
              <div className="grow"><div className="label">Step 1 of 6</div><h2 style={{ fontSize: 17 }}>Select your robot</h2></div>
              <button className="btn btn-sm" onClick={types.reload} disabled={types.loading} aria-label="Reload robot types">{types.loading ? <span className="spinner" /> : '↻'} Refresh</button>
            </header>
            <div className="panel-body stack" style={{ gap: 16, paddingTop: 4 }}>
              {!av.ros && av.known && <div className="callout callout-danger">Cannot reach physical_ai_server (rosbridge on port 9090). {av.hint('ros_node')}</div>}
              {types.error ? <div className="callout callout-danger">{(types.error as Error).message}</div> : null}
              <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8, maxHeight: 248, overflowY: 'auto' }} role="radiogroup" aria-label="Robot type">
                {list.map((t) => (
                  <button key={t} type="button" role="radio" aria-checked={selected === t} data-robot={t} className="robot-tile" disabled={saving || !!busy} onClick={() => setSelected(t)}>
                    <FamilyGlyph family={familyOf(t).key} />
                    <span style={{ minWidth: 0 }}><span className="ellipsis" style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{t}</span><span className="t-sub ellipsis">{familyOf(t).name}</span></span>
                    {robotType === t && <span className="badge badge-ok" style={{ position: 'absolute', right: 6, bottom: 6, fontSize: 9.5, padding: '0 4px' }}>active</span>}
                  </button>
                ))}
                {!list.length && <div style={{ gridColumn: 'span 2', borderRadius: 16, background: 'var(--paper)', padding: 16, textAlign: 'center', fontSize: 12.5, color: 'var(--ink-3)' }}>{types.loading ? 'Loading robot types…' : 'No robot types yet'}</div>}
                {(customs.data?.robots || []).map((r: any) => {
                  const st = r.state === 'registered' ? r.stage || 1 : 0;
                  return (
                    <Link key={r.id} to={`/robots/${r.id}`} className="robot-tile" data-custom-robot={r.id} style={{ textDecoration: 'none' }}>
                      <FamilyGlyph family="generic" />
                      <span style={{ minWidth: 0 }}><span className="ellipsis" style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{r.name}</span><span className="t-sub ellipsis">Custom · {st ? `Stage ${st} ${STAGE[st]}` : 'draft'}</span></span>
                    </Link>
                  );
                })}
                <Link to="/robots/new" className="robot-tile add" data-action="add-custom-robot" style={{ textDecoration: 'none' }}>
                  <span style={{ width: 36, height: 36, flex: 'none', display: 'grid', placeItems: 'center', borderRadius: 12, background: 'var(--paper)', fontSize: 20 }}>+</span>
                  <span style={{ minWidth: 0 }}><span className="ellipsis" style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>Add Custom Robot</span><span className="t-sub ellipsis">from a URDF / Xacro</span></span>
                </Link>
              </div>
              <button className={robotType && robotType === selected ? 'btn' : 'btn btn-primary'} style={{ width: '100%', padding: '10px 16px', fontSize: 14 }} onClick={confirm} disabled={!selected || saving || !!busy} data-action="confirm-robot">
                {saving && <span className="spinner" />}
                {robotType && robotType === selected ? `✓ ${robotType} confirmed — re-apply` : selected ? `Confirm ${selected}` : 'Choose a robot above'}
              </button>
              <div className="grid g3" style={{ gap: 8 }}>
                {status.map((s) => (
                  <div key={s.key} className="status-box">
                    <div className="label ellipsis" style={{ fontSize: 9.5 }}>{s.label}</div>
                    <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: 'nowrap' }}><span className="dot" style={{ background: DOT[s.tone], animation: s.pulse ? 'pulsedot 1.4s infinite' : undefined }} /><span className="ellipsis" style={{ fontSize: 12.5, fontWeight: 500 }} data-status={s.key}>{s.value}</span></div>
                    <div className="ellipsis" style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 2 }}>{s.hint}</div>
                  </div>
                ))}
              </div>
              {busy && <p style={{ margin: 0, fontSize: 12, color: 'var(--warn)' }}>A task is running — the robot type is locked until it finishes.</p>}
              <button className="btn btn-sky" style={{ width: '100%' }} disabled={!robotType} onClick={() => go('/planning')}>Continue to Planning →</button>
            </div>
          </section>
        </div>

        <nav aria-label="Workflow" style={{ animation: 'rise .45s 240ms both' }}>
          <ol className="wf">{steps.map((s) => (
            <li key={s.to} style={{ minWidth: 0 }}>
              <Link to={s.to} className={`wf-tile ${s.state}`} data-step={s.code}>
                <div className="row-between" style={{ flexWrap: 'nowrap' }}>
                  <span style={{ font: '10.5px var(--font-mono)', color: s.state === 'done' ? 'var(--ok)' : 'var(--ink-4)' }}>{s.state === 'done' ? '✓' : s.code}</span>
                  {(s.badge || 0) > 0 && <span className="badge badge-warn num" style={{ padding: '0 8px' }}>{s.badge}</span>}
                  {s.state === 'locked' && <span className="label" style={{ fontSize: 9 }}>locked</span>}
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{s.name}</div>
                <div className="wf-text">{s.text}</div>
                {s.pct != null && <div style={{ marginTop: 6, height: 4, borderRadius: 99, background: 'var(--paper-3)', overflow: 'hidden' }}><div style={{ height: 4, background: 'var(--ok)', width: `${s.pct}%` }} /></div>}
              </Link>
            </li>
          ))}</ol>
        </nav>
      </div>

      <div className="page" style={{ paddingTop: 0 }}>
        <div className="hero-head" style={{ marginBottom: 16 }}>
          <div><div className="label">Overview</div><h1 className="fade-text" style={{ fontSize: 32 }}>Operations</h1><p className="page-intro">Live state of the services, the robot PC, training and your datasets.</p></div>
        </div>
        <Overview />
      </div>
    </div>
  );
}
