// PHYSIOS component library. Presentation only: no data fetching in here.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { I } from './icons';

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

// --------------------------------------------------------------------------- layout
export function Panel(props: {
  title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode; flush?: boolean;
  footer?: ReactNode; className?: string; icon?: ReactNode; id?: string; 'data-testid'?: string;
}) {
  return (
    <section className={cx('panel', props.className)} id={props.id} data-testid={props['data-testid']}>
      {(props.title || props.actions) && (
        <header className="panel-head">
          {props.icon}
          <div className="grow">
            {props.title && <h2>{props.title}</h2>}
            {props.sub && <div className="sub">{props.sub}</div>}
          </div>
          {props.actions && <div className="row">{props.actions}</div>}
        </header>
      )}
      <div className={cx('panel-body', props.flush && 'flush')}>{props.children}</div>
      {props.footer && <footer className="panel-foot">{props.footer}</footer>}
    </section>
  );
}

export function Stat({ label, value, unit, foot, tone, tip }: {
  label: ReactNode; value: ReactNode; unit?: string; foot?: ReactNode; tone?: Tone; tip?: string;
}) {
  return (
    <div className="panel stat" data-tip={tip}>
      <div className="row-between"><span className="label">{label}</span>{tone && <Dot tone={tone} />}</div>
      <div className="stat-value">{value}{unit && <small>{unit}</small>}</div>
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );
}

// --------------------------------------------------------------------------- status
export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'neutral';
export function toneOf(status?: string | null): Tone {
  switch ((status || '').toLowerCase()) {
    case 'ok': case 'succeeded': case 'success': case 'done': case 'validated': case 'accepted':
    case 'approved': case 'ready': case 'connected': case 'healthy': case 'pass': case 'passed':
      return 'ok';
    case 'warn': case 'warning': case 'degraded': case 'needs_review': case 'paused': case 'queued':
    case 'stopped': case 'draft': case 'pending': case 'unknown': case 'held':
      return 'warn';
    case 'down': case 'error': case 'failed': case 'rejected': case 'blocked': case 'crashed':
    case 'estopped': case 'fail':
      return 'danger';
    case 'running': case 'training': case 'recording': case 'active': case 'loading': case 'starting':
      return 'info';
    default: return 'neutral';
  }
}
export function Dot({ tone = 'neutral', pulse }: { tone?: Tone; pulse?: boolean }) {
  const cls = tone === 'ok' ? 'dot-ok' : tone === 'warn' ? 'dot-warn' : tone === 'danger' ? 'dot-danger' : '';
  return <span className={cx('dot', cls, pulse && 'dot-pulse')} />;
}
export function Badge({ tone = 'neutral', children, dot, title }: { tone?: Tone; children: ReactNode; dot?: boolean; title?: string }) {
  const cls = { ok: 'badge-ok', warn: 'badge-warn', danger: 'badge-danger', info: 'badge-info', accent: 'badge-accent', neutral: '' }[tone];
  return <span className={cx('badge', cls)} title={title}>{dot && <Dot tone={tone} />}{children}</span>;
}
export function StatusBadge({ status }: { status?: string | null }) {
  return <Badge tone={toneOf(status)} dot>{(status || 'unknown').replace(/_/g, ' ')}</Badge>;
}

export function Callout({ tone = 'info', title, children, action }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'danger' ? I.alert : tone === 'warn' ? I.alert : tone === 'ok' ? I.ok : I.info;
  return (
    <div className={cx('callout', `callout-${tone}`)} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon />
      <div className="grow">
        {title && <div className="callout-title">{title}</div>}
        {children && <div className="text-2">{children}</div>}
      </div>
      {action}
    </div>
  );
}

// --------------------------------------------------------------------------- states
export function Loading({ label = 'Loading…', rows = 0 }: { label?: string; rows?: number }) {
  if (rows) return <div className="stack">{Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton" style={{ height: 34 }} />)}</div>;
  return <div className="state"><div className="spinner" /><p>{label}</p></div>;
}
export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return <div className="state">{icon || <I.layers />}<h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}
export function ErrorState({ error, onRetry, title = 'Could not load this' }: { error: unknown; onRetry?: () => void; title?: string }) {
  const e = error as { message?: string; hint?: string; code?: string };
  const offline = e?.code === 'ros_unavailable' || e?.code === 'ros_service_missing' || e?.code === 'trainer_unavailable' || e?.code === 'network';
  return (
    <div className="state" role="alert">
      {offline ? <I.link /> : <I.alert />}
      <h3>{offline ? 'Service disconnected' : title}</h3>
      <p>{e?.message || String(error)}</p>
      {e?.hint && <p className="muted small">{e.hint}</p>}
      {onRetry && <Button size="sm" onClick={onRetry} icon={<I.refresh />}>Retry</Button>}
    </div>
  );
}

