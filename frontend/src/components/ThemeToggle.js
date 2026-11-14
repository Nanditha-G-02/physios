import React, { useEffect, useState } from 'react';
import clsx from 'clsx';

// Light / dark theme switch. The choice is kept in this browser (localStorage) and applied as
// <html class="dark">; public/index.html applies it before the first paint, so a reload in
// dark mode does not flash light. Only colours change: no layout or behaviour.
const KEY = 'rawbot.theme';

export function readTheme() {
  try {
    return window.localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch (e) {
    return 'light';
  }
}

export function applyTheme(theme, animate) {
  const el = document.documentElement;
  if (animate) {
    el.classList.add('theme-anim');
    window.clearTimeout(applyTheme.t);
    applyTheme.t = window.setTimeout(() => el.classList.remove('theme-anim'), 450);
  }
  el.classList.toggle('dark', theme === 'dark');
  try {
    window.localStorage.setItem(KEY, theme);
  } catch (e) {
    /* private window or blocked storage: the theme still applies for this visit */
  }
  window.dispatchEvent(new CustomEvent('rawbot-theme', { detail: theme }));
}

export function useTheme() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const on = (e) => setTheme(e.detail);
    window.addEventListener('rawbot-theme', on);
    return () => window.removeEventListener('rawbot-theme', on);
  }, []);
  return theme;
}

const Sun = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const Moon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </svg>
);

export default function ThemeToggle() {
  const theme = useTheme();
  const seg = (value, label, Icon) => (
    <button
      type="button"
      onClick={() => theme !== value && applyTheme(value, true)}
      aria-pressed={theme === value}
      aria-label={`${label} mode`}
      title={`${label} mode`}
      data-theme-option={value}
      className={clsx(
        'flex h-[24px] flex-1 items-center justify-center rounded-full transition-colors duration-200',
        theme === value ? 'bg-ink text-white shadow-lift' : 'text-ink-3 hover:text-ink'
      )}
    >
      <Icon />
    </button>
  );
  return (
    <div className="mx-1.5 mb-1.5 flex gap-0.5 rounded-full bg-paper p-[3px]" role="group" aria-label="Theme">
      {seg('light', 'Light', Sun)}
      {seg('dark', 'Dark', Moon)}
    </div>
  );
}
