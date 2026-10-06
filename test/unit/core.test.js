import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Camera, ISO_PITCH, ISO_YAW } from '../../src/core/camera.js';
import { Timeline, Tween, ease } from '../../src/core/animation.js';
import {
  parseHex,
  rampAt,
  registerTheme,
  resolveTheme,
  scales,
  sequentialStops,
  shade,
  themes,
} from '../../src/core/color.js';
import { niceTicks } from '../../src/core/grid-chart.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('niceTicks start at 0, cover the max and use round steps', () => {
  for (const max of [0.83, 7.3, 19, 49.9, 62, 105, 122.9, 4900, 1e6 + 1]) {
    const ticks = niceTicks(max);
    assert.equal(ticks[0], 0);
    assert.ok(ticks.at(-1) >= max, `top ${ticks.at(-1)} < ${max}`);
    const n = ticks.length - 1;
    assert.ok(n >= 3 && n <= 6, `${n} intervals for ${max}`);
    const step = ticks[1];
    const mantissa = step / 10 ** Math.floor(Math.log10(step));
    assert.ok([1, 2, 2.5, 5].some((m) => Math.abs(m - mantissa) < 1e-9), `step ${step}`);
    ticks.forEach((t, i) => close(t, i * step, step * 1e-9));
  }
});

test('niceTicks hug the data rather than overshooting', () => {
  assert.deepEqual(niceTicks(122.9), [0, 25, 50, 75, 100, 125]);
  assert.deepEqual(niceTicks(4900), [0, 1000, 2000, 3000, 4000, 5000]);
  assert.deepEqual(niceTicks(0), [0, 1]);
});

test('camera unproject inverts project on the ground plane', () => {
  const c = new Camera({ yaw: 0.7, pitch: 0.6, zoom: 1.3 });
  Object.assign(c, { scale: 37, cx: 400, cy: 300, zx: 500, zy: 280 });
  c.update();
  for (const [x, y] of [[0, 0], [3.2, -1.7], [-12, 40]]) {
    const p = c.project(x, y, 0);
    const [ux, uy] = c.unproject(p.x, p.y);
    close(ux, x, 1e-9);
    close(uy, y, 1e-9);
  }
});

test('camera culls faces pointing away and keeps the top face', () => {
  const c = new Camera({ yaw: ISO_YAW, pitch: ISO_PITCH });
  assert.ok(c.faces(0, 0, 1));
  assert.ok(!c.faces(0, 0, -1));
  // Opposite side faces can't both be visible.
  assert.ok(!(c.faces(1, 0, 0) && c.faces(-1, 0, 0)));
  assert.ok(!(c.faces(0, 1, 0) && c.faces(0, -1, 0)));
});

test('camera fitTarget keeps the points inside the padded viewport', () => {
  const c = new Camera();
  const pts = [[-5, -3, 0], [5, -3, 0], [5, 3, 0], [-5, 3, 0], [0, 0, 4]];
  const pad = { top: 40, right: 20, bottom: 20, left: 20 };
  Object.assign(c, c.fitTarget(800, 500, pts, pad));
  for (const [x, y, z] of pts) {
    const p = c.project(x, y, z);
    assert.ok(p.x >= pad.left - 1e-6 && p.x <= 800 - pad.right + 1e-6);
    assert.ok(p.y >= pad.top - 1e-6 && p.y <= 500 - pad.bottom + 1e-6);
  }
});