// --------------------------------------------------------------------------- controls
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost'; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode; busy?: boolean; iconOnly?: boolean;
};
export function Button({ variant = 'default', size = 'md', icon, busy, iconOnly, className, children, disabled, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      className={cx('btn', variant !== 'default' && `btn-${variant}`, size !== 'md' && `btn-${size}`, iconOnly && 'btn-icon', className)}
      disabled={disabled || busy}
      {...rest}
    >
      {busy ? <span className="spinner" /> : icon}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children, tip }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; tip?: string }) {
  return (
    <label className="field">
      {label && <span className="field-label">{label}{tip && <span className="muted" data-tip={tip}><I.info width={13} height={13} /></span>}</span>}
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx('input', props.className)} />;
}
export function NumberInput({ value, onChange, ...rest }: { value: number | string | null | undefined; onChange: (v: number | null) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <input
      {...rest}
      type="number"
      className={cx('input', 'num', rest.className)}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    />
  );
}
export function Select({ options, value, onChange, placeholder, ...rest }: {
  options: { value: string; label: string; disabled?: boolean }[] | string[]; value: string | undefined | null;
  onChange: (v: string) => void; placeholder?: string;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'>) {
  const opts = (options as (string | { value: string; label: string; disabled?: boolean })[]).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  return (
    <select {...rest} className={cx('select', rest.className)} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {opts.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
    </select>
  );
}
export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx('textarea', props.className)} />;
}
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <span className="row" style={{ gap: 9 }}>
      <button type="button" role="switch" aria-checked={checked} className="switch" disabled={disabled} onClick={() => onChange(!checked)} />
      {label && <span className="small text-2">{label}</span>}
    </span>
  );
}
export function Check({ checked, onChange, children, ...rest }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'checked'>) {
  return <label className="check"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} {...rest} />{children}</label>;
}
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group">
      {options.map((o) => <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}
export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { id: T; label: ReactNode; badge?: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" className="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}>{t.label}{t.badge}</button>
      ))}
    </div>
  );
}
export function Progress({ value, max = 100, tone }: { value: number; max?: number; tone?: 'warn' | 'danger' }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return <div className={cx('progress', tone)} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>;
}
export function Meter({ label, value, max, format, warnAt = 0.8, dangerAt = 0.92 }: { label: ReactNode; value: number | null | undefined; max: number | null | undefined; format: (v: number) => string; warnAt?: number; dangerAt?: number }) {
  if (value == null || !max) return <div className="meter"><div className="meter-top"><span className="text-2">{label}</span><span className="muted">n/a</span></div><Progress value={0} /></div>;
  const r = value / max;
  return (
    <div className="meter">
      <div className="meter-top"><span className="text-2">{label}</span><span className="num">{format(value)} <span className="muted">/ {format(max)}</span></span></div>
      <Progress value={value} max={max} tone={r >= dangerAt ? 'danger' : r >= warnAt ? 'warn' : undefined} />
    </div>
  );
}
export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return <dl className="kv">{items.map(([k, v], i) => <FragmentKV key={i} k={k} v={v} />)}</dl>;
}
function FragmentKV({ k, v }: { k: ReactNode; v: ReactNode }) {
  return <><dt>{k}</dt><dd>{v ?? <span className="muted">—</span>}</dd></>;
}
export function CodeBlock({ text, className }: { text: string; className?: string }) {
  const toast = useToast();
  return (
    <div style={{ position: 'relative' }}>
      <pre className={cx('code', className)}>{text}</pre>
      <Button size="sm" variant="ghost" iconOnly title="Copy" style={{ position: 'absolute', top: 4, right: 4 }}
        onClick={() => navigator.clipboard?.writeText(text).then(() => toast.ok('Copied'), () => toast.warn('Clipboard not available'))} icon={<I.copy />} />
    </div>
  );
}

