// Copyright 2026 ROBOTIS CO., LTD.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// 3D viewer for an uploaded robot. It parses the (already validated, Xacro-expanded) URDF in
// the browser and builds the kinematic tree with three.js. This is a SIMULATION VIEW ONLY: the
// joint sliders move the picture, never the robot - nothing here talks to ROS or hardware.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import clsx from 'clsx';
import { useTheme } from '../../components/ThemeToggle';
import { TRAINER_BASE } from '../../hooks/useTrainer';

const nums = (s, n, d = 0) => {
  const p = (s || '').trim().split(/\s+/).map(Number);
  return p.length === n && p.every(Number.isFinite) ? p : new Array(n).fill(d);
};

// URDF is Z-up, three.js is Y-up: the whole robot sits in a group rotated -90deg about X.
function originMatrix(el) {
  const o = el && el.querySelector(':scope > origin');
  const xyz = nums(o && o.getAttribute('xyz'), 3);
  const rpy = nums(o && o.getAttribute('rpy'), 3);
  const m = new THREE.Matrix4();
  // URDF rpy = fixed-axis XYZ = intrinsic ZYX
  m.makeRotationFromEuler(new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX'));
  m.setPosition(xyz[0], xyz[1], xyz[2]);
  return m;
}

export function parseUrdf(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const robot = doc.documentElement;
  if (!robot || robot.nodeName !== 'robot' || doc.querySelector('parsererror')) {
    throw new Error('The URDF could not be read.');
  }
  const links = {};
  robot.querySelectorAll(':scope > link').forEach((l) => {
    const mass = l.querySelector(':scope > inertial > mass');
    links[l.getAttribute('name')] = {
      name: l.getAttribute('name'),
      el: l,
      mass: mass ? Number(mass.getAttribute('value')) : null,
    };
  });
  const joints = {};
  const childOf = {};
  robot.querySelectorAll(':scope > joint').forEach((j) => {
    const lim = j.querySelector(':scope > limit');
    const ax = nums(j.querySelector(':scope > axis') && j.querySelector(':scope > axis').getAttribute('xyz'), 3);
    const info = {
      name: j.getAttribute('name'),
      type: j.getAttribute('type'),
      parent: j.querySelector(':scope > parent').getAttribute('link'),
      child: j.querySelector(':scope > child').getAttribute('link'),
      axis: ax[0] || ax[1] || ax[2] ? ax : [1, 0, 0],
      lower: lim && lim.getAttribute('lower') !== null ? Number(lim.getAttribute('lower')) : null,
      upper: lim && lim.getAttribute('upper') !== null ? Number(lim.getAttribute('upper')) : null,
      velocity: lim && lim.getAttribute('velocity') ? Number(lim.getAttribute('velocity')) : null,
      effort: lim && lim.getAttribute('effort') ? Number(lim.getAttribute('effort')) : null,
      el: j,
    };
    joints[info.name] = info;
    childOf[info.child] = info.name;
  });
  const base = Object.keys(links).find((n) => !childOf[n]);
  return { name: robot.getAttribute('name'), links, joints, base };
}

function loaderFor(path) {
  const e = path.slice(path.lastIndexOf('.')).toLowerCase();
  return e === '.stl' ? 'stl' : e === '.dae' ? 'dae' : e === '.obj' ? 'obj' : null;
}

const MAT = () => new THREE.MeshStandardMaterial({ color: 0x8a96a3, metalness: 0.15, roughness: 0.6 });

async function loadMesh(url, kind) {
  if (kind === 'stl') {
    const g = await new STLLoader().loadAsync(url);
    g.computeVertexNormals();
    return new THREE.Mesh(g, MAT());
  }
  if (kind === 'dae') {
    const c = await new ColladaLoader().loadAsync(url);
    return c.scene;
  }
  const o = await new OBJLoader().loadAsync(url);
  o.traverse((n) => {
    if (n.isMesh) n.material = MAT();
  });
  return o;
}

function geometryNode(g, meshMap, rid, loads) {
  const box = g.querySelector(':scope > box');
  const cyl = g.querySelector(':scope > cylinder');
  const sph = g.querySelector(':scope > sphere');
  const mesh = g.querySelector(':scope > mesh');
  const holder = new THREE.Group();
  if (box) {
    const s = nums(box.getAttribute('size'), 3, 0.05);
    holder.add(new THREE.Mesh(new THREE.BoxGeometry(s[0], s[1], s[2]), MAT()));
  } else if (cyl) {
    const r = Number(cyl.getAttribute('radius')) || 0.02;
    const l = Number(cyl.getAttribute('length')) || 0.05;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, l, 24), MAT());
    m.rotation.x = Math.PI / 2; // URDF cylinders run along Z
    holder.add(m);
  } else if (sph) {
    holder.add(new THREE.Mesh(new THREE.SphereGeometry(Number(sph.getAttribute('radius')) || 0.02, 24, 16), MAT()));
  } else if (mesh) {
    const fn = mesh.getAttribute('filename') || '';
    const path = meshMap[fn];
    const kind = path && loaderFor(path);
    const sc = nums(mesh.getAttribute('scale'), 3, 1);
    if (kind) {
      const url = `${TRAINER_BASE}/robots/${rid}/asset/${path.split('/').map(encodeURIComponent).join('/')}`;
      loads.push(
        loadMesh(url, kind)
          .then((obj) => {
            obj.scale.set(sc[0], sc[1], sc[2]);
            holder.add(obj);
          })
          .catch(() => {
            // a mesh that fails to load shows as a small marker; the report lists missing files
            holder.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.01), new THREE.MeshBasicMaterial({ color: 0xc42b2b })));
          })
      );
    }
  }
  return holder;
}

