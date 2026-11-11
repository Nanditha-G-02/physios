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

// Pure image statistics used by the camera match check (no DOM access).

export const SMALL_W = 80;
export const SMALL_H = 60;

// mean luma (0-255) and channel means of RGBA pixel data
export function colourStats(rgba) {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) {
    r += rgba[i];
    g += rgba[i + 1];
    b += rgba[i + 2];
  }
  r /= n;
  g /= n;
  b /= n;
  return { r, g, b, luma: 0.299 * r + 0.587 * g + 0.114 * b, rg: r / Math.max(g, 1), bg: b / Math.max(g, 1) };
}

export function averageStats(list) {
  const keys = ['r', 'g', 'b', 'luma', 'rg', 'bg'];
  const out = {};
  keys.forEach((k) => {
    out[k] = list.reduce((a, s) => a + s[k], 0) / Math.max(1, list.length);
  });
  return out;
}

// grayscale + Sobel magnitude of a SMALL_W x SMALL_H RGBA buffer, normalised to mean 0 / std 1
export function edgeMap(rgba, w = SMALL_W, h = SMALL_H) {
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) gray[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  const e = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const p = (dx, dy) => gray[(y + dy) * w + x + dx];
      const gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
      const gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
      e[y * w + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  let m = 0;
  e.forEach((v) => {
    m += v;
  });
  m /= e.length;
  let s = 0;
  e.forEach((v) => {
    s += (v - m) * (v - m);
  });
  s = Math.sqrt(s / e.length) || 1;
  return e.map((v) => (v - m) / s);
}

// best normalised cross-correlation of b against a within +-maxShift pixels
export function bestShift(a, b, w = SMALL_W, h = SMALL_H, maxShift = 8) {
  let best = { ncc: -2, dx: 0, dy: 0 };
  for (let dy = -maxShift; dy <= maxShift; dy += 1) {
    for (let dx = -maxShift; dx <= maxShift; dx += 1) {
      let sum = 0;
      let n = 0;
      for (let y = Math.max(1, -dy + 1); y < Math.min(h - 1, h - 1 - dy); y += 1) {
        for (let x = Math.max(1, -dx + 1); x < Math.min(w - 1, w - 1 - dx); x += 1) {
          sum += a[y * w + x] * b[(y + dy) * w + x + dx];
          n += 1;
        }
      }
      const ncc = n ? sum / n : -2;
      if (ncc > best.ncc) best = { ncc, dx, dy };
    }
  }
  return { ...best, shift_pct: Math.hypot(best.dx / w, best.dy / h) * 100 };
}

// Turn live vs reference measurements into checks. Thresholds are deliberately
// loose: they flag differences a policy is known to be sensitive to.
export function evaluate({ live, ref, liveSize, refSize, liveFps, refFps, align }) {
  const checks = [];
  const add = (id, label, level, text) => checks.push({ id, label, level, text });
  if (liveSize && refSize) {
    const same = liveSize[0] === refSize[0] && liveSize[1] === refSize[1];
    add(
      'resolution',
      'Resolution',
      same ? 'ok' : 'error',
      same ? `${liveSize.join('×')} as in training` : `live ${liveSize.join('×')}, training ${refSize.join('×')}`,
    );
  } else add('resolution', 'Resolution', 'unknown', 'not available');
  if (liveFps != null && refFps) {
    const r = liveFps / refFps;
    add(
      'fps',
      'Frame rate',
      r >= 0.9 ? 'ok' : r >= 0.7 ? 'warn' : 'error',
      `live ${liveFps.toFixed(1)} fps, training ${refFps} fps`,
    );
  } else add('fps', 'Frame rate', 'unknown', liveFps == null ? 'could not measure the topic rate' : 'training fps unknown');
  if (live && ref) {
    const d = live.luma - ref.luma;
    const rel = Math.abs(d) / Math.max(ref.luma, 1);
    add(
      'brightness',
      'Brightness',
      rel < 0.12 ? 'ok' : rel < 0.25 ? 'warn' : 'error',
      `live ${live.luma.toFixed(0)}, training ${ref.luma.toFixed(0)} (${d > 0 ? '+' : ''}${((100 * d) / Math.max(ref.luma, 1)).toFixed(0)}%)`,
    );
    const drg = live.rg / ref.rg - 1;
    const dbg = live.bg / ref.bg - 1;
    const worst = Math.max(Math.abs(drg), Math.abs(dbg));
    let tint = '';
    if (worst >= 0.06) {
      if (drg < -0.06 && dbg < -0.06) tint = 'greener than training';
      else if (drg > 0.06 && dbg > 0.06) tint = 'more magenta than training';
      else if (dbg > 0.06 || drg < -0.06) tint = 'bluer / cooler than training';
      else tint = 'warmer / more red than training';
    }
    add(
      'colour',
      'Colour balance',
      worst < 0.06 ? 'ok' : worst < 0.15 ? 'warn' : 'error',
      worst < 0.06 ? 'matches training' : `${tint} (R/G ${(drg * 100).toFixed(0)}%, B/G ${(dbg * 100).toFixed(0)}%)`,
    );
  }
  if (align) {
    const lvl = align.ncc >= 0.55 && align.shift_pct < 4 ? 'ok' : align.ncc >= 0.35 && align.shift_pct < 8 ? 'warn' : 'error';
    add(
      'position',
      'Camera position',
      lvl,
      lvl === 'ok'
        ? `view matches (similarity ${align.ncc.toFixed(2)})`
        : `view differs: similarity ${align.ncc.toFixed(2)}, shifted ~${align.shift_pct.toFixed(1)}% (${align.dx > 0 ? 'right' : align.dx < 0 ? 'left' : ''}${align.dy ? (align.dy > 0 ? ' down' : ' up') : ''})`,
    );
  }
  return checks;
}
