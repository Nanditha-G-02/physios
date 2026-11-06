// MODULE 7: Robot Management. Custom robot library, upload, validation, configuration and
// staged readiness are pam_trainer's robots/ package (safe archive, safe Xacro, URDF checks,
// fingerprinted verifications). Built-in robot types come from physical_ai_server.
import { useEffect, useMemo, useRef, useState } from 'react';
import { files, ros } from '@/api/gateway';
import { trainer } from '@/api/trainer';
import { rosSocket } from '@/api/rosbridge';
import { Link, useRouter } from '@/app/router';
import { useAvailability, useSystem } from '@/app/system';
import { I } from '@/design/icons';
import {
  Badge, Button, Callout, Check, CodeBlock, Confirm, Empty, ErrorState, Field, Input, KV, Loading, NumberInput, Panel,
  Select, StatusBadge, Switch, Tabs, TextArea, fmt, useToast,
} from '@/design/ui';
import { useLoad, useNow } from '@/hooks/data';
import { HW_CHECKLIST, fullTopic, runHardwareTest, toUrdf, type HwJoint } from '@/lib/hardwareTest';
import { Page, Requires } from '../shared';
import { UrdfScene } from './UrdfScene';

const STAGES = ['Draft', 'URDF registered', 'ROS verified', 'Hardware verified', 'Data & training ready'];

export default function RobotManagement({ view, robotId }: { view?: 'new'; robotId?: string }) {
  return (
    <Page>
      <Requires service="trainer" what="Robot management">
        {robotId ? <RobotDetail id={robotId} /> : view === 'new' ? <AddRobot /> : <Library />}
      </Requires>
    </Page>
  );
}

// ---------------------------------------------------------------------------- library
function Library() {
  const av = useAvailability();
  const { robotType } = useSystem();
  const robots = useLoad(() => trainer.robots(), [], 10000);
  const builtIn = useLoad(() => ros.robotTypes(), [av.ros], 0, av.ros);
  const list: any[] = robots.data?.robots || [];
  const customIds = new Set(list.map((r) => r.id.toLowerCase().replace(/[^a-z0-9_]/g, '_')));
  return (
    <div className="stack">
      <div className="row-between">
        <p className="page-intro" style={{ margin: 0 }}>Robots known to this PC: built-in types served by physical_ai_server, and custom robots added from a URDF / Xacro. Custom robots unlock step by step, and the real robot never moves without your explicit authorisation.</p>
        <Link to="/robots/new" className="btn btn-primary" data-action="add-robot"><I.plus />Add custom robot</Link>
      </div>
      <Panel title="Custom robot library" sub={`${list.length} robot(s)`} flush>
        {robots.error ? <ErrorState error={robots.error} onRetry={robots.reload} /> : !robots.data ? <div style={{ padding: 16 }}><Loading rows={3} /></div> : !list.length ? <Empty icon={<I.robot />} title="No custom robots yet" action={<Link to="/robots/new" className="btn btn-sm">Add one from a URDF</Link>} /> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Robot</th><th>Type</th><th>State</th><th>Readiness</th><th className="right">DOF</th><th>Validation</th><th>Updated</th></tr></thead>
            <tbody>{list.map((r) => (
              <tr key={r.id} data-robot-card={r.id}>
                <td><Link to={`/robots/${r.id}`}><b style={{ fontWeight: 600 }}>{r.name}</b></Link><div className="tiny muted mono">{r.id}</div></td>
                <td>{r.type}</td><td><StatusBadge status={r.state === 'registered' ? 'ok' : 'draft'} /></td>
                <td><StageDots stage={r.state === 'registered' ? r.stage || 1 : 0} /></td>
                <td className="right num">{r.dof ?? '—'}</td><td><StatusBadge status={r.validation_status} /></td><td className="small muted">{fmt.ago(r.updated_at)}</td>
              </tr>
            ))}</tbody></table></div>
        )}
      </Panel>
      <Panel title="Built-in robot types" sub="Configured in physical_ai_server">
        {!av.ros ? <span className="small muted">Robot side offline: {av.hint('ros_node')}</span> : builtIn.error ? <ErrorState error={builtIn.error} /> : !builtIn.data ? <Loading rows={1} /> : (
          <div className="row">{builtIn.data.robot_types.map((t) => <Badge key={t} tone={t === robotType ? 'accent' : customIds.has(t) ? 'info' : 'neutral'} dot={t === robotType}>{t}{customIds.has(t) ? ' (custom)' : ''}</Badge>)}</div>
        )}
      </Panel>
    </div>
  );
}

function StageDots({ stage }: { stage: number }) {
  return <span className="row" style={{ gap: 4 }} title={STAGES[stage]}>{[1, 2, 3, 4].map((n) => <span key={n} style={{ width: 18, height: 5, borderRadius: 3, background: n <= stage ? 'var(--accent)' : 'var(--surface-3)' }} />)}<span className="tiny muted" style={{ marginLeft: 4 }}>{STAGES[stage]}</span></span>;
}