export function buildRobot(parsed, meshMap, rid) {
  const root = new THREE.Group(); // Z-up frame
  const linkObj = {};
  const jointObj = {};
  const loads = [];
  Object.values(parsed.links).forEach((L) => {
    const g = new THREE.Group();
    g.name = L.name;
    g.userData.link = L.name;
    L.el.querySelectorAll(':scope > visual').forEach((v) => {
      const geo = v.querySelector(':scope > geometry');
      if (!geo) return;
      const holder = geometryNode(geo, meshMap, rid, loads);
      const o = new THREE.Group();
      o.matrixAutoUpdate = false;
      o.matrix.copy(originMatrix(v));
      o.add(holder);
      o.userData.visual = true;
      g.add(o);
    });
    linkObj[L.name] = g;
  });
  Object.values(parsed.joints).forEach((J) => {
    const frame = new THREE.Group(); // joint origin in the parent frame
    frame.matrixAutoUpdate = false;
    frame.matrix.copy(originMatrix(J.el));
    const mover = new THREE.Group(); // rotates / slides along the axis
    frame.add(mover);
    mover.add(linkObj[J.child]);
    if (linkObj[J.parent]) linkObj[J.parent].add(frame);
    jointObj[J.name] = { frame, mover, info: J };
  });
  if (parsed.base && linkObj[parsed.base]) root.add(linkObj[parsed.base]);
  return { root, linkObj, jointObj, loads };
}

export function setJoint(j, value) {
  const { mover, info } = j;
  const a = new THREE.Vector3(...info.axis).normalize();
  mover.position.set(0, 0, 0);
  mover.quaternion.identity();
  if (info.type === 'prismatic') mover.position.copy(a.multiplyScalar(value));
  else if (info.type === 'revolute' || info.type === 'continuous') mover.quaternion.setFromAxisAngle(a, value);
}

const fmt = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d));

function TreeNode({ node, selected, onSelect, depth = 0 }) {
  const [open, setOpen] = useState(depth < 3);
  const has = node.children && node.children.length > 0;
  return (
    <div>
      <div
        className={clsx(
          'flex items-center gap-1 rounded-lg px-1.5 py-1 text-[12px] cursor-pointer',
          selected === node.link ? 'bg-ink text-white' : 'hover:bg-paper-2'
        )}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => onSelect(node.link)}
        data-tree-link={node.link}
      >
        <button
          type="button"
          className="w-4 text-center text-ink-4"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {has ? (open ? '▾' : '▸') : '·'}
        </button>
        <span className="font-mono truncate">{node.link}</span>
        {node.joint && (
          <span className={clsx('ml-auto text-[10px] shrink-0', selected === node.link ? 'text-white/60' : 'text-ink-4')}>
            {node.type}
          </span>
        )}
      </div>
      {open && has && node.children.map((c) => <TreeNode key={c.link} node={c} selected={selected} onSelect={onSelect} depth={depth + 1} />)}
    </div>
  );
}

