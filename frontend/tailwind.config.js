/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      // Design tokens (v2.2, after the operator's reference: soft grey canvas, white
      // rounded cards, black capsules, fading grey type, electric-blue accent).
      // Token names are kept from v2 so every page follows the new values.
      // v2.3 (compact professional): same palette family, slightly cooler neutrals and
      // crisper hairlines; sizes are tuned for a 14 px root (see index.css).
      colors: {
        paper: { DEFAULT: '#F4F5F7', 2: '#EDEFF2', 3: '#E2E5EA' },
        ink: { DEFAULT: '#0B0C0E', 2: '#383C44', 3: '#737A85', 4: '#AEB4BD' },
        rule: { DEFAULT: '#E5E7EB', strong: '#0B0C0E' },
        sky: { DEFAULT: '#D6E3FF', 50: '#F3F6FF', 100: '#E5ECFF', ink: '#2457E6' },
        night: { DEFAULT: '#070B16', 2: '#0E1526', 3: '#16203A', glow: '#3D7BFF' },
        signal: { ok: '#17834F', okbg: '#E4F4EB', warn: '#C2410C', warnbg: '#FDEEE3',
                  err: '#C42B2B', errbg: '#FCE9E9' },
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
      borderColor: { ink: '#DADDE2' },
      ringColor: { ink: '#0B0C0E' },
      borderRadius: { card: '14px', pill: '999px' },
      boxShadow: {
        card: '0 0 0 1px rgba(15,23,42,0.06), 0 1px 2px rgba(15,23,42,0.04), 0 6px 18px -10px rgba(15,23,42,0.12)',
        lift: '0 0 0 1px rgba(15,23,42,0.08), 0 2px 4px rgba(15,23,42,0.06), 0 14px 32px -16px rgba(15,23,42,0.30)',
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
