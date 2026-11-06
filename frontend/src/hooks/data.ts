// Data hooks shared by every module: polling, one-shot loads, mutations and ROS topics.
import { useCallback, useEffect, useRef, useState } from 'react';
import { rosSocket, type RosState } from '@/api/rosbridge';

export type Async<T> = { data: T | undefined; error: unknown; loading: boolean; reload: () => Promise<void>; setData: (v: T) => void };

/** Load once (and on `deps` change); optionally re-poll every `intervalMs` while visible. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = [], intervalMs = 0, enabled = true): Async<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(enabled);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const alive = useRef(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const my = ++seq.current;
    try {
      const v = await fnRef.current();
      if (alive.current && my === seq.current) { setData(v); setError(null); }
    } catch (e) {
      if (alive.current && my === seq.current) setError(e);
    } finally {
      if (alive.current && my === seq.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!enabled) { setLoading(false); return () => { alive.current = false; }; }
    setLoading(true);
    reload();
    let id: any;
    if (intervalMs > 0) {
      id = setInterval(() => { if (!document.hidden) reload(); }, intervalMs);
    }
    return () => { alive.current = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs, enabled]);
  return { data, error, loading, reload, setData };
}

/** Wraps an async action with a busy flag and error capture. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>, opts: { onError?: (e: unknown) => void; onOk?: (r: R) => void } = {}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(async (...a: A): Promise<R | undefined> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn(...a);
      opts.onOk?.(r);
      return r;
    } catch (e) {
      setError(e);
      opts.onError?.(e);
      return undefined;
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fn]);
  return { run, busy, error, setError };
}

export function useRosState(): RosState {
  const [s, setS] = useState<RosState>(rosSocket.state);
  useEffect(() => { rosSocket.start(); return rosSocket.onState(setS); }, []);
  return s;
}

/** Latest message of a topic plus its arrival time. `null` topic disables. */
export function useTopic<T = any>(topic: string | null | undefined, type?: string, throttleMs = 100) {
  const [msg, setMsg] = useState<T | null>(null);
  const [at, setAt] = useState(0);
  useEffect(() => {
    setMsg(null);
    if (!topic) return;
    return rosSocket.subscribe(topic, type, (m) => { setMsg(m); setAt(Date.now()); }, throttleMs);
  }, [topic, type, throttleMs]);
  return { msg, at };
}

/** Re-render every `ms` (for "x s ago" labels and staleness checks). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}
