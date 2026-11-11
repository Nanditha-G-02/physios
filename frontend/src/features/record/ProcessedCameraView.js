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

// Processed camera view. Runs entirely in the browser on a *copy* of the MJPEG
// stream (fetched through the same-origin /camera-stream proxy so pixels can be
// read). The original stream, the recorder and the dataset are never touched.
//
// Pipeline: blur / contrast -> temporal denoise (EMA) -> background filtering
// against a captured reference frame -> colour-based object/target detection
// (HSV thresholds + connected components on a coarse grid) -> overlays.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

const MAX_W = 480;

function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx ? d / mx : 0, mx];
}

export const DEFAULT_PROCESSING = {
  blur: 1,
  contrast: 1.15,
  brightness: 1,
  temporal: 0.5, // 0 = off, closer to 1 = stronger smoothing
  background: false,
  bgThreshold: 40,
  detect: true,
  isolate: false,
  hueTol: 16,
  minSat: 0.35,
  minVal: 0.2,
  minArea: 40, // in coarse cells (4x4 px)
  targets: {}, // item_id -> {enabled, color}
};

function loadSettings(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? { ...DEFAULT_PROCESSING, ...JSON.parse(raw) } : { ...DEFAULT_PROCESSING };
  } catch (e) {
    return { ...DEFAULT_PROCESSING };
  }
}

export function streamUrl(topic, rosHost, sameOrigin) {
  const q = `stream?quality=60&type=ros_compressed&default_transport=compressed&topic=${topic}`;
  return sameOrigin ? `/camera-stream/${q}` : `http://${rosHost}:8080/${q}`;
}