// --------------------------------------------------------------------------- modal
export function Modal({ open, onClose, title, children, footer, wide, icon }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; icon?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'wide')} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="modal-head">{icon}<h2 className="grow">{title}</h2><Button variant="ghost" size="sm" iconOnly onClick={onClose} icon={<I.x />} aria-label="Close" /></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Confirmation dialog. `typeToConfirm` requires the operator to type a word (for deletes
 *  and anything that moves the robot). */
export function Confirm({ open, onClose, onConfirm, title, children, confirmLabel = 'Confirm', danger, typeToConfirm, busy, checks, disabled }: {
  open: boolean; onClose: () => void; onConfirm: () => void; title: ReactNode; children?: ReactNode; confirmLabel?: string;
  danger?: boolean; typeToConfirm?: string; busy?: boolean; checks?: string[]; disabled?: boolean;
}) {
  const [typed, setTyped] = useState('');
  const [ticked, setTicked] = useState<boolean[]>([]);
  useEffect(() => { if (open) { setTyped(''); setTicked((checks || []).map(() => false)); } }, [open, checks]);
  const ok = !disabled && (!typeToConfirm || typed.trim() === typeToConfirm) && ticked.every(Boolean);
  return (
    <Modal open={open} onClose={onClose} title={title} icon={danger ? <span style={{ color: 'var(--danger)' }}><I.alert width={20} height={20} /></span> : undefined}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} disabled={!ok} busy={busy} onClick={onConfirm} data-action="confirm">{confirmLabel}</Button></>}>
      <div className="stack">
        {children}
        {checks && checks.length > 0 && (
          <div className="stack-sm">{checks.map((c, i) => (
            <Check key={c} checked={!!ticked[i]} onChange={(v) => setTicked((t) => t.map((x, j) => (j === i ? v : x)))} data-check={i}>{c}</Check>
          ))}</div>
        )}
        {typeToConfirm && (
          <Field label={<>Type <code>{typeToConfirm}</code> to confirm</>}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus data-confirm-input />
          </Field>
        )}
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------------------- toasts
type ToastT = { id: number; tone: 'ok' | 'warn' | 'danger' | 'info'; text: ReactNode };
const ToastCtx = createContext<{ push: (tone: ToastT['tone'], text: ReactNode) => void } | null>(null);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastT[]>([]);
  const n = useRef(0);
  const push = useCallback((tone: ToastT['tone'], text: ReactNode) => {
    const id = ++n.current;
    setItems((x) => [...x.slice(-4), { id, tone, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'danger' ? 9000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => {
          const Icon = t.tone === 'ok' ? I.ok : t.tone === 'info' ? I.info : I.alert;
          return <div key={t.id} className={`toast toast-${t.tone}`}><Icon /><div className="grow">{t.text}</div></div>;
        })}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast() {
  const c = useContext(ToastCtx);
  const push = c?.push || (() => {});
  return {
    ok: (t: ReactNode) => push('ok', t),
    warn: (t: ReactNode) => push('warn', t),
    error: (t: unknown) => push('danger', (t as { message?: string })?.message || String(t)),
    info: (t: ReactNode) => push('info', t),
  };
}

// --------------------------------------------------------------------------- format
export const fmt = {
  bytes(n?: number | null) {
    if (n == null || !isFinite(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
  },
  num(n?: number | null, d = 0) { return n == null || !isFinite(n) ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 }); },
  pct(n?: number | null) { return n == null ? '—' : `${n.toFixed(0)}%`; },
  sci(n?: number | null) { if (n == null || !isFinite(n)) return '—'; const a = Math.abs(n); return a !== 0 && (a < 1e-3 || a >= 1e5) ? n.toExponential(2) : n.toPrecision(4).replace(/\.?0+$/, ''); },
  dur(s?: number | null) {
    if (s == null || !isFinite(s)) return '—';
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
    return h ? `${h}h ${m}m` : m ? `${m}m ${r}s` : `${r}s`;
  },
  ago(t?: number | string | null) {
    if (!t) return '—';
    const ms = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
    if (!isFinite(ms)) return '—';
    const s = (Date.now() - ms) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ms).toLocaleDateString();
  },
  time(t?: number | string | null) {
    if (!t) return '—';
    const ms = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
    return isFinite(ms) ? new Date(ms).toLocaleString() : '—';
  },
};
