// Interactive 3D view of a robot model (simulation only): orbit camera, joint sliders, link
// tree, live joint overlay when a JointState source is given.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildRobot, jointRange, parseUrdf, setJoint, type BuiltRobot, type ParsedUrdf } from '@/lib/urdf';
import { Badge, Button, Callout, Loading } from '@/design/ui';
import { I } from '@/design/icons';

export function UrdfScene({ urdf, meshMap, assetUrl, live, height = 440 }: { urdf: string; meshMap: Record<string, string>; assetUrl: (p: string) => string; live?: Record<string, number> | null; height?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const robotRef = useRef<BuiltRobot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<Record<string, number>>({});
  const parsed = useMemo<ParsedUrdf | null>(() => { try { setError(''); return parseUrdf(urdf); } catch (e) { setError((e as Error).message); return null; } }, [urdf]);
  const movable = parsed ? Object.values(parsed.joints).filter((j) => ['revolute', 'continuous', 'prismatic'].includes(j.type)) : [];

  useEffect(() => {
    if (!parsed || !host.current) return;
    const el = host.current;
    let w = el.clientWidth; let h = el.clientHeight;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.005, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1e24, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(2, 3, 2); scene.add(key);
    const grid = new THREE.GridHelper(2, 40, 0x3a4656, 0x222a35); scene.add(grid);
    const zUp = new THREE.Group(); zUp.rotation.x = -Math.PI / 2; scene.add(zUp);
    const built = buildRobot(parsed, meshMap, assetUrl);
    robotRef.current = built;
    zUp.add(built.root);
    const frame = () => {
      const box = new THREE.Box3().setFromObject(zUp);
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3()).length() || 0.5;
      const c = box.getCenter(new THREE.Vector3());
      controls.target.copy(c);
      camera.position.copy(c).add(new THREE.Vector3(size * 0.9, size * 0.7, size * 0.9));
      camera.near = size / 200; camera.far = size * 50; camera.updateProjectionMatrix();
      grid.scale.setScalar(Math.max(0.25, size));
    };
    frame();
    Promise.allSettled(built.loads).then(() => { frame(); setLoading(false); });
    let raf = 0;
    const loop = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
    loop();
    const ro = new ResizeObserver(() => { w = el.clientWidth; h = el.clientHeight; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); });
    ro.observe(el);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); el.removeChild(renderer.domElement); robotRef.current = null; };
  }, [parsed, meshMap, assetUrl]);

  // apply slider values, or live joint positions when connected
  useEffect(() => {
    const r = robotRef.current;
    if (!r) return;
    Object.entries(r.jointObj).forEach(([n, j]) => setJoint(j, live && live[n] !== undefined ? live[n] : values[n] ?? 0));
  }, [values, live]);

  if (error) return <Callout tone="danger" title="Model cannot be displayed">{error}</Callout>;
  return (
    <div className="grid g-side" style={{ gridTemplateColumns: 'minmax(0,1fr) 300px' }}>
      <div className="viewer3d" ref={host} style={{ height }} data-testid="urdf-viewer">
        {loading && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}><Loading label="Loading meshes…" /></div>}
        <div style={{ position: 'absolute', left: 10, bottom: 10 }} className="row"><Badge>simulation view</Badge>{live && <Badge tone="ok" dot>live joint state</Badge>}</div>
      </div>
      <div className="stack-sm" style={{ maxHeight: height, overflowY: 'auto' }}>
        <div className="row-between"><span className="label">Joints ({movable.length})</span><Button size="sm" variant="ghost" icon={<I.refresh />} onClick={() => setValues({})} disabled={!!live}>Zero</Button></div>
        {movable.map((j) => {
          const [lo, hi] = jointRange(j);
          const v = live?.[j.name] ?? values[j.name] ?? 0;
          return (
            <div key={j.name} className="stack-sm" style={{ gap: 2 }}>
              <div className="row-between tiny"><span className="mono">{j.name}</span><span className="muted">{j.type} · {v.toFixed(3)}</span></div>
              <input type="range" min={lo} max={hi} step={(hi - lo) / 400} value={v} disabled={!!live} onChange={(e) => setValues({ ...values, [j.name]: Number(e.target.value) })} data-joint-slider={j.name} />
            </div>
          );
        })}
        {!movable.length && <span className="small muted">No movable joints.</span>}
      </div>
    </div>
  );
}
