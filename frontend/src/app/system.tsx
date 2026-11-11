// Application-wide state: service health, ROS link, active robot, live task status,
// notifications. Everything comes from the backend; nothing is invented here.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { gateway, planning, type ActivityEvent, type Health } from '@/api/gateway';
import { trainer } from '@/api/trainer';
import { rosSocket } from '@/api/rosbridge';
import { useRosState } from '@/hooks/data';

export type Notice = { id: string; t: number; level: 'info' | 'warn' | 'error'; source: string; text: string };
type Sys = {
  health: Health | null; healthError: unknown; refreshHealth: () => void;
  rosLink: 'connecting' | 'open' | 'closed';
  taskStatus: any | null; taskStatusAt: number; heartbeatAt: number;
  robotType: string; setRobotTypeLocal: (r: string) => void;
  notices: Notice[]; unread: number; markRead: () => void;
};
const Ctx = createContext<Sys | null>(null);

const lsGet = (k: string, d: string) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

export function SystemProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<unknown>(null);
  const [taskStatus, setTaskStatus] = useState<any>(null);
  const [taskStatusAt, setTaskStatusAt] = useState(0);
  const [heartbeatAt, setHeartbeatAt] = useState(0);
  const [robotType, setRobotTypeLocal] = useState('');
  const [notices, setNotices] = useState<Notice[]>([]);
  const [readAt, setReadAt] = useState(() => Number(lsGet('physios.readAt', '0')));
  const rosLink = useRosState();
  const seq = useRef({ gw: 0, tr: 0 });

  const refreshHealth = useCallback(async () => {
    try { setHealth(await gateway.health()); setHealthError(null); } catch (e) { setHealthError(e); }
  }, []);

  useEffect(() => {
    refreshHealth();
    const id = setInterval(() => !document.hidden && refreshHealth(), 5000);
    return () => clearInterval(id);
  }, [refreshHealth]);

  // notifications: gateway activity + training-service events
  useEffect(() => {
    let stop = false;
    const pull = async () => {
      const add: Notice[] = [];
      try {
        const g = await gateway.activity(seq.current.gw);
        g.events.forEach((e: ActivityEvent) => add.push({ id: 'g' + e.seq, t: e.t * 1000, level: e.level, source: e.source, text: e.text }));
        seq.current.gw = g.seq;
      } catch { /* gateway down: header shows it */ }
      try {
        const tr = await trainer.events(seq.current.tr);
        (tr.events || []).forEach((e: any) => add.push({
          id: 't' + e.seq, t: Date.parse(e.t || e.time || '') || Date.now(), level: e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : 'info',
          source: 'training', text: [e.title, e.body].filter(Boolean).join(': ') || e.text || 'Training event',
        }));
        seq.current.tr = tr.seq ?? seq.current.tr;
      } catch { /* trainer down */ }
      if (!stop && add.length) setNotices((n) => [...add, ...n].sort((a, b) => b.t - a.t).slice(0, 200));
    };
    pull();
    const id = setInterval(() => !document.hidden && pull(), 6000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  // live task status / heartbeat from physical_ai_server
  useEffect(() => {
    const a = rosSocket.subscribe('/task/status', 'physical_ai_interfaces/msg/TaskStatus', (m) => {
      setTaskStatus(m); setTaskStatusAt(Date.now());
      if (m?.robot_type) setRobotTypeLocal(m.robot_type);
    }, 200);
    const b = rosSocket.subscribe('/heartbeat', 'std_msgs/msg/Empty', () => setHeartbeatAt(Date.now()), 500);
    return () => { a(); b(); };
  }, []);

  // the server's current robot type, also when no task status has been published yet
  const rosUp = health?.services?.ros_node?.status === 'ok';
  useEffect(() => {
    if (!rosUp || robotType) return;
    planning('robot.profile', {}).then((r) => r?.robot_type && setRobotTypeLocal(r.robot_type)).catch(() => {});
  }, [rosUp, robotType]);


  const value = useMemo<Sys>(() => ({
    health, healthError, refreshHealth, rosLink, taskStatus, taskStatusAt, heartbeatAt,
    robotType, setRobotTypeLocal, notices,
    unread: notices.filter((n) => n.t > readAt).length,
    markRead: () => { const t = Date.now(); setReadAt(t); lsSet('physios.readAt', String(t)); },
  }), [health, healthError, refreshHealth, rosLink, taskStatus, taskStatusAt, heartbeatAt, robotType, notices, readAt]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSystem() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSystem outside SystemProvider');
  return c;
}

/** Convenience: is a backend capability available right now? */
export function useAvailability() {
  const { health } = useSystem();
  const s = health?.services;
  return {
    known: !!s,
    trainer: s?.trainer?.status === 'ok',
    ros: s?.ros_node?.status === 'ok',
    rosbridge: s?.rosbridge?.status === 'ok',
    camera: s?.camera?.status === 'ok',
    hint: (k: 'trainer' | 'ros_node' | 'camera' | 'rosbridge') => s?.[k]?.hint || s?.[k]?.detail || '',
  };
}