// ---------------------------------------------------------------------------- add robot
function AddRobot() {
  const toast = useToast();
  const { go, loc } = useRouter();
  const types = useLoad(() => trainer.robots(), []);
  const replaceId = loc.query.get('replace');
  const [meta, setMeta] = useState({ name: '', type: 'arm', manufacturer: '', description: '' });
  const [rid, setRid] = useState<string | null>(null);
  const [robot, setRobot] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const [uploaded, setUploaded] = useState<{ files: string[]; skipped: any[] }>({ files: [], skipped: [] });
  const [entry, setEntry] = useState('');
  useEffect(() => {
    if (!replaceId) return;
    trainer.robot(replaceId).then((r: any) => { setRid(replaceId); setRobot({ ...r, validation: null }); setMeta({ name: r.name, type: r.type, manufacturer: r.manufacturer || '', description: r.description || '' }); }, toast.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaceId]);
  const step = !rid ? 0 : !robot?.validation ? 1 : robot.state !== 'registered' ? 2 : 3;
  const create = async () => { setBusy('create'); try { const r = await trainer.robotCreate(meta); setRid(r.id); setRobot(r); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  const upload = async (list: File[]) => {
    if (!rid) return;
    setBusy('upload');
    try {
      const out = { files: [...uploaded.files], skipped: [...uploaded.skipped] };
      for (const f of list) {
        const isZip = /\.zip$/i.test(f.name);
        const rel = (f as any).webkitRelativePath || f.name;
        const r = await trainer.robotUpload(rid, f, isZip ? 'zip' : 'file', rel);
        out.files.push(...(r.files || [])); out.skipped.push(...(r.skipped || []));
      }
      setUploaded(out);
      toast.ok(`${out.files.length} file(s) uploaded`);
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const validate = async () => { setBusy('validate'); try { setRobot(await trainer.robotAction(rid!, 'validate', entry ? { entry } : {})); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  const register = async () => { setBusy('register'); try { const r = await trainer.robotAction(rid!, 'register'); setRobot(r); toast.ok('Robot registered (Stage 1)'); go(`/robots/${rid}`); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  const urdfs = uploaded.files.filter((f) => /\.(urdf|xacro)$/i.test(f));
  return (
    <div className="stack" data-testid="add-robot">
      <div className="row-between"><Link to="/robots" className="btn btn-sm btn-ghost"><I.back />Robots</Link>
        <div className="steps">{['Describe', 'Upload model', 'Validate', 'Register'].map((s, i) => <div key={s} className={`step ${i < step ? 'done' : i === step ? 'active' : ''}`}><b>{i < step ? '✓' : i + 1}</b>{s}</div>)}</div></div>
      {step === 0 && (
        <Panel title="Describe the robot" footer={<Button variant="primary" disabled={!meta.name.trim()} busy={busy === 'create'} onClick={create} data-action="create-robot">Continue</Button>}>
          <div className="grid g2">
            <Field label="Name"><Input value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} data-field="robot-name" /></Field>
            <Field label="Type"><Select value={meta.type} onChange={(v) => setMeta({ ...meta, type: v })} options={(types.data?.types || ['arm']).map((t: string) => ({ value: t, label: t }))} /></Field>
            <Field label="Manufacturer"><Input value={meta.manufacturer} onChange={(e) => setMeta({ ...meta, manufacturer: e.target.value })} /></Field>
            <Field label="Description"><Input value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} /></Field>
          </div>
        </Panel>
      )}
      {step >= 1 && step < 3 && (
        <div className="grid g2">
          <Panel title="Upload the robot model" sub="A .zip with the URDF/Xacro and meshes, or the files / folder themselves">
            <div className="stack">
              <DropZone onFiles={upload} busy={busy === 'upload'} />
              {uploaded.files.length > 0 && <div className="small"><b>{uploaded.files.length}</b> file(s) stored{uploaded.skipped.length ? `, ${uploaded.skipped.length} skipped (not allowed)` : ''}.</div>}
              {urdfs.length > 1 && <Field label="Main robot description"><Select value={entry} onChange={setEntry} options={urdfs} placeholder="Detect automatically" /></Field>}
              <Callout tone="info">Xacro is expanded by a restricted evaluator: no shell commands, environment variables or files outside the upload are used.</Callout>
              <Button variant="primary" disabled={!uploaded.files.length} busy={busy === 'validate'} onClick={validate} data-action="validate-robot">Validate</Button>
            </div>
          </Panel>
          {robot?.validation ? <ValidationPanel v={robot.validation} footer={<Button variant="primary" disabled={robot.validation.status === 'failed'} busy={busy === 'register'} onClick={register} data-action="register-robot">Register robot</Button>} /> : <Panel><Empty icon={<I.shield />} title="Not validated yet" /></Panel>}
        </div>
      )}
    </div>
  );
}

function DropZone({ onFiles, busy }: { onFiles: (f: File[]) => void; busy?: boolean }) {
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  useEffect(() => { dirRef.current?.setAttribute('webkitdirectory', ''); }, []);
  return (
    <div className="dropzone" data-over={over} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(Array.from(e.dataTransfer.files)); }}>
      {busy ? <div className="row" style={{ justifyContent: 'center' }}><span className="spinner" />Uploading…</div> : (
        <div className="stack-sm" style={{ alignItems: 'center' }}>
          <I.upload width={26} height={26} />
          <div>Drop a .zip, .urdf / .xacro and mesh files here</div>
          <div className="row"><Button size="sm" onClick={() => fileRef.current?.click()}>Choose files</Button><Button size="sm" onClick={() => dirRef.current?.click()}>Choose folder</Button></div>
          <div className="tiny muted">URDF, Xacro, STL, DAE, OBJ, YAML, PNG/JPG textures · up to 128 MB per request</div>
        </div>
      )}
      <input ref={fileRef} type="file" multiple hidden onChange={(e) => e.target.files && onFiles(Array.from(e.target.files))} data-upload-input />
      <input ref={dirRef} type="file" multiple hidden onChange={(e) => e.target.files && onFiles(Array.from(e.target.files))} />
    </div>
  );
}

function ValidationPanel({ v, footer }: { v: any; footer?: React.ReactNode }) {
  const order = { error: 0, warning: 1, info: 2, ok: 3 } as Record<string, number>;
  const checks = [...(v.checks || [])].sort((a, b) => order[a.level] - order[b.level]);
  return (
    <Panel title="Validation report" sub={`${v.counts?.error || 0} error(s) · ${v.counts?.warning || 0} warning(s) · ${v.counts?.ok || 0} passed`} actions={<StatusBadge status={v.status} />} footer={footer} data-testid="validation">
      <div className="stack-sm">
        {v.summary && <KV items={[['Robot', v.summary.name], ['Links / joints', `${v.summary.links} / ${v.summary.joints} (${v.summary.dof} DOF)`], ['Base → end links', `${v.summary.base_link} → ${(v.summary.end_links || []).join(', ')}`], ['Meshes', `${v.summary.meshes_found}/${v.summary.meshes} found`], ['Total mass', v.summary.total_mass != null ? `${v.summary.total_mass.toFixed(2)} kg` : '—'], ['Extent', v.summary.extent_m ? `${v.summary.extent_m.map((x: number) => x.toFixed(2)).join(' × ')} m` : '—']]} />}
        <hr className="sep" />
        {checks.map((c, i) => (
          <div key={i} className="row small" style={{ alignItems: 'flex-start' }} data-check={c.id} data-level={c.level}>
            {c.level === 'ok' ? <I.ok width={16} height={16} style={{ color: 'var(--ok)', flex: 'none' }} /> : c.level === 'info' ? <I.info width={16} height={16} style={{ color: 'var(--accent-2)', flex: 'none' }} /> : <I.alert width={16} height={16} style={{ color: c.level === 'error' ? 'var(--danger)' : 'var(--warn)', flex: 'none' }} />}
            <div className="grow"><div>{c.title}</div>{c.detail && <div className="tiny muted">{c.detail}</div>}{c.suggestion && <div className="tiny" style={{ color: 'var(--accent-2)' }}>{c.suggestion}</div>}{c.where && <div className="tiny mono muted">{c.where}</div>}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------- detail
type DTab = 'model' | 'validation' | 'config' | 'readiness' | 'history';

function RobotDetail({ id }: { id: string }) {
  const toast = useToast();
  const { go, loc } = useRouter();
  const rb = useLoad(() => trainer.robot(id), [id]);
  const tab = (loc.query.get('tab') as DTab) || 'model';
  const setTab = (t: DTab) => go(`/robots/${id}?tab=${t}`, true);
  const [confirm, setConfirm] = useState<'' | 'delete' | 'replace'>('');
  const [edit, setEdit] = useState(false);
  if (rb.error) return <ErrorState error={rb.error} onRetry={rb.reload} />;
  const r = rb.data;
  if (!r) return <Loading />;
  const stage = r.state === 'registered' ? r.readiness?.stage || r.stage || 1 : 0;
  return (
    <div className="stack" data-robot-detail={id}>
      <div className="row-between">
        <div className="row"><Link to="/robots" className="btn btn-sm btn-ghost"><I.back />Robots</Link><h2 style={{ margin: 0, fontSize: 18 }}>{r.name}</h2><Badge>{r.type}</Badge><StatusBadge status={r.state === 'registered' ? 'ok' : 'draft'} /><StageDots stage={stage} /></div>
        <div className="row">
          <Button size="sm" icon={<I.edit />} onClick={() => setEdit(true)}>Edit</Button>
          <Button size="sm" icon={<I.refresh />} onClick={() => trainer.robotAction(id, 'validate', {}).then((x) => { rb.setData(x); toast.ok('Re-validated'); }, toast.error)}>Revalidate</Button>
          <Button size="sm" icon={<I.upload />} onClick={() => setConfirm('replace')}>Replace URDF</Button>
          <Button size="sm" variant="ghost" icon={<I.trash />} onClick={() => setConfirm('delete')} data-action="delete-robot">Delete</Button>
        </div>
      </div>
      {r.description && <p className="page-intro" style={{ margin: 0 }}>{r.description}{r.manufacturer ? ` · ${r.manufacturer}` : ''}</p>}
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'model', label: '3D model' }, { id: 'validation', label: 'Validation', badge: <StatusBadge status={r.validation?.status} /> }, { id: 'config', label: 'Robot configuration' }, { id: 'readiness', label: 'Robot readiness' }, { id: 'history', label: 'History' }]} />
      {tab === 'model' && <ModelTab robot={r} />}
      {tab === 'validation' && (r.validation ? <ValidationPanel v={r.validation} /> : <Empty title="Not validated" />)}
      {tab === 'config' && <ConfigTab robot={r} onSaved={rb.setData} />}
      {tab === 'readiness' && <ReadinessTab robot={r} refresh={rb.reload} />}
      {tab === 'history' && <Panel title="History"><div className="timeline">{(r.history || []).slice().reverse().map((h: any, i: number) => <div key={i} className="timeline-item ok small"><b>{(h.event || '').replace(/_/g, ' ')}</b> <span className="muted">· {fmt.time(h.at || h.t)}</span>{h.detail && <div className="tiny muted">{typeof h.detail === 'string' ? h.detail : JSON.stringify(h.detail)}</div>}</div>)}</div></Panel>}
      <EditMeta open={edit} robot={r} onClose={() => setEdit(false)} onSaved={(x) => { rb.setData(x); setEdit(false); }} />
      <Confirm open={confirm === 'replace'} onClose={() => setConfirm('')} title="Replace the robot model" confirmLabel="Replace" onConfirm={async () => { setConfirm(''); try { await trainer.robotAction(id, 'replace'); toast.ok('Old files removed; upload the new model'); go(`/robots/new?replace=${id}`); rb.reload(); } catch (e) { toast.error(e); } }}>
        The uploaded files are removed and every readiness stage is reset; the robot configuration is kept. Upload and validate the new model afterwards.
      </Confirm>
      <Confirm open={confirm === 'delete'} onClose={() => setConfirm('')} danger title={`Delete ${r.name}`} confirmLabel="Delete" typeToConfirm={r.name} onConfirm={async () => { setConfirm(''); try { await trainer.robotAction(id, 'delete', { confirm_name: r.name }); toast.ok('Robot deleted'); go('/robots'); } catch (e) { toast.error(e); } }}>
        Deletes the profile, files and verification history. Recorded datasets are not touched.
      </Confirm>
    </div>
  );
}

function EditMeta({ open, robot, onClose, onSaved }: { open: boolean; robot: any; onClose: () => void; onSaved: (r: any) => void }) {
  const toast = useToast();
  const [m, setM] = useState({ name: robot.name, description: robot.description || '', manufacturer: robot.manufacturer || '' });
  useEffect(() => { if (open) setM({ name: robot.name, description: robot.description || '', manufacturer: robot.manufacturer || '' }); }, [open, robot]);
  return (
    <Confirm open={open} onClose={onClose} title="Edit robot" confirmLabel="Save" onConfirm={() => trainer.robotAction(robot.id, 'update', m).then(onSaved, toast.error)}>
      <Field label="Name"><Input value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} /></Field>
      <Field label="Manufacturer"><Input value={m.manufacturer} onChange={(e) => setM({ ...m, manufacturer: e.target.value })} /></Field>
      <Field label="Description"><TextArea value={m.description} onChange={(e) => setM({ ...m, description: e.target.value })} /></Field>
    </Confirm>
  );
}

function useLiveJointState(topic: string | null) {
  const [vals, setVals] = useState<Record<string, number> | null>(null);
  const [at, setAt] = useState(0);
  useEffect(() => {
    setVals(null);
    if (!topic) return;
    return rosSocket.subscribe(topic, 'sensor_msgs/msg/JointState', (m: any) => {
      const v: Record<string, number> = {};
      (m.name || []).forEach((n: string, i: number) => { v[n] = m.position[i]; });
      setVals(v); setAt(Date.now());
    }, 100);
  }, [topic]);
  return { vals, at };
}

function ModelTab({ robot }: { robot: any }) {
  const urdf = useLoad(async () => { const res = await fetch(files.robotAsset(robot.id, 'resolved.urdf'), { cache: 'no-store' }); if (!res.ok) throw new Error('The resolved URDF is not available yet; validate the robot first.'); return res.text(); }, [robot.id, robot.validation?.at]);
  const cfg = robot.config;
  const live = useLiveJointState(robot.connected && cfg ? fullTopic(cfg, cfg.joint_state_topic) : null);
  const liveUrdf = useMemo(() => {
    if (!live.vals || !cfg) return null;
    const o: Record<string, number> = {};
    cfg.joints.forEach((j: HwJoint) => { if (live.vals![j.ros_joint] !== undefined) o[j.urdf_joint] = toUrdf(j, live.vals![j.ros_joint]); });
    return o;
  }, [live.vals, cfg]);
  const meshMap = robot.validation?.summary?.mesh_map || {};
  const assetUrl = useMemo(() => (p: string) => files.robotAsset(robot.id, p), [robot.id]);
  if (urdf.error) return <Panel><ErrorState error={urdf.error} /></Panel>;
  if (!urdf.data) return <Panel><Loading /></Panel>;
  return (
    <div className="stack">
      <Panel title="3D model" sub="Drag to orbit, scroll to zoom. Sliders move the picture only."><UrdfScene urdf={urdf.data} meshMap={meshMap} assetUrl={assetUrl} live={liveUrdf} /></Panel>
      <div className="grid g2">
        <Panel title="Joints" flush><div className="table-wrap"><table className="table"><thead><tr><th>Joint</th><th>Type</th><th>Lower</th><th>Upper</th><th>Velocity</th><th>Effort</th></tr></thead>
          <tbody>{(robot.validation?.summary?.joint_list || []).map((j: any) => <tr key={j.name}><td className="mono small">{j.name}</td><td>{j.type}</td><td className="num">{fmt.sci(j.lower)}</td><td className="num">{fmt.sci(j.upper)}</td><td className="num">{fmt.sci(j.velocity)}</td><td className="num">{fmt.sci(j.effort)}</td></tr>)}</tbody></table></div></Panel>
        <Panel title="Files" flush><div className="list" style={{ maxHeight: 300, overflowY: 'auto' }}>{(robot.files || []).map((f: string) => <div key={f} className="list-item small mono">{f}</div>)}</div></Panel>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------ configuration
function ConfigTab({ robot, onSaved }: { robot: any; onSaved: (r: any) => void }) {
  const toast = useToast();
  const def = useLoad(() => trainer.robotDefaultConfig(robot.id), [robot.id], 0, !robot.config);
  const [cfg, setCfg] = useState<any>(robot.config);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!cfg && def.data?.config) setCfg(def.data.config); }, [def.data, cfg]);
  if (robot.state !== 'registered') return <Panel><Empty title="Register the robot first" /></Panel>;
  if (!cfg) return <Loading />;
  const set = (p: any) => setCfg({ ...cfg, ...p });
  const setJ = (i: number, p: any) => set({ joints: cfg.joints.map((j: any, n: number) => (n === i ? { ...j, ...p } : j)) });
  const issues: any[] = robot.config_issues || [];
  const save = async () => { setBusy(true); try { const r = await trainer.robotSaveConfig(robot.id, cfg); onSaved(r); toast.ok('Configuration saved'); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  return (
    <div className="stack" data-joint-map>
      <Callout tone="info">Configuration is separate from the URDF. Changing topics or joint names withdraws Stage 2+; changing mapping, safety or calibration withdraws Stage 3+.</Callout>
      {issues.length > 0 && <div className="stack-sm">{issues.map((i, n) => <Callout key={n} tone={i.level === 'error' ? 'danger' : 'warn'}>{i.text}</Callout>)}</div>}
      <div className="grid g2">
        <Panel title="ROS interface">
          <div className="grid g2">
            <Field label="ROS distro"><Input value={cfg.ros_distro} onChange={(e) => set({ ros_distro: e.target.value })} /></Field>
            <Field label="Namespace"><Input value={cfg.namespace} onChange={(e) => set({ namespace: e.target.value })} /></Field>
            <Field label="Joint state topic"><Input className="mono" value={cfg.joint_state_topic} onChange={(e) => set({ joint_state_topic: e.target.value })} /></Field>
            <Field label="Command interface"><Select value={cfg.command_interface} onChange={(v) => set({ command_interface: v })} options={['joint_trajectory', 'position_array']} /></Field>
            <Field label="Command topic"><Input className="mono" value={cfg.command_topic} onChange={(e) => set({ command_topic: e.target.value })} /></Field>
            <Field label="Leader topic (teleoperation)"><Input className="mono" value={cfg.leader_topic} onChange={(e) => set({ leader_topic: e.target.value })} /></Field>
            <Field label="Driver"><Input value={cfg.driver} onChange={(e) => set({ driver: e.target.value })} /></Field>
            <Field label="Control frequency Hz"><NumberInput value={cfg.control_frequency_hz} onChange={(v) => set({ control_frequency_hz: v })} /></Field>
          </div>
        </Panel>
        <div className="stack">
          <Panel title="Safety">
            <div className="grid g2">
              <Field label="Max velocity (rad/s or m/s)"><NumberInput value={cfg.safety?.max_velocity} step={0.05} onChange={(v) => set({ safety: { ...cfg.safety, max_velocity: v } })} /></Field>
              <Field label="Hardware test velocity"><NumberInput value={cfg.safety?.test_velocity} step={0.05} onChange={(v) => set({ safety: { ...cfg.safety, test_velocity: v } })} /></Field>
            </div>
            <div className="mt"><Switch checked={!!cfg.safety?.require_estop} onChange={(v) => set({ safety: { ...cfg.safety, require_estop: v } })} label="Require an emergency stop" /></div>
          </Panel>
          <Panel title="Calibration">
            <div className="stack">
              <Switch checked={!!cfg.calibration?.done} onChange={(v) => set({ calibration: { ...cfg.calibration, done: v } })} label="Calibration done" />
              <div className="grid g2"><Field label="Method"><Input value={cfg.calibration?.method || ''} onChange={(e) => set({ calibration: { ...cfg.calibration, method: e.target.value } })} /></Field>
                <Field label="Notes"><Input value={cfg.calibration?.notes || ''} onChange={(e) => set({ calibration: { ...cfg.calibration, notes: e.target.value } })} /></Field></div>
            </div>
          </Panel>
        </div>
      </div>
      <Panel title="Joint mapping" sub="URDF joint ↔ ROS joint, direction, offset, units and soft limits (URDF units)" flush>
        <div className="table-wrap"><table className="table"><thead><tr><th>URDF joint</th><th>ROS joint</th><th>Motor ID</th><th>Direction</th><th>Offset</th><th>Units</th><th>Soft lower</th><th>Soft upper</th><th>Enabled</th></tr></thead>
          <tbody>{cfg.joints.map((j: any, i: number) => (
            <tr key={j.urdf_joint}><td className="mono small">{j.urdf_joint}</td>
              <td><Input className="mono" value={j.ros_joint} onChange={(e) => setJ(i, { ros_joint: e.target.value })} style={{ height: 28, width: 120 }} /></td>
              <td><NumberInput value={j.motor_id} onChange={(v) => setJ(i, { motor_id: v })} style={{ height: 28, width: 70 }} /></td>
              <td><Select value={String(j.direction)} onChange={(v) => setJ(i, { direction: Number(v) })} options={[{ value: '1', label: '+1' }, { value: '-1', label: '−1' }]} style={{ height: 28, width: 70 }} /></td>
              <td><NumberInput value={j.offset} step={0.01} onChange={(v) => setJ(i, { offset: v ?? 0 })} style={{ height: 28, width: 80 }} /></td>
              <td><Select value={j.units} onChange={(v) => setJ(i, { units: v })} options={['rad', 'deg', 'm', 'mm']} style={{ height: 28, width: 76 }} /></td>
              <td><NumberInput value={j.soft_lower} step={0.01} onChange={(v) => setJ(i, { soft_lower: v })} style={{ height: 28, width: 80 }} /></td>
              <td><NumberInput value={j.soft_upper} step={0.01} onChange={(v) => setJ(i, { soft_upper: v })} style={{ height: 28, width: 80 }} /></td>
              <td><Check checked={!!j.enabled} onChange={(v) => setJ(i, { enabled: v })} /></td></tr>
          ))}</tbody></table></div>
      </Panel>
      <Panel title="Cameras" actions={<Button size="sm" icon={<I.plus />} onClick={() => set({ cameras: [...cfg.cameras, { name: '', topic: '', msg_type: 'sensor_msgs/msg/CompressedImage' }] })} data-action="add-camera">Add camera</Button>}>
        {!cfg.cameras.length ? <span className="small muted">No cameras. Training policies need at least one.</span> : <div className="stack">{cfg.cameras.map((c: any, i: number) => (
          <div key={i} className="row" style={{ alignItems: 'flex-end' }}>
            <Field label="Name"><Input value={c.name} onChange={(e) => set({ cameras: cfg.cameras.map((x: any, n: number) => (n === i ? { ...x, name: e.target.value } : x)) })} data-cam-name={i} /></Field>
            <Field label="Topic"><Input className="mono" value={c.topic} onChange={(e) => set({ cameras: cfg.cameras.map((x: any, n: number) => (n === i ? { ...x, topic: e.target.value } : x)) })} data-cam-topic={i} style={{ width: 300 }} /></Field>
            <Field label="Message type"><Select value={c.msg_type} onChange={(v) => set({ cameras: cfg.cameras.map((x: any, n: number) => (n === i ? { ...x, msg_type: v } : x)) })} options={['sensor_msgs/msg/CompressedImage', 'sensor_msgs/msg/Image']} /></Field>
            <Button variant="ghost" iconOnly icon={<I.trash />} onClick={() => set({ cameras: cfg.cameras.filter((_: any, n: number) => n !== i) })} />
          </div>
        ))}</div>}
      </Panel>
      <div className="row" style={{ justifyContent: 'flex-end' }}><Button onClick={() => setCfg(robot.config || def.data?.config)}>Discard</Button><Button variant="primary" busy={busy} onClick={save} data-action="save-config">Save configuration</Button></div>
    </div>
  );
}

// --------------------------------------------------------------------------- readiness
function ReadinessTab({ robot, refresh }: { robot: any; refresh: () => void }) {
  const toast = useToast();
  const rd = robot.readiness;
  if (!rd) return <Panel><Empty title="Register the robot to see its readiness" /></Panel>;
  return (
    <div className="stack">
      <Panel title="Readiness stages" sub="Each stage unlocks the next; changes withdraw stages automatically">
        <div className="stack">{rd.stages.map((s: any) => (
          <div key={s.n} className="row" style={{ alignItems: 'flex-start' }} data-stage-row={s.n} data-status={s.status}>
            <span className="badge" style={{ minWidth: 28, justifyContent: 'center', background: s.status === 'done' ? 'var(--ok-soft)' : undefined, color: s.status === 'done' ? 'var(--ok)' : undefined }}>{s.n}</span>
            <div className="grow"><div className="row"><b>{s.name}</b><StatusBadge status={s.status === 'done' ? 'ok' : s.status} />{s.verified_at && <span className="tiny muted">{fmt.time(s.verified_at)}</span>}</div>
              {s.blockers?.length ? <div className="tiny" style={{ color: 'var(--warn)' }}>{s.blockers.join(' ')}</div> : <div className="tiny muted">{s.unlocks}</div>}</div>
          </div>
        ))}</div>
      </Panel>
      <div className="grid g2">
        <RosCheck robot={robot} refresh={refresh} />
        <Panel title="Connection" sub="Live joint view and hardware test need the robot connected in PHYSIOS" actions={rd.allowed?.connect ? <Button size="sm" variant={robot.connected ? 'default' : 'primary'} onClick={() => trainer.robotAction(robot.id, 'connect', { connected: !robot.connected }).then(refresh, toast.error)} data-action="connect">{robot.connected ? 'Disconnect' : 'Connect'}</Button> : <Badge>Stage 2 needed</Badge>}>
          {robot.connected && robot.config ? <RobotLiveJoints robot={robot} /> : <span className="small muted">Not connected. Connecting only subscribes to the joint states; nothing is published.</span>}
        </Panel>
      </div>
      {robot.connected && <HardwareTest robot={robot} refresh={refresh} />}
      <DataCheck robot={robot} refresh={refresh} />
    </div>
  );
}

function RosCheck({ robot, refresh }: { robot: any; refresh: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<any>(robot.verifications?.ros_last || null);
  const cfg = robot.config;
  const run = async () => {
    setBusy(true);
    const ev: any = { collected_at: Date.now() / 1000, rosbridge: rosSocket.state === 'open', topics: {}, joint_state: { received: false }, cameras: {} };
    try {
      const t = await rosSocket.callService('/rosapi/topics', {}, 'rosapi_msgs/srv/Topics');
      (t.topics || []).forEach((n: string, i: number) => { ev.topics[n] = (t.types || [])[i]; });
      const listen = (name: string, type: string, ms: number, onMsg: (m: any) => void) => new Promise<void>((res) => { const off = rosSocket.subscribe(name, type, onMsg); setTimeout(() => { off(); res(); }, ms); });
      const stamps: number[] = []; let lastMsg: any = null;
      await listen(fullTopic(cfg, cfg.joint_state_topic), 'sensor_msgs/msg/JointState', 3000, (m) => { stamps.push(performance.now()); lastMsg = m; });
      if (lastMsg) {
        const positions: Record<string, number> = {};
        (lastMsg.name || []).forEach((n: string, i: number) => { positions[n] = lastMsg.position[i]; });
        ev.joint_state = { received: true, rate_hz: stamps.length > 1 ? ((stamps.length - 1) * 1000) / (stamps[stamps.length - 1] - stamps[0]) : 0, names: lastMsg.name || [], positions };
      }
      await Promise.all(cfg.cameras.map((c: any) => { const tp = fullTopic(cfg, c.topic); ev.cameras[tp] = { received: false }; return listen(tp, c.msg_type, 4000, () => { ev.cameras[tp].received = true; }); }));
    } catch (e) { toast.error(`ROS check: ${(e as Error).message}`); }
    try {
      const r = await trainer.robotVerifyRos(robot.id, ev);
      setLast({ ok: r.ok, checks: r.checks });
      r.ok ? toast.ok('Stage 2 verified') : toast.warn('ROS checks failed');
      refresh();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Panel title="Stage 2 · ROS checks" sub="Read-only: topic list, joint states for 3 s, each camera for 4 s" actions={<Button size="sm" variant="primary" busy={busy} disabled={!cfg} onClick={run} data-action="run-ros-checks">Run ROS checks</Button>}>
      {last ? <div className="stack-sm" data-ros-result={last.ok ? 'ok' : 'failed'}>{(last.checks || []).map((c: any, i: number) => <div key={i} className="row small" style={{ alignItems: 'flex-start' }}>{c.level === 'ok' ? <I.ok width={15} height={15} style={{ color: 'var(--ok)' }} /> : <I.alert width={15} height={15} style={{ color: c.level === 'error' ? 'var(--danger)' : 'var(--warn)' }} />}<span>{c.text}</span></div>)}</div> : <span className="small muted">{cfg ? 'Not run yet.' : 'Save a robot configuration first.'}</span>}
    </Panel>
  );
}

function RobotLiveJoints({ robot }: { robot: any }) {
  const cfg = robot.config;
  const live = useLiveJointState(fullTopic(cfg, cfg.joint_state_topic));
  const now = useNow(500);
  const stale = !live.at || now - live.at > 1000;
  return (
    <div className="stack-sm" data-live-joints>
      <div className="small text-2">Live joints {live.at ? (stale ? '· stale' : '· live') : '· waiting for data'}</div>
      {cfg.joints.map((j: HwJoint & { soft_lower: number; soft_upper: number }) => {
        const raw = live.vals?.[j.ros_joint];
        const u = raw === undefined ? null : toUrdf(j, raw);
        const lo = j.soft_lower ?? -Math.PI; const hi = j.soft_upper ?? Math.PI;
        const pct = u == null ? 0 : ((u - lo) / (hi - lo || 1)) * 100;
        return <div className="joint-bar" key={j.urdf_joint}><span className="mono">{j.urdf_joint}</span><div className="joint-track"><span style={{ left: `${Math.max(0, Math.min(100, pct))}%`, background: pct < 0 || pct > 100 ? 'var(--danger)' : undefined }} /></div><span className="mono num right">{u == null ? '—' : u.toFixed(3)}</span></div>;
      })}
    </div>
  );
}

function HardwareTest({ robot, refresh }: { robot: any; refresh: () => void }) {
  const toast = useToast();
  const cfg = robot.config;
  const enabled = (cfg?.joints || []).filter((j: any) => j.enabled);
  const [joint, setJoint] = useState(enabled[0]?.urdf_joint || '');
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [typed, setTyped] = useState('');
  const [auth, setAuth] = useState<any>(null);
  const [state, setState] = useState<'idle' | 'authorized' | 'running' | 'done'>('idle');
  const [prog, setProg] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const stop = useRef(false);
  const canAuth = HW_CHECKLIST.every(([k]) => checks[k]) && typed === robot.name && joint;
  const attempts: any[] = robot.verifications?.hardware_attempts || [];
  const locked = state === 'running' || state === 'authorized';
  const authorize = async () => { try { setAuth(await trainer.robotHwAuthorize(robot.id, joint, checks, typed)); setState('authorized'); setResult(null); } catch (e) { toast.error(e); } };
  const start = async () => {
    stop.current = false;
    setState('running');
    let res;
    try { res = await runHardwareTest({ joints: cfg.joints, plan: auth.plan, stop, onProgress: setProg }); } catch (e) { res = { outcome: 'aborted', reason: `Error: ${(e as Error).message}`, samples: [] }; }
    try {
      const r = await trainer.robotHwResult(robot.id, auth.token, res);
      setResult({ ...r, outcome: res.outcome, reason: res.reason });
      r.ok ? toast.ok('Stage 3 verified') : toast.warn('Hardware test did not pass');
    } catch (e) { toast.error(e); }
    setAuth(null); setState('done'); setChecks({}); setTyped(''); refresh();
  };
  return (
    <Panel title="Stage 3 · Supervised one-joint hardware test" data-hw-test={state}>
      <div className="grid g2">
        <div className="stack">
          <Callout tone="warn" title="This moves the real robot">One joint moves a small, server-capped distance toward the middle of its soft range, holds 1 s and returns. It stops on: STOP, joint state stale for 0.4 s, another joint moving, overshoot, timeout. The software STOP holds the current position; it is not an emergency stop.</Callout>
          <Field label="Joint to test"><Select value={joint} onChange={setJoint} disabled={locked} options={enabled.map((j: any) => ({ value: j.urdf_joint, label: `${j.urdf_joint} (${j.ros_joint})` }))} data-hw-joint /></Field>
          <div className="stack-sm">{HW_CHECKLIST.map(([k, text]) => <Check key={k} checked={!!checks[k]} disabled={locked} onChange={(v) => setChecks({ ...checks, [k]: v })} data-check-item={k}>{text}</Check>)}</div>
          <Field label={`Type "${robot.name}" to authorise motion`}><Input value={typed} disabled={locked} onChange={(e) => setTyped(e.target.value)} data-hw-name /></Field>
          {!locked && <Button variant="primary" disabled={!canAuth} onClick={authorize} data-action="hw-authorize">Authorise test</Button>}
        </div>
        <div className="stack">
          {auth && (
            <div className="panel" style={{ padding: 12, boxShadow: 'none' }} data-hw-plan>
              <b className="small">Authorised plan (valid {auth.expires_in_s} s, single use)</b>
              <KV items={[['Joint', `${auth.plan.joint} (${auth.plan.ros_joint}) · ${auth.plan.direction_rule || ''}`], ['Distance', `${auth.plan.amplitude?.toFixed(3)} ${auth.plan.type === 'prismatic' ? 'm' : 'rad'} at ${auth.plan.velocity?.toFixed(3)}/s`], ['Hold / timeout', `${auth.plan.hold_s} s / ${auth.plan.timeout_s} s`], ['Soft range', `${auth.plan.soft_lower?.toFixed(3)} … ${auth.plan.soft_upper?.toFixed(3)}`], ['Commands', `${auth.plan.command_topic} at ${auth.plan.rate_hz} Hz`]]} />
            </div>
          )}
          {state === 'authorized' && <div className="row"><Button variant="danger" onClick={start} data-action="hw-start">Start motion</Button><Button onClick={() => { setAuth(null); setState('idle'); }}>Cancel</Button></div>}
          {state === 'running' && (
            <div className="stack">
              <button className="estop" style={{ height: 64, fontSize: 20 }} onClick={() => { stop.current = true; }} data-action="hw-stop">STOP</button>
              {prog && <div className="mono small" data-hw-progress>t {prog.t.toFixed(1)} / {prog.total.toFixed(1)} s · cmd {prog.cmd?.toFixed(3)} · measured {prog.pos?.toFixed(3)}</div>}
            </div>
          )}
          {result && <Callout tone={result.ok ? 'ok' : 'danger'} title={result.ok ? 'Hardware test passed — Stage 3 verified' : 'Hardware test did not pass'}><div data-hw-result={result.ok ? 'ok' : 'failed'}>{result.ok && <div>The joint moved the commanded distance, returned, and no other joint moved.</div>}{result.reason && <div>{result.reason}</div>}{(result.reasons || []).map((x: string) => <div key={x}>{x}</div>)}</div></Callout>}
          {attempts.length > 0 && <div className="stack-sm tiny"><span className="label">Previous attempts</span>{attempts.slice().reverse().slice(0, 5).map((a, i) => <div key={i} className="row"><Badge tone={a.ok ? 'ok' : 'danger'}>{a.ok ? 'passed' : 'failed'}</Badge><span className="mono">{a.joint}</span><span className="muted ellipsis">{fmt.time(a.at)} {a.reasons?.[0] || a.reason || ''}</span></div>)}</div>}
        </div>
      </div>
    </Panel>
  );
}

function DataCheck({ robot, refresh }: { robot: any; refresh: () => void }) {
  const toast = useToast();
  const ds = useLoad(() => trainer.datasets(), []);
  const [policy, setPolicy] = useState('smolvla');
  const [dsId, setDsId] = useState('');
  const [res, setRes] = useState<any>(null);
  const [yaml, setYaml] = useState<any>(null);
  const allowed = robot.readiness?.allowed || {};
  return (
    <div className="grid g2">
      <Panel title="Stage 4 · Data & training compatibility" actions={<Button size="sm" variant="primary" onClick={async () => { try { const r = await trainer.robotVerifyData(robot.id, policy, dsId || undefined); setRes(r); r.ok && toast.ok('Stage 4 verified'); refresh(); } catch (e) { toast.error(e); } }} data-action="run-data-check">Check compatibility</Button>}>
        <div className="stack">
          <div className="grid g2"><Field label="Policy"><Select value={policy} onChange={setPolicy} options={['smolvla', 'act', 'diffusion', 'pi0']} /></Field>
            <Field label="Dataset (optional)"><Select value={dsId} onChange={setDsId} options={(ds.data?.datasets || []).map((d: any) => d.id)} placeholder="Layout only" /></Field></div>
          {res && <div className="stack-sm" data-data-result={res.ok ? 'ok' : 'failed'}>{(res.checks || []).map((c: any, i: number) => <div key={i} className="row small">{c.level === 'ok' ? <I.ok width={15} height={15} style={{ color: 'var(--ok)' }} /> : <I.alert width={15} height={15} style={{ color: c.level === 'error' ? 'var(--danger)' : 'var(--warn)' }} />}<span>{c.text}</span></div>)}</div>}
        </div>
      </Panel>
      <Panel title="Server configuration" sub="physical_ai_server reads one config per robot type" actions={<Button size="sm" disabled={!allowed.export_server_config && robot.stage < 3} onClick={() => trainer.robotServerConfig(robot.id).then(setYaml, toast.error)} data-action="export-server-config">Export</Button>}>
        {yaml ? (
          <div className="stack">
            <CodeBlock text={yaml.yaml} className="log" />
            <div className="tiny muted">{yaml.install || `Install as ${yaml.filename} in the physical_ai_server config folder and restart the bringup. PHYSIOS does not install it for you.`}</div>
            <Button size="sm" icon={<I.download />} onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([yaml.yaml], { type: 'text/yaml' })); a.download = yaml.filename; a.click(); }}>Download {yaml.filename}</Button>
            <div data-server-yaml style={{ display: 'none' }}>{yaml.yaml}</div>
          </div>
        ) : <span className="small muted">{allowed.export_server_config ? 'Press Export to generate the file.' : 'Available from Stage 3 (hardware verified).'}</span>}
      </Panel>
    </div>
  );
}
