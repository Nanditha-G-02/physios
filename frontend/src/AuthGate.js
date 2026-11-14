// PHYSIOS: optional operator sign-in. The PHYSIOS gateway reports whether sign-in is enabled
// (PHYSIOS_AUTH_TOKEN). It is off by default; then this component renders the app unchanged.
// When it is on and this browser has no session, the operator enters the access token here.

import React, { useEffect, useState } from 'react';
import { ReactComponent as RawLogo } from './assets/raw-logo.svg';

async function session() {
  try {
    const r = await fetch('/api/v1/auth/session', { cache: 'no-store' });
    if (!r.ok) return { enabled: false, authenticated: true };
    return await r.json();
  } catch (e) {
    return { enabled: false, authenticated: true };
  }
}

export default function AuthGate({ children }) {
  const [state, setState] = useState('checking');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    session().then((s) => live && setState(!s.enabled || s.authenticated ? 'open' : 'login'));
    return () => {
      live = false;
    };
  }, []);

  if (state === 'open') return children;
  if (state === 'checking') return <div className="h-screen w-screen bp-grid" />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (r.ok) {
        setState('open');
      } else {
        const b = await r.json().catch(() => ({}));
        setErr((b.error && b.error.message) || 'Sign-in failed.');
      }
    } catch (x) {
      setErr('RawBot Studio gateway not reachable.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-screen w-screen bp-grid grid place-items-center">
      <form className="sheet w-[360px] p-6" onSubmit={submit} data-testid="login">
        <div className="flex items-center justify-between">
          <RawLogo className="h-[16px] w-auto text-ink" role="img" aria-label="RawBot Studio logo" />
          <span className="label">Sign in</span>
        </div>
        <h1 className="text-[34px] font-light tracking-tight mt-4">
          RawBot{' '}
          <span className="font-normal bg-clip-text text-transparent" style={{ backgroundImage: 'linear-gradient(100deg, #1D47C2 0%, #2457E6 45%, #4F7BFF 100%)' }}>
            Studio
          </span>
        </h1>
        <p className="text-[12.5px] text-ink-3 mt-1 mb-4">
          The Operating System for Physical Intelligence. This station requires an operator access
          token.
        </p>
        <label className="label block mb-1" htmlFor="physios-token">
          Access token
        </label>
        <input
          id="physios-token"
          className="input"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          data-field="token"
        />
        {err && <p className="mt-2 rounded-lg bg-signal-errbg px-3 py-2 text-[12px] text-signal-err">{err}</p>}
        <button className="btn-primary w-full mt-4" disabled={!token || busy} data-action="sign-in">
          Sign in
        </button>
      </form>
    </div>
  );
}
