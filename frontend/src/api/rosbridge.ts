// Live ROS data for the browser: a rosbridge v2 client over the gateway's /ros WebSocket.
// Used for streams (task status, joint states, heartbeat) and the supervised hardware test.
// Commands with effects go through the gateway REST API instead.

type Handler = (msg: any) => void;
type Sub = { topic: string; type?: string; throttle: number; handlers: Set<Handler> };
export type RosState = 'connecting' | 'open' | 'closed';

class RosSocket {
  private ws: WebSocket | null = null;
  private subs = new Map<string, Sub>();
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: any }>();
  private advertised = new Set<string>();
  private listeners = new Set<(s: RosState) => void>();
  private n = 0;
  private retry = 800;
  private timer: any = null;
  state: RosState = 'closed';
  private started = false;

  url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ros`;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private set(s: RosState) {
    this.state = s;
    this.listeners.forEach((l) => l(s));
  }

  onState(l: (s: RosState) => void) {
    this.listeners.add(l);
    l(this.state);
    return () => { this.listeners.delete(l); };
  }

  private connect() {
    clearTimeout(this.timer);
    this.set('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 800;
      this.advertised.clear();
      this.set('open');
      this.subs.forEach((s) => this.sendSub(s));
    };
    ws.onmessage = (ev) => {
      let m: any;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.op === 'publish') {
        this.subs.get(m.topic)?.handlers.forEach((h) => { try { h(m.msg); } catch (e) { console.error(e); } });
      } else if (m.op === 'service_response') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.result === false) p.reject(new Error(typeof m.values === 'string' ? m.values : 'service call failed'));
        else p.resolve(m.values || {});
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.pending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error('ROS connection lost')); });
      this.pending.clear();
      this.set('closed');
      this.schedule();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private schedule() {
    this.timer = setTimeout(() => this.connect(), this.retry);
    this.retry = Math.min(this.retry * 1.6, 6000);
  }

  private raw(obj: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  private sendSub(s: Sub) {
    this.raw({ op: 'subscribe', topic: s.topic, type: s.type, throttle_rate: s.throttle, queue_length: 1 });
  }

  subscribe(topic: string, type: string | undefined, handler: Handler, throttleMs = 0) {
    this.start();
    let s = this.subs.get(topic);
    if (!s) {
      s = { topic, type, throttle: throttleMs, handlers: new Set() };
      this.subs.set(topic, s);
      this.sendSub(s);
    }
    s.handlers.add(handler);
    return () => {
      const cur = this.subs.get(topic);
      if (!cur) return;
      cur.handlers.delete(handler);
      if (!cur.handlers.size) {
        this.subs.delete(topic);
        this.raw({ op: 'unsubscribe', topic });
      }
    };
  }

  callService<T = any>(service: string, args: unknown = {}, type?: string, timeoutMs = 10000): Promise<T> {
    this.start();
    return new Promise((resolve, reject) => {
      const id = `physios-ui-${++this.n}`;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${service} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.raw({ op: 'call_service', id, service, args, type })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('ROS is not connected'));
      }
    });
  }

  /** Only the supervised hardware test publishes from the browser (see lib/hardwareTest.ts). */
  publish(topic: string, type: string, msg: unknown) {
    if (!this.advertised.has(topic)) {
      this.raw({ op: 'advertise', topic, type });
      this.advertised.add(topic);
    }
    return this.raw({ op: 'publish', topic, msg });
  }
}

export const rosSocket = new RosSocket();
