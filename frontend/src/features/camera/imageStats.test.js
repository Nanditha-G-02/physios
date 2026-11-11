import { bestShift, colourStats, edgeMap, evaluate, SMALL_H, SMALL_W } from './imageStats';

function scene(dx = 0, dy = 0, tint = [1, 1, 1], gain = 1) {
  const a = new Uint8ClampedArray(SMALL_W * SMALL_H * 4);
  for (let y = 0; y < SMALL_H; y += 1) {
    for (let x = 0; x < SMALL_W; x += 1) {
      const sx = x - dx;
      const sy = y - dy;
      let v = 120;
      if (sx > 20 && sx < 35 && sy > 15 && sy < 30) v = 220; // cube
      if (sy > 42) v = 70; // table edge
      if ((sx - 55) ** 2 + (sy - 20) ** 2 < 49) v = 30; // tray corner
      const i = (y * SMALL_W + x) * 4;
      a[i] = v * gain * tint[0];
      a[i + 1] = v * gain * tint[1];
      a[i + 2] = v * gain * tint[2];
      a[i + 3] = 255;
    }
  }
  return a;
}

test('identical views match', () => {
  const s = scene();
  const al = bestShift(edgeMap(s), edgeMap(s));
  expect(al.dx).toBe(0);
  expect(al.ncc).toBeGreaterThan(0.95);
  const checks = evaluate({ live: colourStats(s), ref: colourStats(s), liveSize: [640, 480], refSize: [640, 480], liveFps: 29.6, refFps: 30, align: al });
  expect(checks.every((c) => c.level === 'ok')).toBe(true);
});

test('detects a moved camera, a green tint, darker image and low fps', () => {
  const ref = scene();
  const live = scene(5, 2, [0.85, 1, 0.85], 0.7);
  const al = bestShift(edgeMap(ref), edgeMap(live));
  expect(al.dx).toBe(5);
  expect(al.dy).toBe(2);
  const c = Object.fromEntries(
    evaluate({ live: colourStats(live), ref: colourStats(ref), liveSize: [640, 480], refSize: [1280, 720], liveFps: 15, refFps: 30, align: al }).map((x) => [x.id, x])
  );
  expect(c.resolution.level).toBe('error');
  expect(c.fps.level).toBe('error');
  expect(c.brightness.level).not.toBe('ok');
  expect(c.colour.text).toMatch(/greener/);
  expect(c.position.level).not.toBe('ok');
});
