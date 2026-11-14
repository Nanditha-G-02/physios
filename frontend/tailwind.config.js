/** @type {import('tailwindcss').Config} */
// Black, white and blue theme: one blue scale (brand blue #2457E6 at 600) used for every
// accent palette, so stray indigo/violet/purple/cyan/teal styles render as the same blue.
//
// Light and dark themes: neutral and tint colours are CSS variables (src/theme.css). The light
// values are the original colours; <html class="dark"> switches them. Strong fills that carry
// white text (blue/gray 400 and up, signal colours) keep the same colour in both themes.
const v = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;
const BLUE = Object.fromEntries(
  [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((k) => [k, v('blue-' + k)])
);
const BLUE_BG = {
  ...BLUE, 400: '#7AA2FF', 500: '#4F7BFF', 600: '#2457E6', 700: '#1D47C2', 800: '#193A9C',
  900: '#172F75', 950: '#0F1D4A',
};
const GRAY = Object.fromEntries(
  [50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((k) => [k, v('gray-' + k)])
);
const GRAY_BG = {
  ...GRAY, 400: '#9CA3AF', 500: '#6B7280', 600: '#4B5563', 700: '#374151', 800: '#1F2937',
  900: '#111827',
};
const PALETTES = ['blue', 'indigo', 'violet', 'purple', 'cyan', 'teal'];
// status palettes of the older panels: tints switch with the theme, strong fills (400+) stay
const STATUS = ['green', 'red', 'yellow', 'orange', 'amber', 'emerald'];
const STATUS_FIXED = {
  green: ['4ade80', '22c55e', '16a34a', '15803d', '166534', '14532d'],
  red: ['f87171', 'ef4444', 'dc2626', 'b91c1c', '991b1b', '7f1d1d'],
  yellow: ['facc15', 'eab308', 'ca8a04', 'a16207', '854d0e', '713f12'],
  orange: ['fb923c', 'f97316', 'ea580c', 'c2410c', '9a3412', '7c2d12'],
  amber: ['fbbf24', 'f59e0b', 'd97706', 'b45309', '92400e', '78350f'],
  emerald: ['34d399', '10b981', '059669', '047857', '065f46', '064e3b'],
};
const statusText = (p) => Object.fromEntries(
  [50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((k) => [k, v(`${p}-${k}`)])
);
const statusBg = (p) => ({
  ...statusText(p),
  ...Object.fromEntries([400, 500, 600, 700, 800, 900].map((k, i) => [k, '#' + STATUS_FIXED[p][i]])),
});
const SIGNAL = {
  ok: v('ok'), okbg: v('okbg'), warn: v('warn'), warnbg: v('warnbg'), err: v('err'), errbg: v('errbg'),
};
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // Design tokens (v2.2, after the operator's reference: soft grey canvas, white
      // rounded cards, black capsules, fading grey type, electric-blue accent).
      // Token names are kept from v2 so every page follows the new values.
      // v2.3 (compact professional): same palette family, slightly cooler neutrals and
      // crisper hairlines; sizes are tuned for a 14 px root (see index.css).
      colors: {
        paper: { DEFAULT: v('paper'), 2: v('paper-2'), 3: v('paper-3') },
        ink: { DEFAULT: v('ink'), 2: v('ink-2'), 3: v('ink-3'), 4: v('ink-4') },
        rule: { DEFAULT: v('rule'), strong: v('rule-strong') },
        sky: { DEFAULT: v('sky'), 50: v('sky-50'), 100: v('sky-100'), ink: v('sky-ink') },
        night: { DEFAULT: '#070B16', 2: '#0E1526', 3: '#16203A', glow: '#3D7BFF' },
        gray: GRAY,
        ...Object.fromEntries(PALETTES.map((p) => [p, BLUE])),
        signal: SIGNAL,
        ...Object.fromEntries(STATUS.map((p) => [p, statusText(p)])),
      },
      // backgrounds: strong fills keep their colour in both themes, so white text stays
      // readable; bg-ink becomes a light fill in dark mode (theme.css darkens its text)
      backgroundColor: {
        ink: { DEFAULT: v('ink-fill'), 2: v('ink-fill-2'), 3: v('ink-3'), 4: v('ink-4') },
        gray: GRAY_BG,
        ...Object.fromEntries(PALETTES.map((p) => [p, BLUE_BG])),
        signal: { ...SIGNAL, ok: '#17834F', warn: '#C2410C', err: '#C42B2B' },
        ...Object.fromEntries(STATUS.map((p) => [p, statusBg(p)])),
      },
      // Type sizes in px so that the smaller root only tightens spacing, not text.
      fontSize: {
        xs: ['11.5px', '16px'],
        sm: ['13px', '19px'],
        base: ['14px', '21px'],
        lg: ['16px', '23px'],
        xl: ['18px', '25px'],
        '2xl': ['21px', '28px'],
        '3xl': ['26px', '32px'],
      },
      // hairlines become soft grey; text and fills keep the near-black ink
      borderColor: { ink: v('border-ink') },
      ringColor: { ink: v('ink') },
      borderRadius: { card: '14px', pill: '999px' },
      boxShadow: {
        card: 'var(--sh-card)',
        lift: 'var(--sh-lift)',
      },
      fontFamily: {
        sans: ['"Geist Sans"', 'Geist', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      keyframes: {
        rise: { '0%': { opacity: 0, transform: 'translateY(4px)' },
                '100%': { opacity: 1, transform: 'translateY(0)' } },
        pulsedot: { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.35 } },
        scan: { '0%': { transform: 'translateY(-100%)' }, '100%': { transform: 'translateY(100%)' } },
        drift: { '0%,100%': { transform: 'translate(0,0) scale(1)' },
                 '50%': { transform: 'translate(3%,-4%) scale(1.06)' } },
        sweep: { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(100%)' } },
      },
      animation: {
        rise: 'rise .3s cubic-bezier(.2,.7,.2,1) both',
        pulsedot: 'pulsedot 1.4s ease-in-out infinite',
        scan: 'scan 6s linear infinite',
        drift: 'drift 14s ease-in-out infinite',
        sweep: 'sweep 2.4s ease-in-out infinite',
      },
      spacing: {
        4: '1rem',
        8: '2rem',
        25: '6.25rem',
        30: '7.5rem',
        35: '8.75rem',
        38: '9.5rem',
        65: '16.25rem',
        75: '18.75rem',
        80: '20rem',
        100: '25rem',
      },
      maxHeight: {
        25: '6.25rem',
        30: '7.5rem',
        50: '12.5rem',
        75: '18.75rem',
        100: '25rem',
      },
      minHeight: {
        4: '1rem',
        8: '2rem',
      },
      minWidth: {
        20: '5rem',
        30: '7.5rem',
        65: '16.25rem',
      },
      width: {
        35: '8.75rem',
        80: '20rem',
      },
      flex: {
        6: '6 6 0%',
      },
    },
  },
  plugins: [],
};