test('camera fitTarget leaves each point its pixel margins', () => {
  const c = new Camera();
  const m = { l: 120, r: 0, t: 10, b: 30 };
  const pts = [[-5, -3, 0, m], [5, -3, 0], [5, 3, 0, m], [-5, 3, 0], [0, 0, 4]];
  Object.assign(c, c.fitTarget(800, 500, pts, { top: 0, right: 0, bottom: 0, left: 0 }));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y, z, mm = { l: 0, r: 0, t: 0, b: 0 }] of pts) {
    const p = c.project(x, y, z);
    minX = Math.min(minX, p.x - mm.l);
    maxX = Math.max(maxX, p.x + mm.r);
    minY = Math.min(minY, p.y - mm.t);
    maxY = Math.max(maxY, p.y + mm.b);
  }
  assert.ok(minX >= -1e-6 && maxX <= 800 + 1e-6 && minY >= -1e-6 && maxY <= 500 + 1e-6);
  // Tight on at least one axis, and centred on both.
  assert.ok(Math.abs(maxX - minX - 800) < 1e-6 || Math.abs(maxY - minY - 500) < 1e-6);
  close(minX, 800 - maxX);
  close(minY, 500 - maxY);
});

test('tween waits for its delay, eases, and lands exactly on target', () => {
  const t = new Tween(0);
  t.to(10, 1000, { duration: 100, delay: 50, easing: ease.linear });
  t.tick(1040);
  assert.equal(t.value, 0);
  t.tick(1100);
  close(t.value, 5);
  assert.equal(t.tick(1200), true); // final frame still reports a change
  assert.equal(t.value, 10);
  assert.equal(t.tick(1300), false);
});

test('easings start at 0 and end at 1', () => {
  for (const [name, f] of Object.entries(ease)) {
    close(f(0), 0, 1e-9);
    close(f(1), 1, 1e-9);
    assert.ok(Number.isFinite(f(0.5)), name);
  }
});

test('timeline advances by frameDuration, loops, and clamps seeks', () => {
  const tl = new Timeline({ length: 4, frameDuration: 100, loop: true });
  tl.play();
  tl.tick(0);
  tl.tick(150);
  close(tl.position, 1.5);
  tl.tick(450); // past the end (3): wraps
  close(tl.position, 1.5);

  const once = new Timeline({ length: 3, frameDuration: 100, loop: false });
  once.play();
  once.tick(0);
  once.tick(1000);
  assert.equal(once.position, 2);
  assert.equal(once.playing, false);
  once.seek(-5);
  assert.equal(once.position, 0);
  once.seek(99);
  assert.equal(once.position, 2);
});

test('colour helpers', () => {
  assert.deepEqual(parseHex('#2a78d6'), [42, 120, 214]);
  assert.deepEqual(parseHex('#fff'), [255, 255, 255]);
  assert.equal(shade([100, 100, 100], 0), 'rgb(0,0,0)');
  assert.equal(shade([100, 100, 100], 2), 'rgb(255,255,255)');
  assert.equal(shade([10, 20, 30], 1, 0.5), 'rgba(10,20,30,0.5)');
  assert.deepEqual(rampAt(['#000000', '#ffffff'], 0), [0, 0, 0]);
  assert.deepEqual(rampAt(['#000000', '#ffffff'], 1), [255, 255, 255]);
  assert.deepEqual(rampAt(['#000000', '#ffffff'], 7), [255, 255, 255]);
});

test('themes resolve presets, extensions and registrations', () => {
  assert.equal(resolveTheme(), themes.midnight);
  assert.equal(resolveTheme('dark'), themes.dark);
  assert.throws(() => resolveTheme('nope'), /unknown theme/);
  const t = resolveTheme({ extends: 'dark', glow: 0.1 });
  assert.equal(t.glow, 0.1);
  assert.equal(t.floor, themes.dark.floor);
  registerTheme('test-brand', { series: ['#ff0000'] });
  assert.deepEqual(resolveTheme('test-brand').series, ['#ff0000']);
  delete themes['test-brand'];
});

test('sequential scales run light to deep, reversed on dark themes', () => {
  assert.deepEqual(sequentialStops({ mode: 'light' }, 'blue'), scales.blue);
  assert.deepEqual(sequentialStops({ mode: 'dark' }, 'blue'), [...scales.blue].reverse());
  // Explicit arrays are taken as given (already low -> high).
  assert.deepEqual(sequentialStops({ mode: 'dark' }, ['#000', '#fff']), ['#000', '#fff']);
});
