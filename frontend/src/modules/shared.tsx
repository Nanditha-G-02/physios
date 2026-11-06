// Pieces shared by several modules: page frame, service gates, camera view, live joints.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { files } from '@/api/gateway';
import { useAvailability, useSystem } from '@/app/system';
import { I } from '@/design/icons';
import { Button, Callout, Empty, Loading } from '@/design/ui';
import { useNow, useTopic } from '@/hooks/data';

export function Page({ intro, children, actions }: { intro?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page">
      {(intro || actions) && <div className="row-between" style={{ marginBottom: 16, alignItems: 'flex-start' }}>{intro ? <p className="page-intro" style={{ margin: 0 }}>{intro}</p> : <span />}{actions && <div className="row">{actions}</div>}</div>}
      {children}
    </div>
  );
}

/** Renders children only when the backend a module depends on is reachable; otherwise a
 *  disconnected state with the backend's own hint. */
export function Requires({ service, children, what }: { service: 'trainer' | 'ros'; children: ReactNode; what: string }) {
  const av = useAvailability();
  const { refreshHealth } = useSystem();
  if (!av.known) return <Loading label="Checking services…" />;
  const ok = service === 'trainer' ? av.trainer : av.ros;
  if (ok) return <>{children}</>;
  const hint = service === 'trainer' ? av.hint('trainer') : av.rosbridge ? av.hint('ros_node') : av.hint('rosbridge');
  return (
    <div className="panel" data-disconnected={service}>
      <Empty icon={<I.link />} title={service === 'trainer' ? 'Training service disconnected' : 'Robot side (ROS 2) disconnected'}
        action={<Button size="sm" icon={<I.refresh />} onClick={refreshHealth}>Check again</Button>}>
        {what} needs {service === 'trainer' ? 'the host training service (pam_trainer)' : 'physical_ai_server through rosbridge'}. {hint}
      </Empty>
    </div>
  );
}

export function RosNotice() {
  const av = useAvailability();
  if (!av.known || av.ros) return null;
  return <Callout tone="warn" title="Robot side not connected">{av.rosbridge ? av.hint('ros_node') : av.hint('rosbridge')}</Callout>;
}

/** Live MJPEG camera through the gateway with loading / error / retry states. */
export function CameraView({ topic, label, recording, quality = 60 }: { topic: string; label?: string; recording?: boolean; quality?: number }) {
  const [state, setState] = useState<'loading' | 'live' | 'error'>('loading');
  const [nonce, setNonce] = useState(0);
  useEffect(() => setState('loading'), [topic, nonce]);
  useEffect(() => {
    if (state !== 'error') return;
    const id = setTimeout(() => setNonce((n) => n + 1), 4000);
    return () => clearTimeout(id);
  }, [state]);
  return (
    <div className="camera" data-camera={topic} data-state={state}>
      <img key={nonce} src={`${files.cameraStream(topic, quality)}&n=${nonce}`} alt={label || topic}
        onLoad={() => setState('live')} onError={() => setState('error')} style={{ opacity: state === 'live' ? 1 : 0 }} />
      {state !== 'live' && <div className="camera-state">{state === 'loading' ? <div className="spinner" /> : <span>No image from {topic}<br /><span style={{ opacity: 0.7 }}>retrying…</span></span>}</div>}
      <div className="camera-label">{label || topic}</div>
      {recording && <div className="rec-dot">REC</div>}
    </div>
  );
}

/** Joint positions from a sensor_msgs/JointState topic, with staleness. */
export function LiveJoints({ topic, limits, title }: { topic: string; limits?: Record<string, [number, number]>; title?: string }) {
  const { msg, at } = useTopic<any>(topic, 'sensor_msgs/msg/JointState', 100);
  const now = useNow(500);
  const stale = !at || now - at > 1500;
  if (!msg) return <div className="small muted" data-live-joints={topic}>{title ? `${title}: ` : ''}waiting for {topic}…</div>;
  const names: string[] = msg.name || [];
  const pos: number[] = msg.position || [];
  return (
    <div className="stack-sm" data-live-joints={topic} data-stale={stale}>
      <div className="row-between small"><span className="text-2">{title || topic}</span><span className={stale ? 'muted' : ''} style={{ color: stale ? undefined : 'var(--ok)' }}>{stale ? 'stale' : '● live'}</span></div>
      {names.map((n, i) => {
        const [lo, hi] = limits?.[n] || [-Math.PI, Math.PI];
        const v = pos[i];
        const pct = Math.max(0, Math.min(100, ((v - lo) / (hi - lo || 1)) * 100));
        return (
          <div className="joint-bar" key={n}>
            <span className="ellipsis mono">{n}</span>
            <div className="joint-track"><span style={{ left: `${pct}%` }} /></div>
            <span className="num right mono">{v?.toFixed(3)}</span>
          </div>
        );
      })}
    </div>
  );
}