export default function ProcessedCameraView({
  topic,
  items = [],
  rosHost,
  compact,
  active = true,
  sourceEl = null, // optional external <video> (recorded playback in Data)
  settingsKey,
}) {
  const imgRef = useRef(null);
  const canvasRef = useRef(null);
  const workRef = useRef(null);
  const accRef = useRef(null);
  const bgRef = useRef(null);
  const statRef = useRef({ fps: 0, ms: 0, frames: 0, t0: performance.now() });
  const key = settingsKey || `pam.processing.${topic}`;
  const [settings, setSettings] = useState(() => loadSettings(key));
  const [status, setStatus] = useState({ state: 'connecting', message: '' });
  const [stats, setStats] = useState({ fps: 0, ms: 0, found: [] });
  const [panel, setPanel] = useState(!compact);
  const [pickFor, setPickFor] = useState(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    setSettings(loadSettings(key));
    accRef.current = null;
    bgRef.current = null;
  }, [key]);

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(settings));
    } catch (e) {
      /* storage unavailable - settings stay for this session */
    }
  }, [settings, key]);

  const targets = items
    .map((it) => {
      const t = settings.targets[it.id] || {};
      return { ...it, enabled: t.enabled !== false, color: t.color || it.track_color || it.color };
    })
    .filter((t) => t.color);

  const set = (patch) => setSettings((s) => ({ ...s, ...patch }));
  const setTarget = (id, patch) =>
    setSettings((s) => ({ ...s, targets: { ...s.targets, [id]: { ...(s.targets[id] || {}), ...patch } } }));

  const processFrame = useCallback(() => {
    const img = sourceEl || imgRef.current;
    const out = canvasRef.current;
    const nw = img ? img.naturalWidth || img.videoWidth : 0;
    const nh = img ? img.naturalHeight || img.videoHeight : 0;
    if (!img || !out || !nw) return;
    const s = settingsRef.current;
    const t0 = performance.now();
    const scale = Math.min(1, MAX_W / nw);
    const W = Math.round(nw * scale);
    const H = Math.round(nh * scale);
    if (!workRef.current) workRef.current = document.createElement('canvas');
    const work = workRef.current;
    if (work.width !== W || work.height !== H) {
      work.width = W;
      work.height = H;
      out.width = W;
      out.height = H;
      accRef.current = null;
      bgRef.current = null;
    }
    const wctx = work.getContext('2d', { willReadFrequently: true });
    wctx.filter = `blur(${s.blur}px) contrast(${s.contrast}) brightness(${s.brightness})`;
    wctx.drawImage(img, 0, 0, W, H);
    wctx.filter = 'none';
    let frame;
    try {
      frame = wctx.getImageData(0, 0, W, H);
    } catch (e) {
      setStatus({
        state: 'tainted',
        message:
          'The browser cannot read pixels from this stream. Serve the UI through the bundled nginx (it proxies /camera-stream) or the dev server proxy.',
      });
      return;
    }
    const d = frame.data;
    const n = W * H;
    // temporal denoise
    if (s.temporal > 0) {
      if (!accRef.current || accRef.current.length !== d.length) accRef.current = Float32Array.from(d);
      const acc = accRef.current;
      const a = 1 - s.temporal;
      for (let i = 0; i < d.length; i += 1) {
        acc[i] += (d[i] - acc[i]) * a;
        d[i] = acc[i];
      }
    }
    const raw = new Uint8ClampedArray(d); // denoised frame before filtering, for sampling
    // detection on a coarse grid
    const C = 4;
    const gw = Math.ceil(W / C);
    const gh = Math.ceil(H / C);
    const found = [];
    const masks = [];
    const enabledTargets = s.detect ? targets.filter((t) => t.enabled) : [];
    let hueA;
    let satA;
    let valA;
    if (enabledTargets.length) {
      // one HSV pass shared by all targets (no per-pixel allocation)
      hueA = new Float32Array(n);
      satA = new Float32Array(n);
      valA = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        const p = i * 4;
        const r = raw[p] / 255;
        const g = raw[p + 1] / 255;
        const b = raw[p + 2] / 255;
        const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
        const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
        const dd = mx - mn;
        let h = 0;
        if (dd) {
          if (mx === r) h = ((g - b) / dd) % 6;
          else if (mx === g) h = (b - r) / dd + 2;
          else h = (r - g) / dd + 4;
          h *= 60;
          if (h < 0) h += 360;
        }
        hueA[i] = h;
        satA[i] = mx ? dd / mx : 0;
        valA[i] = mx;
      }
    }
    if (enabledTargets.length) {
      enabledTargets.forEach((t) => {
          const [th] = rgbToHsv(...hexToRgb(t.color));
          const grid = new Uint16Array(gw * gh);
          const pix = new Uint8Array(n);
          for (let y = 0; y < H; y += 1) {
            for (let x = 0; x < W; x += 1) {
              const i0 = y * W + x;
              const h = hueA[i0];
              const sat = satA[i0];
              const val = valA[i0];
              let dh = Math.abs(h - th);
              if (dh > 180) dh = 360 - dh;
              if (dh <= s.hueTol && sat >= s.minSat && val >= s.minVal) {
                grid[Math.floor(y / C) * gw + Math.floor(x / C)] += 1;
                pix[y * W + x] = 1;
              }
            }
          }
          masks.push(pix);
          // connected components on cells with >= 50% hits
          const need = (C * C) / 2;
          const seen = new Uint8Array(gw * gh);
          for (let i = 0; i < gw * gh; i += 1) {
            if (seen[i] || grid[i] < need) continue;
            const stack = [i];
            seen[i] = 1;
            let area = 0;
            let x0 = gw;
            let y0 = gh;
            let x1 = 0;
            let y1 = 0;
            while (stack.length) {
              const c = stack.pop();
              area += 1;
              const cx = c % gw;
              const cy = (c - cx) / gw;
              if (cx < x0) x0 = cx;
              if (cy < y0) y0 = cy;
              if (cx > x1) x1 = cx;
              if (cy > y1) y1 = cy;
              const nb = [c - 1, c + 1, c - gw, c + gw];
              for (let k = 0; k < 4; k += 1) {
                const q = nb[k];
                if (q < 0 || q >= gw * gh || seen[q] || grid[q] < need) continue;
                if ((k === 0 && cx === 0) || (k === 1 && cx === gw - 1)) continue;
                seen[q] = 1;
                stack.push(q);
              }
            }
            if (area >= s.minArea / 4) {
              found.push({ id: t.id, name: t.name, role: t.role, color: t.color, area, box: [x0 * C, y0 * C, (x1 + 1) * C, (y1 + 1) * C] });
            }
          }
        });
    }
    // background filtering + isolate
    const bg = bgRef.current;
    for (let i = 0; i < n; i += 1) {
      const p = i * 4;
      let keep = true;
      if (s.background && bg) {
        const diff = Math.abs(d[p] - bg[p]) + Math.abs(d[p + 1] - bg[p + 1]) + Math.abs(d[p + 2] - bg[p + 2]);
        keep = diff > s.bgThreshold;
      }
      if (keep && s.isolate && masks.length) keep = masks.some((m) => m[i]);
      if (!keep) {
        const g = 0.3 * d[p] + 0.59 * d[p + 1] + 0.11 * d[p + 2];
        d[p] = 246 * 0.75 + g * 0.25;
        d[p + 1] = 246 * 0.75 + g * 0.25;
        d[p + 2] = 242 * 0.75 + g * 0.25;
      }
    }
    const octx = out.getContext('2d');
    octx.putImageData(frame, 0, 0);
    // overlays
    found
      .sort((a, b) => b.area - a.area)
      .forEach((f, k) => {
        const [x0, y0, x1, y1] = f.box;
        octx.lineWidth = 2;
        octx.strokeStyle = f.color;
        octx.setLineDash(f.role === 'target' ? [6, 3] : []);
        octx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
        octx.setLineDash([]);
        octx.fillStyle = '#121414';
        const label = f.name;
        octx.font = '11px "Geist Mono", monospace';
        const tw = octx.measureText(label).width + 8;
        octx.fillRect(x0, Math.max(0, y0 - 15), tw, 15);
        octx.fillStyle = '#F6F6F2';
        octx.fillText(label, x0 + 4, Math.max(11, y0 - 4));
      });
    // stats
    const st = statRef.current;
    st.frames += 1;
    st.ms = st.ms * 0.9 + (performance.now() - t0) * 0.1;
    const now = performance.now();
    if (now - st.t0 > 1000) {
      st.fps = (st.frames * 1000) / (now - st.t0);
      st.frames = 0;
      st.t0 = now;
      setStats({ fps: st.fps, ms: st.ms, found: found.map((f) => f.name) });
    }
    if (status.state !== 'live') setStatus({ state: 'live', message: '' });
    out.rawFrame = raw;
  }, [targets, status.state, sourceEl]);

  useEffect(() => {
    if (!active || (!topic && !sourceEl)) return undefined;
    let raf;
    let last = 0;
    const loop = (t) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 55) return; // ~18 fps cap keeps the recorder machine responsive
      last = t;
      processFrame();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, topic, sourceEl, processFrame]);

  const captureBackground = () => {
    const out = canvasRef.current;
    if (out && out.rawFrame) {
      bgRef.current = new Uint8ClampedArray(out.rawFrame);
      set({ background: true });
    }
  };

  const onCanvasClick = (e) => {
    if (!pickFor) return;
    const out = canvasRef.current;
    const raw = out && out.rawFrame;
    if (!raw) return;
    const rect = out.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * out.width);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * out.height);
    const p = (y * out.width + x) * 4;
    setTarget(pickFor, { color: rgbToHex(raw[p], raw[p + 1], raw[p + 2]), enabled: true });
    setPickFor(null);
  };

  if (!topic && !sourceEl) {
    return <div className="h-full grid place-items-center text-[12.5px] text-ink-3">No camera topic selected.</div>;
  }

  return (
    <div className="relative h-full w-full flex min-h-0 bg-white">
      <div className="relative flex-1 min-w-0 grid place-items-center bg-paper-2">
        {!sourceEl && (
        <img
          ref={imgRef}
          src={active ? streamUrl(topic, rosHost, true) : ''}
          crossOrigin="anonymous"
          alt=""
          className="hidden"
          onError={() => setStatus({ state: 'error', message: 'No stream from the camera proxy (/camera-stream). Is web_video_server running?' })}
        />
        )}
        <canvas
          ref={canvasRef}
          onClick={onCanvasClick}
          className={clsx('max-h-full max-w-full', pickFor && 'cursor-crosshair')}
          aria-label={`Processed view of ${topic}`}
        />
        {status.state !== 'live' && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div className="bg-white border border-ink px-3 py-2 text-[12.5px] max-w-sm">
              {status.state === 'connecting' ? 'Waiting for frames…' : status.message}
            </div>
          </div>
        )}
        <div className="absolute left-2 top-2 flex gap-1.5">
          <span className="chip-ink">{sourceEl ? 'PROCESSED PLAYBACK · display only' : 'PROCESSED · display only'}</span>
          <span className="chip num">{stats.fps.toFixed(0)} fps · {stats.ms.toFixed(0)} ms</span>
        </div>
        <div className="absolute left-2 bottom-2 flex flex-wrap gap-1 max-w-[70%]">
          {stats.found.map((f, i) => (
            <span key={`${f}${i}`} className="chip">
              {f}
            </span>
          ))}
          {pickFor && <span className="chip-sky">Click the item in the image to sample its colour</span>}
        </div>
        <button className="absolute right-2 top-2 btn btn-sm bg-white/90" onClick={() => setPanel(!panel)}>
          {panel ? 'Hide controls' : 'Processing…'}
        </button>
      </div>
      {panel && (
        <div className="w-[230px] shrink-0 border-l border-ink overflow-y-auto scroll-thin p-3 space-y-3 text-[12px]">
          <Slider label="Blur" value={settings.blur} min={0} max={4} step={0.5} onChange={(v) => set({ blur: v })} />
          <Slider label="Temporal denoise" value={settings.temporal} min={0} max={0.9} step={0.05} onChange={(v) => set({ temporal: v })} />
          <Slider label="Contrast" value={settings.contrast} min={0.6} max={2} step={0.05} onChange={(v) => set({ contrast: v })} />
          <Slider label="Brightness" value={settings.brightness} min={0.6} max={1.6} step={0.05} onChange={(v) => set({ brightness: v })} />
          <div className="border-t border-rule pt-2 space-y-2">
            <div className="flex items-center justify-between">
              <span className="label">Background filter</span>
              <input type="checkbox" checked={settings.background} onChange={(e) => set({ background: e.target.checked })} disabled={!bgRef.current} />
            </div>
            <button className="btn btn-sm w-full" onClick={captureBackground}>
              Capture empty scene
            </button>
            <Slider label="Change threshold" value={settings.bgThreshold} min={10} max={150} step={5} onChange={(v) => set({ bgThreshold: v })} />
          </div>
          <div className="border-t border-rule pt-2 space-y-2">
            <div className="flex items-center justify-between">
              <span className="label">Colour detection</span>
              <input type="checkbox" checked={settings.detect} onChange={(e) => set({ detect: e.target.checked })} />
            </div>
            {targets.map((t) => (
              <div key={t.id} className="flex items-center gap-1.5">
                <input type="checkbox" checked={t.enabled} onChange={(e) => setTarget(t.id, { enabled: e.target.checked })} aria-label={`Detect ${t.name}`} />
                <input type="color" value={t.color} onChange={(e) => setTarget(t.id, { color: e.target.value })} className="h-5 w-6 border border-rule" aria-label={`${t.name} colour`} />
                <span className="flex-1 truncate">{t.name}</span>
                <button className="btn-ghost btn-sm px-1.5" onClick={() => setPickFor(t.id)} title="Sample colour from image">
                  ⌖
                </button>
              </div>
            ))}
            {!targets.length && <p className="text-ink-3">Approve a plan to get its objects and targets here.</p>}
            <Slider label="Hue tolerance" value={settings.hueTol} min={4} max={40} step={1} onChange={(v) => set({ hueTol: v })} />
            <Slider label="Min saturation" value={settings.minSat} min={0} max={1} step={0.05} onChange={(v) => set({ minSat: v })} />
            <Slider label="Min blob size" value={settings.minArea} min={8} max={400} step={8} onChange={(v) => set({ minArea: v })} />
            <div className="flex items-center justify-between">
              <span className="label">Show only detected</span>
              <input type="checkbox" checked={settings.isolate} onChange={(e) => set({ isolate: e.target.checked })} />
            </div>
          </div>
          <button className="btn btn-sm w-full" onClick={() => setSettings({ ...DEFAULT_PROCESSING })}>
            Reset
          </button>
          <p className="text-ink-3 text-[11px]">
            Detection is colour-threshold based (no ML model). Processing never changes the recorded data.
          </p>
        </div>
      )}
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange }) {
  return (
    <label className="block">
      <span className="flex justify-between">
        <span className="label">{label}</span>
        <span className="num text-ink-3">{value}</span>
      </span>
      <input type="range" className="w-full accent-ink" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
