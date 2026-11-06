// PHYSIOS icon set: 24px stroke icons drawn for this application.
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = (d: React.ReactNode) =>
  function Icon(props: P) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
        {d}
      </svg>
    );
  };

export const I = {
  dashboard: base(<><rect x="3" y="3" width="7.5" height="9" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="5" rx="1.5" /><rect x="13.5" y="11" width="7.5" height="10" rx="1.5" /><rect x="3" y="15" width="7.5" height="6" rx="1.5" /></>),
  planning: base(<><path d="M4 5h10M4 12h7M4 19h10" /><circle cx="18" cy="5" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="18" cy="19" r="2" /></>),
  record: base(<><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /><circle cx="9.5" cy="12" r="2.2" fill="currentColor" stroke="none" /></>),
  datasets: base(<><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" /><path d="M4.5 5.5v6.5c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V5.5" /><path d="M4.5 12v6.5c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V12" /></>),
  training: base(<><path d="M3 20h18" /><path d="M5 16l4-5 3 3 6-8" /><path d="M15 6h3v3" /></>),
  optimize: base(<><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2.2" /><circle cx="9" cy="17" r="2.2" /><path d="M4 12h5M13 12h7" /><circle cx="11" cy="12" r="2.2" /></>),
  robot: base(<><path d="M6 21h12" /><path d="M9 21v-3h6v3" /><path d="M12 18v-5" /><circle cx="12" cy="11" r="2" /><path d="m13.5 9.6 3.8-3.8" /><circle cx="18.3" cy="4.8" r="1.6" /><path d="M10.4 9.8 6.5 7.5" /></>),
  evaluation: base(<><path d="M9 4h6l1 3H8l1-3Z" /><rect x="5" y="6" width="14" height="15" rx="2" /><path d="m9 14 2 2 4-4" /></>),
  inference: base(<><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></>),
  rollout: base(<><path d="M12 3v4M12 17v4" /><circle cx="12" cy="12" r="5" /><path d="m10.5 10 4 2-4 2v-4Z" fill="currentColor" stroke="none" /></>),
  settings: base(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>),
  bell: base(<><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></>),
  sun: base(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>),
  moon: base(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />),
  menu: base(<path d="M4 6h16M4 12h16M4 18h16" />),
  plus: base(<path d="M12 5v14M5 12h14" />),
  check: base(<path d="m5 12 5 5L20 7" />),
  x: base(<path d="M6 6l12 12M18 6 6 18" />),
  alert: base(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>),
  info: base(<><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></>),
  ok: base(<><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>),
  stop: base(<rect x="6" y="6" width="12" height="12" rx="2" />),
  play: base(<path d="M7 5v14l11-7L7 5Z" />),
  pause: base(<path d="M8 5v14M16 5v14" />),
  refresh: base(<><path d="M20 11a8 8 0 0 0-14.8-4M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4" /></>),
  trash: base(<><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14" /></>),
  copy: base(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></>),
  edit: base(<path d="M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4" />),
  download: base(<path d="M12 4v11M7 10l5 5 5-5M4 20h16" />),
  upload: base(<path d="M12 20V9M7 14l5-5 5 5M4 4h16" />),
  chevron: base(<path d="m9 6 6 6-6 6" />),
  back: base(<path d="M15 6 9 12l6 6" />),
  camera: base(<><path d="M4 8h3l2-3h6l2 3h3v11H4V8Z" /><circle cx="12" cy="13" r="3.5" /></>),
  cpu: base(<><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></>),
  gpu: base(<><rect x="2" y="7" width="20" height="11" rx="2" /><circle cx="8" cy="12.5" r="2.5" /><circle cx="16" cy="12.5" r="2.5" /><path d="M5 18v3M10 18v3" /></>),
  disk: base(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 14h18M7 17h.01M11 17h.01" /></>),
  memory: base(<><rect x="3" y="7" width="18" height="10" rx="1.5" /><path d="M7 7v10M11 7v10M15 7v10M3 20h18M5 17v3M19 17v3" /></>),
  link: base(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>),
  flag: base(<path d="M5 21V4M5 4h11l-2 4 2 4H5" />),
  target: base(<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" fill="currentColor" /></>),
  shield: base(<><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></>),
  layers: base(<><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></>),
  clock: base(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  external: base(<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />),
  cube: base(<><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></>),
  wave: base(<path d="M2 12h3l3-7 4 14 3-9 2 4h5" />),
};

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="pg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-2)" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="15" fill="var(--surface-3)" stroke="var(--line-strong)" />
      <path d="M20 47V17h14a10.5 10.5 0 0 1 0 21H26" fill="none" stroke="url(#pg)" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="45" cy="45" r="4.2" fill="var(--accent-2)" />
    </svg>
  );
}