export default function UrdfViewer({ robotId, urdfText, meshMap, tree, className }) {
  const mountRef = useRef(null);
  const stateRef = useRef({});
  const [error, setError] = useState('');
  const [status, setStatus] = useState('loading');
  const [selected, setSelected] = useState(null);
  const [vals, setVals] = useState({});
  const [dims, setDims] = useState(null);
  const [showFrames, setShowFrames] = useState(false);
  const dark = useTheme() === 'dark';

  const parsed = useMemo(() => {
    try {
      return parseUrdf(urdfText);
    } catch (e) {
      return { error: e.message };
    }
  }, [urdfText]);

  useEffect(() => {
    if (!mountRef.current || parsed.error) return undefined;
    const el = mountRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(dark ? 0x0f1218 : 0xf4f5f2);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.005, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    el.appendChild(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.9));
    const dl = new THREE.DirectionalLight(0xffffff, 1.1);
    dl.position.set(2, 4, 3);
    scene.add(dl);
    const grid = new THREE.GridHelper(2, 20, 0xcdd0cb, 0xe3e5e0);
    scene.add(grid);
    const world = new THREE.Group();
    world.rotation.x = -Math.PI / 2;
    scene.add(world);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    let robot;
    try {
      robot = buildRobot(parsed, meshMap || {}, robotId);
    } catch (e) {
      setError(e.message);
      return undefined;
    }
    world.add(robot.root);
    Object.values(robot.linkObj).forEach((g) => {
      const ax = new THREE.AxesHelper(0.04);
      ax.visible = false;
      g.add(ax);
    });
    const init = {};
    Object.values(robot.jointObj).forEach((j) => {
      init[j.info.name] = 0;
    });
    setVals(init);

    const box = new THREE.Box3();
    const fit = () => {
      // only visual geometry counts (frame helpers would inflate the size)
      box.makeEmpty();
      robot.root.updateMatrixWorld(true);
      robot.root.traverse((o) => {
        if (o.userData.visual) box.expandByObject(o, true);
      });
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const c = box.getCenter(new THREE.Vector3());
      const r = Math.max(size.x, size.y, size.z) || 0.3;
      camera.position.set(c.x + r * 1.6, c.y + r * 1.2, c.z + r * 1.6);
      controls.target.copy(c);
      controls.update();
      grid.scale.setScalar(Math.max(0.2, r));
      // size is in the world (Y-up) frame, the robot's Z is world Y: report in robot axes
      setDims({ x: size.x, y: size.z, z: size.y });
    };
    const resize = () => {
      const w = el.clientWidth || 600;
      const h = el.clientHeight || 400;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    fit();
    Promise.all(robot.loads).then(() => {
      fit();
      setStatus('ready');
    });
    if (!robot.loads.length) setStatus('ready');
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    // selection by click
    const ray = new THREE.Raycaster();
    const onClick = (ev) => {
      const r = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hits = ray.intersectObject(robot.root, true);
      for (const h of hits) {
        let o = h.object;
        while (o && !o.userData.link) o = o.parent;
        if (o) {
          setSelected(o.userData.link);
          return;
        }
      }
    };
    renderer.domElement.addEventListener('click', onClick);

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();
    stateRef.current = { robot, fit, scene, world };
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('click', onClick);
      controls.dispose();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
      renderer.dispose();
      if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
      stateRef.current = {};
    };
  }, [parsed, meshMap, robotId, dark]);

  // highlight the selected link
  useEffect(() => {
    const r = stateRef.current.robot;
    if (!r) return;
    Object.values(r.linkObj).forEach((g) => {
      const on = g.userData.link === selected;
      g.traverse((o) => {
        if (o.isMesh && o.material && o.material.emissive) {
          o.material.emissive.setHex(on ? 0x2457e6 : 0x000000);
          o.material.emissiveIntensity = on ? 0.55 : 0;
        }
      });
    });
  }, [selected, status]);

  useEffect(() => {
    const r = stateRef.current.robot;
    if (!r) return;
    Object.values(r.linkObj).forEach((g) =>
      g.children.forEach((c) => {
        if (c.isAxesHelper) c.visible = showFrames;
      })
    );
  }, [showFrames, status]);

  const setJ = (name, v) => {
    const r = stateRef.current.robot;
    if (!r || !r.jointObj[name]) return;
    setJoint(r.jointObj[name], v);
    setVals((o) => ({ ...o, [name]: v }));
  };
  const reset = () => {
    Object.keys(vals).forEach((n) => setJ(n, 0));
  };

  if (parsed.error) {
    return <div className="rounded-xl bg-signal-errbg px-3 py-2 text-[12.5px]">{parsed.error}</div>;
  }

  const sel = selected && parsed.links[selected];
  const parentJoint = sel && Object.values(parsed.joints).find((j) => j.child === selected);
  const childJoints = sel ? Object.values(parsed.joints).filter((j) => j.parent === selected) : [];
  const movable = Object.values(parsed.joints).filter((j) => ['revolute', 'continuous', 'prismatic'].includes(j.type));

  return (
    <div className={clsx('grid gap-3 lg:grid-cols-[1fr_300px]', className)} data-urdf-viewer>
      <div className="min-w-0">
        <div ref={mountRef} className="relative w-full h-[420px] rounded-2xl overflow-hidden border border-rule bg-paper" data-viewer-canvas>
          {status === 'loading' && !error && (
            <div className="absolute inset-0 grid place-items-center text-[12px] text-ink-3 pointer-events-none">Loading model…</div>
          )}
        </div>
        {error && <div className="mt-2 rounded-xl bg-signal-errbg px-3 py-2 text-[12.5px]">{error}</div>}
        <div className="mt-2 flex items-center gap-3 flex-wrap text-[11.5px] text-ink-3">
          <span>Drag to rotate · scroll to zoom · right-drag to pan · click a part to select</span>
          <label className="ml-auto inline-flex items-center gap-1.5">
            <input type="checkbox" checked={showFrames} onChange={(e) => setShowFrames(e.target.checked)} />
            Link frames
          </label>
        </div>
        {dims && (
          <div className="mt-2 text-[12px]" data-dims>
            <span className="label mr-2">Overall size at zero pose</span>
            <span className="font-mono">
              {fmt(dims.x * 1000, 0)} × {fmt(dims.y * 1000, 0)} × {fmt(dims.z * 1000, 0)} mm
            </span>
            <span className="text-ink-3"> (x · y · z, from the loaded geometry)</span>
          </div>
        )}
      </div>

      <div className="min-w-0 space-y-3">
        <div>
          <div className="label mb-1">Joint hierarchy</div>
          <div className="rounded-2xl bg-paper p-1.5 max-h-[170px] overflow-y-auto scroll-thin" data-tree>
            {tree && tree.link ? <TreeNode node={tree} selected={selected} onSelect={setSelected} /> : <div className="p-2 text-[12px] text-ink-3">No tree.</div>}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <div className="label">Joint simulation</div>
            <button className="btn-ghost text-[11.5px]" onClick={reset} data-action="viewer-reset">
              Reset pose
            </button>
          </div>
          <p className="text-[11px] text-ink-3 mb-1">Moves the picture only. No command is sent to any robot.</p>
          <div className="space-y-1.5 max-h-[170px] overflow-y-auto scroll-thin pr-1" data-joint-sliders>
            {movable.map((j) => {
              const lo = j.type === 'continuous' || j.lower === null ? -Math.PI : j.lower;
              const hi = j.type === 'continuous' || j.upper === null ? Math.PI : j.upper;
              return (
                <div key={j.name} className={clsx('rounded-xl px-2 py-1', selected === j.child ? 'bg-sky/20' : '')}>
                  <div className="flex justify-between text-[11.5px]">
                    <span className="font-mono truncate">{j.name}</span>
                    <span className="font-mono text-ink-3">{fmt(vals[j.name] || 0, 2)}</span>
                  </div>
                  <input
                    type="range"
                    className="w-full"
                    min={lo}
                    max={hi}
                    step={(hi - lo) / 200}
                    value={vals[j.name] || 0}
                    onChange={(e) => setJ(j.name, Number(e.target.value))}
                    aria-label={`Simulate ${j.name}`}
                    data-joint-slider={j.name}
                  />
                  <div className="flex justify-between text-[10px] text-ink-4">
                    <span>{fmt(lo, 2)}</span>
                    <span>{j.type === 'prismatic' ? 'm' : 'rad'}</span>
                    <span>{fmt(hi, 2)}</span>
                  </div>
                </div>
              );
            })}
            {!movable.length && <div className="text-[12px] text-ink-3">This robot has no movable joints.</div>}
          </div>
        </div>

        <div data-link-info>
          <div className="label mb-1">Selected link</div>
          {sel ? (
            <div className="rounded-2xl bg-paper px-3 py-2 text-[12px] space-y-0.5">
              <div className="font-mono font-semibold">{sel.name}</div>
              <div>
                Parent joint:{' '}
                <span className="font-mono">
                  {parentJoint ? `${parentJoint.name} (${parentJoint.type})` : 'none — this is the base link'}
                </span>
              </div>
              {parentJoint && parentJoint.lower !== null && (
                <div>
                  Limits: <span className="font-mono">{fmt(parentJoint.lower, 3)} … {fmt(parentJoint.upper, 3)}</span>
                  {parentJoint.velocity ? <span className="text-ink-3"> · vel {fmt(parentJoint.velocity, 2)}</span> : null}
                  {parentJoint.effort ? <span className="text-ink-3"> · effort {fmt(parentJoint.effort, 1)}</span> : null}
                </div>
              )}
              <div>Child joints: <span className="font-mono">{childJoints.map((c) => c.name).join(', ') || 'none (end link)'}</span></div>
              <div>Mass: <span className="font-mono">{sel.mass !== null ? `${fmt(sel.mass, 3)} kg` : 'not set'}</span></div>
            </div>
          ) : (
            <div className="rounded-2xl bg-paper px-3 py-2 text-[12px] text-ink-3">Click a part or a name in the hierarchy.</div>
          )}
        </div>
      </div>
    </div>
  );
}
