// Gateway-owned endpoints: health, host metrics, activity, ROS operations, planning/data
// commands, dataset files and camera streams. Contract: documentation/03-API.md.
import { BASE, get, post, qs } from './http';

export type ServiceState = { status: 'ok' | 'down' | 'unknown' | 'degraded'; detail?: string; hint?: string | null; latency_ms?: number; version?: string; [k: string]: any };
export type Health = { status: 'ok' | 'degraded'; services: Record<'gateway' | 'trainer' | 'rosbridge' | 'ros_node' | 'camera' | 'datasets', ServiceState>; checked_at: number };
export type ActivityEvent = { seq: number; t: number; source: string; level: 'info' | 'warn' | 'error'; text: string };

export const gateway = {
  health: (force = false) => get<Health>('/health' + (force ? '?force=1' : ''), { timeoutMs: 15000 }),
  system: () => get('/system'),
  config: () => get('/config'),
  activity: (after = 0) => get<{ events: ActivityEvent[]; seq: number }>('/activity' + qs({ after })),
  datasetRoots: () => get('/datasets/roots'),
};

export const ros = {
  status: () => get('/ros/status'),
  robotTypes: () => get<{ robot_types: string[] }>('/ros/robot-types'),
  setRobotType: (robot_type: string) => post('/ros/robot-type', { robot_type }, { timeoutMs: 30000 }),
  cameras: () => get<{ topics: string[] }>('/ros/cameras'),
  policies: () => get<{ policies: { path: string; type: string }[] }>('/ros/policies'),
  task: (command: string, task_info: Record<string, unknown>, confirm = false) => post<{ success: boolean; message: string }>('/ros/task', { command, task_info, confirm }, { timeoutMs: 30000 }),
  hf: (body: Record<string, string>) => post('/ros/hf', body),
};

/** PlanningService commands (physical_ai_server). Same engine for /planning and /data. */
export const planning = <T = any>(command: string, payload: Record<string, unknown> = {}) => post<T>('/planning/' + command, payload, { timeoutMs: 60000 });
export const data = <T = any>(command: string, payload: Record<string, unknown> = {}) => post<T>('/data/' + command, payload, { timeoutMs: 120000 });

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
export const files = {
  datasetFile: (datasetId: string, rel: string) => `${BASE}/datasets/${enc(datasetId)}/files/${enc(rel)}`,
  datasetExport: (datasetId: string) => `${BASE}/datasets/${enc(datasetId)}/export`,
  cameraStream: (topic: string, quality = 60, width?: number) => `${BASE}/camera/stream${qs({ topic, quality, width })}`,
  cameraSnapshot: (topic: string) => `${BASE}/camera/snapshot${qs({ topic })}`,
  robotAsset: (rid: string, rel: string) => `${BASE}/trainer/robots/${encodeURIComponent(rid)}/asset/${enc(rel)}`,
};

// TaskStatus.phase (physical_ai_interfaces/msg/TaskStatus.msg)
export const PHASES = ['Ready', 'Warming up', 'Resetting', 'Recording', 'Saving', 'Stopped', 'Inferencing'] as const;
export const PHASE = { READY: 0, WARMING_UP: 1, RESETTING: 2, RECORDING: 3, SAVING: 4, STOPPED: 5, INFERENCING: 6 };
