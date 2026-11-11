// Optional sign-in. The gateway reports whether authentication is enabled
// (PHYSIOS_AUTH_TOKEN); when it is and this browser has no session, the operator signs in
// here before any page loads. A 401 "auth_required" from any request brings this back.
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { auth } from '@/api/gateway';
import { ApiError } from '@/api/http';
import { Mark } from './Shell';

type State = 'checking' | 'open' | 'login';

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>('checking');
  useEffect(() => {
    let live = true;
    auth.session().then((s) => live && setState(!s.enabled || s.authenticated ? 'open' : 'login'), () => live && setState('open'));
    const onExpired = () => setState('login');
    window.addEventListener('physios:auth-required', onExpired);
    return () => { live = false; window.removeEventListener('physios:auth-required', onExpired); };
  }, []);
  if (state === 'checking') return <div className="shell" />;
  if (state === 'login') return <Login onDone={() => setState('open')} />;
  return <>{children}</>;
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await auth.login(token); onDone(); } catch (x) { setErr(x instanceof ApiError ? x.message : 'Sign-in failed.'); } finally { setBusy(false); }
  };
  return (
    <div className="shell" style={{ display: 'grid', placeItems: 'center' }}>
      <form className="panel login" onSubmit={submit} data-testid="login">
        <div className="row" style={{ gap: 10 }}><Mark /><span className="label">Sign in</span></div>
        <h1 className="fade-text" style={{ margin: '14px 0 2px', fontSize: 34, fontWeight: 300, letterSpacing: '-0.02em' }}>PHYSIOS</h1>
        <p className="muted small" style={{ margin: '0 0 16px' }}>The Operating System for Physical Intelligence. This station requires an operator access token.</p>
        <label className="field"><span className="field-label">Access token</span>
          <input className="input" type="password" autoFocus autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} data-field="token" />
        </label>
        {err && <div className="callout callout-danger" style={{ marginTop: 10 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', marginTop: 14 }} disabled={!token || busy} data-action="sign-in">{busy ? <span className="spinner" /> : null}Sign in</button>
        <p className="tiny muted" style={{ margin: '12px 0 0' }}>The token is set by the administrator in <span className="mono">PHYSIOS_AUTH_TOKEN</span>. Sessions last 12 hours.</p>
      </form>
    </div>
  );
}
