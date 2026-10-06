// Small drawing and data helpers shared by charts that build their own stage
// (rather than the categorical floor of GridChart).

import { parseHex, shade } from './color.js';

export const accessor = (a) => (typeof a === 'function' ? a : (d) => d?.[a]);

// A floor slab spanning [x0, x1] x [y0, y1] on the ground plane: visible sides
// first, then the top surface.
export function drawSlab(chart, x0, x1, y0, y1, { fill } = {}) {
  const { camera: C, renderer: R, theme } = chart;
  const P = (x, y, z = 0) => C.project(x, y, z);
  const t = -theme.floorThickness;
  const base = parseHex(theme.floor);
  if (t < 0) {
    const sides = [
      [[1, 0, 0], [P(x1, y0, t), P(x1, y1, t), P(x1, y1), P(x1, y0)]],
      [[-1, 0, 0], [P(x0, y1, t), P(x0, y0, t), P(x0, y0), P(x0, y1)]],
      [[0, 1, 0], [P(x1, y1, t), P(x0, y1, t), P(x0, y1), P(x1, y1)]],
      [[0, -1, 0], [P(x0, y0, t), P(x1, y0, t), P(x1, y0), P(x0, y0)]],
    ];
    for (const [n, pts] of sides) if (C.faces(...n)) R.polygon(pts, shade(base, 0.82 + 0.1 * C.light(...n)), theme.grid, 1);
  }
  R.polygon([P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)], fill ?? theme.floor, theme.grid, 1);
}

// Category swatches along the top-right corner. entries: [{ label, color }].
// `active` (an index) is drawn bold.
export function drawLegend(chart, entries, { active = -1, y = 22 } = {}) {
  const { renderer: R, theme } = chart;
  const ctx = R.ctx;
  let x = R.width - 20;
  for (let i = entries.length - 1; i >= 0; i--) {
    const { label, color } = entries[i];
    const weight = i === active ? 600 : 400;
    x -= R.measure(String(label), 12, weight);
    R.text(String(label), x, y, { color: i === active ? theme.text : theme.textMuted, weight, align: 'left' });
    x -= 12;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y - 4, 8, 8, 2);
    ctx.fill();
    x -= 16;
  }
}

// Greedy label placement: returns false when `box` hits one already placed.
export function claim(placed, box) {
  if (placed.some((p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t)) return false;
  placed.push(box);
  return true;
}

// Fit margins for a label of width w centred above a point.
export const above = (w, rise = 30) => ({ l: w / 2 + 4, r: w / 2 + 4, t: rise, b: 0 });

// Colour for a series slot from options.colors (array, { key: colour } map or
// (key, index) => colour), falling back to the theme palette.
export function seriesColor(chart, key, index) {
  const fallback = chart.theme.series[index % chart.theme.series.length];
  const c = chart.options.colors;
  if (typeof c === 'function') return c(key, index) ?? fallback;
  if (Array.isArray(c)) return c[index % c.length];
  if (c && typeof c === 'object') return c[key] ?? fallback;
  return fallback;
}

// Frames from options: [{ label, data }], or one unlabelled frame of `data`.
export const framesOf = (options) => options.frames ?? [{ label: null, data: options.data ?? [] }];
