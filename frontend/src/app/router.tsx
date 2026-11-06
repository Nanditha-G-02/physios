// Minimal history router: path patterns with :params, links that push state.
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

type Loc = { path: string; query: URLSearchParams };
const Ctx = createContext<{ loc: Loc; go: (to: string, replace?: boolean) => void }>({ loc: { path: '/', query: new URLSearchParams() }, go: () => {} });

function read(): Loc {
  return { path: location.pathname || '/', query: new URLSearchParams(location.search) };
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState<Loc>(read);
  useEffect(() => {
    const on = () => setLoc(read());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const go = (to: string, replace = false) => {
    if (to === location.pathname + location.search) return;
    history[replace ? 'replaceState' : 'pushState'](null, '', to);
    setLoc(read());
    document.querySelector('.content')?.scrollTo({ top: 0 });
  };
  return <Ctx.Provider value={{ loc, go }}>{children}</Ctx.Provider>;
}

export function useRouter() {
  return useContext(Ctx);
}

/** Match `/datasets/:owner/:name` against a path; returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length && !pattern.endsWith('*')) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*') { out['*'] = s.slice(i).map(decodeURIComponent).join('/'); return out; }
    if (p[i].startsWith(':')) {
      if (s[i] === undefined) return null;
      out[p[i].slice(1)] = decodeURIComponent(s[i]);
    } else if (p[i] !== s[i]) return null;
  }
  return out;
}

export function Link({ to, children, className, ...rest }: { to: string; children: ReactNode; className?: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { go } = useRouter();
  return (
    <a href={to} className={className} {...rest} onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      go(to);
    }}>{children}</a>
  );
}
