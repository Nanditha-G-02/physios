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

// Shared Blueprint UI primitives used by every session.

import React, { useEffect } from 'react';
import clsx from 'clsx';

export function Sheet({ title, code, actions, children, className, bodyClassName, soft }) {
  return (
    <section className={clsx(soft ? 'sheet-soft' : 'sheet', 'animate-rise min-w-0', className)}>
      {(title || actions) && (
        <header className="sheet-head">
          <div className="flex items-center gap-2 min-w-0">
            {code && <span className="font-mono text-[10px] text-ink-4">{code}</span>}
            <h2 className="sheet-title truncate">{title}</h2>
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
      )}
      <div className={clsx('px-4 pb-4 pt-0.5', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Label({ children, className, htmlFor }) {
  return (
    <label htmlFor={htmlFor} className={clsx('label block mb-1', className)}>
      {children}
    </label>
  );
}

export function Field({ label, hint, error, children, className }) {
  return (
    <div className={clsx('flex flex-col', className)}>
      {label && <Label>{label}</Label>}
      {children}
      {error ? (
        <p className="mt-1 text-[11.5px] text-signal-err">{error}</p>
      ) : (
        hint && <p className="mt-1 text-[11.5px] text-ink-3">{hint}</p>
      )}
    </div>
  );
}

export function TextInput({ value, onChange, className, ...rest }) {
  return (
    <input
      className={clsx('input', className)}
      value={value ?? ''}
      onChange={(e) => onChange && onChange(e.target.value)}
      {...rest}
    />
  );
}

export function NumberInput({ value, onChange, min, max, step = 1, className, suffix, ...rest }) {
  return (
    <div className={clsx('flex items-stretch', className)}>
      <input
        type="number"
        className={clsx('input num', suffix && 'rounded-r-none')}
        value={value ?? ''}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = e.target.value === '' ? '' : Number(e.target.value);
          if (onChange) onChange(v);
        }}
        {...rest}
      />
      {suffix && (
        <span className="-ml-px rounded-r-xl border border-rule bg-paper-2 px-2.5 flex items-center text-[11px] text-ink-3">
          {suffix}
        </span>
      )}
    </div>
  );
}

export function Select({ value, onChange, options, className, ...rest }) {
  return (
    <select
      className={clsx('input pr-7', className)}
      value={value ?? ''}
      onChange={(e) => onChange && onChange(e.target.value)}
      {...rest}
    >
      {options.map((o) =>
        typeof o === 'string' ? (
          <option key={o} value={o}>
            {o}
          </option>
        ) : (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        )
      )}
    </select>
  );
}

export function Toggle({ checked, onChange, label, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      disabled={disabled}
      onClick={() => onChange && onChange(!checked)}
      className="inline-flex items-center gap-2 text-[12.5px] disabled:opacity-50"
    >
      <span
        className={clsx(
          'relative h-[18px] w-[32px] rounded-pill transition-colors duration-300',
          checked ? 'bg-ink' : 'bg-paper-3'
        )}
      >
        <span
          className={clsx(
            'absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-all duration-300',
            checked ? 'left-[16px]' : 'left-[2px]'
          )}
        />
      </span>
      {label}
    </button>
  );
}

export function Segmented({ value, onChange, options, size = 'md', className }) {
  return (
    <div className={clsx('inline-flex rounded-pill bg-paper-2 p-[3px]', className)} role="tablist">
      {options.map((o, i) => {
        const v = typeof o === 'string' ? o : o.value;
        const l = typeof o === 'string' ? o : o.label;
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={o.disabled}
            onClick={() => onChange && onChange(v)}
            className={clsx(
              'rounded-pill font-medium transition-all duration-200 disabled:opacity-40',
              size === 'sm' ? 'px-2.5 py-1 text-[11.5px]' : 'px-3.5 py-1 text-[12.5px]',
              active ? 'bg-ink text-white shadow-sm' : 'text-ink-2 hover:text-ink'
            )}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

export function Stat({ label, value, sub, tone, className }) {
  return (
    <div className={clsx('rounded-xl bg-white shadow-card px-3.5 py-2.5', className)}>
      <div className="label">{label}</div>
      <div
        className={clsx(
          'text-[24px] font-light tracking-tight leading-tight mt-0.5 tabular-nums',
          tone === 'ok' && 'text-signal-ok',
          tone === 'warn' && 'text-signal-warn',
          tone === 'err' && 'text-signal-err',
          tone === 'sky' && 'text-sky-ink'
        )}
      >
        {value}
      </div>
      {sub && <div className="text-[11px] text-ink-3 mt-0.5">{sub}</div>}
    </div>
  );
}

export function StatusDot({ tone = 'idle', pulse, label, className }) {
  const color = {
    ok: 'bg-signal-ok',
    warn: 'bg-signal-warn',
    err: 'bg-signal-err',
    sky: 'bg-sky-ink',
    idle: 'bg-ink-4',
  }[tone];
  return (
    <span className={clsx('inline-flex items-center gap-2', className)}>
      <span className={clsx('h-2 w-2 rounded-full', color, pulse && 'animate-pulsedot')} />
      {label && <span className="text-[12.5px]">{label}</span>}
    </span>
  );
}

export function ProgressBar({ value = 0, total = 100, tone = 'ink', className, showText }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <div className="relative h-2 flex-1 overflow-hidden rounded-pill bg-paper-3">
        <div
          className={clsx(
            'absolute inset-y-0 left-0 rounded-pill transition-all duration-500',
            tone === 'sky' ? 'bg-sky-ink' : tone === 'ok' ? 'bg-signal-ok' : 'bg-ink'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showText && <span className="num text-[11px] text-ink-3 w-10 text-right">{pct.toFixed(0)}%</span>}
    </div>
  );
}

export function Empty({ title, children, action, className }) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center text-center gap-2 p-10 rounded-card border border-dashed border-paper-3 bg-white/50',
        className
      )}
    >
      <div className="text-[15px] font-semibold">{title}</div>
      {children && <div className="text-[13px] text-ink-3 max-w-md">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Modal({ open, title, onClose, children, footer, width = 'max-w-lg' }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/25 backdrop-blur-[2px] p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose && onClose()}
    >
      <div className={clsx('sheet shadow-lift w-full animate-rise', width)} role="dialog" aria-label={title}>
        <header className="sheet-head">
          <h2 className="sheet-title">{title}</h2>
          <button className="btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="px-5 pb-3 max-h-[70vh] overflow-auto scroll-thin">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 px-5 pb-5 pt-2">{footer}</footer>
        )}
      </div>
    </div>
  );
}

export function Callout({ tone = 'info', title, children, className, action }) {
  return (
    <div
      className={clsx(
        'rounded-2xl px-4 py-3 text-[12.5px] flex gap-3 items-start',
        tone === 'err' && 'bg-signal-errbg',
        tone === 'warn' && 'bg-signal-warnbg',
        tone === 'ok' && 'bg-signal-okbg',
        tone === 'info' && 'bg-sky-50',
        className
      )}
    >
      <div className="flex-1 min-w-0">
        {title && <div className="font-semibold mb-0.5">{title}</div>}
        <div className="text-ink-2">{children}</div>
      </div>
      {action}
    </div>
  );
}

export function KeyValue({ rows, className }) {
  return (
    <dl className={clsx('grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]', className)}>
      {rows
        .filter(Boolean)
        .map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="label pt-[2px]">{k}</dt>
            <dd className="min-w-0 break-words">{v ?? '—'}</dd>
          </React.Fragment>
        ))}
    </dl>
  );
}

export function Spinner({ className }) {
  return (
    <span
      className={clsx(
        'inline-block h-3.5 w-3.5 animate-spin border-2 border-current border-t-transparent rounded-full',
        className
      )}
    />
  );
}

export function formatBytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function formatDuration(s) {
  if (s == null || Number.isNaN(s)) return '—';
  const sec = Math.round(Number(s));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const r = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${r}s`;
}
