// HTTP client for the PHYSIOS gateway. Every failure becomes an ApiError with a code,
// a message for the operator and, when the backend knows one, a hint.

export class ApiError extends Error {
  status: number;
  code: string;
  hint?: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, hint?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

export const BASE = '/api/v1';

async function parse(res: Response): Promise<any> {
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (res.ok) return body;
  // gateway: {error:{code,message,hint}}; trainer (proxied): {error:"text"}
  const e = body?.error;
  if (res.status === 401 && e && typeof e === 'object' && e.code === 'auth_required' && typeof window !== 'undefined') window.dispatchEvent(new Event('physios:auth-required'));
  if (e && typeof e === 'object') throw new ApiError(res.status, e.code || 'error', e.message || res.statusText, e.hint, e.details);
  if (typeof e === 'string') throw new ApiError(res.status, res.status === 503 ? 'unavailable' : 'rejected', e);
  throw new ApiError(res.status, 'http_' + res.status, text.slice(0, 300) || res.statusText);
}

export async function request<T = any>(method: 'GET' | 'POST', path: string, body?: unknown, opts: { timeoutMs?: number; raw?: BodyInit; contentType?: string } = {}): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 60000);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: opts.raw ? { 'Content-Type': opts.contentType || 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: ctl.signal,
      cache: 'no-store',
    });
    return await parse(res);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error).name === 'AbortError') throw new ApiError(0, 'timeout', 'The request timed out.');
    throw new ApiError(0, 'network', 'PHYSIOS gateway not reachable.', 'Start it with ./start_physios.sh');
  } finally {
    clearTimeout(timer);
  }
}

export const get = <T = any>(path: string, opts?: { timeoutMs?: number }) => request<T>('GET', path, undefined, opts);
export const post = <T = any>(path: string, body: unknown = {}, opts?: { timeoutMs?: number }) => request<T>('POST', path, body, opts);
export const qs = (o: Record<string, string | number | undefined | null | boolean>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? '?' + p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '';
};
