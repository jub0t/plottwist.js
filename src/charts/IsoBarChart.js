// A grid of 3D bars: one categorical dimension along each ground axis, value as
// height. Add `stack` to split each bar into parts ("city blocks"). Pass
// `frames` instead of `data` to animate through time; the chart interpolates
// between frames so playback and scrubbing are continuous.

import { GridChart } from '../core/grid-chart.js';
import { drawBox } from '../core/shapes.js';
import { parseHex } from '../core/color.js';

const LIFT = 0.18;

export class IsoBarChart extends GridChart {
  constructor(container, options = {}) {
    super(container, options);
    this.barWidth = options.barWidth ?? 0.62;
    this.init();
  }

  // options.reference: a value or { value, label }. A translucent plane at
  // that height; bars are split at it so what's below reads as submerged.
  get reference() {
    const r = this.options.reference;
    if (r == null) return null;
    return typeof r === 'object' ? r : { value: r };
  }

  setReference(reference) {
    this.options.reference = reference;
    this.invalidate();
  }

  drawMarks() {
    const R = this.renderer;
    const cells = this.sortedCells();
    const ref = this.reference;
    if (!ref) {
      this._drawBars(cells, 0, Infinity);
    } else {
      // Below the plane, the plane itself, then above: correct from any
      // camera above the floor, with no per-pixel depth sorting.
      const zp = this.z(ref.value);
      this._drawBars(cells, 0, zp);
      this._drawPlane(zp, ref);
      this._drawBars(cells, zp, Infinity);
    }
    R.ctx.globalAlpha = 1;
    this._drawValueLabels(cells);
  }

  // Draw every bar's parts clipped to the height band [lo, hi).
  _drawBars(cells, lo, hi) {
    const { camera: C, renderer: R, theme } = this;
    const w = this.barWidth / 2;
    // A 2px surface gap between stacked parts, in world units.
    const gap = 2 / (C.scale * C.zoom);
    const hovered = this.hovered;
    // Lifting a hovered bar would misstate its value against the axis.
    const liftHeight = this.axis.show ? 0 : LIFT;

    for (const cell of cells) {
      R.ctx.globalAlpha = 1 - 0.55 * this.dimFor(cell);
      const lift = cell.lift.value;
      const box = { x0: cell.gx - w, x1: cell.gx + w, y0: cell.gy - w, y1: cell.gy + w };
      let z = lift * liftHeight;

      if (cell.total <= 0) {
        if (lo > 0) continue;
        // Keep empty cells pickable as a flat tile.
        const hits = drawBox(C, R, theme, { ...box, z0: z, z1: z + 0.015 }, parseHex(theme.grid));
        R.hit(hits, cell.parts[0]);
        continue;
      }
      const lastPart = cell.parts.findLast((p) => cell.value[p.index] > 0);
      for (const part of cell.parts) {
        const h = this.z(cell.value[part.index]);
        if (h <= 0) continue;
        const z0 = Math.max(z, lo);
        const z1 = Math.min(z + Math.max(h - (this.stack ? gap : 0), 0.015), hi);
        z += h;
        if (z1 <= z0) continue;
        const color = this.seriesColor(this.stack ? part.index : cell.j);
        const isHovered = part === hovered || (!this.stack && cell === hovered?.cell);
        const glow = 1 + (isHovered ? 0.14 : 0.06) * lift;
        // Only the very top of each bar blooms, stronger when hovered.
        const isTop = part === lastPart && hi === Infinity;
        const bloom = isTop ? theme.glow * (0.45 + 0.55 * lift) : 0;
        R.hit(drawBox(C, R, theme, { ...box, z0, z1 }, parseHex(color), { glow, bloom }), part);
      }
    }
  }

  _drawPlane(zp, ref) {
    const { camera: C, renderer: R, theme } = this;
    const ctx = R.ctx;
    const [hx, hy] = this.floorExtent();
    const P = (x, y) => C.project(x, y, zp);
    const rgb = parseHex(ref.color ?? theme.series[0]);
    const pts = [P(-hx, -hy), P(hx, -hy), P(hx, hy), P(-hx, hy)];
    ctx.globalAlpha = 1;
    R.polygon(pts, `rgba(${rgb.join(',')},0.1)`, `rgba(${rgb.join(',')},0.75)`, 1.25);

    // Label at the plane's leftmost corner.
    const left = pts.reduce((a, b) => (b.x < a.x ? b : a));
    const text = `${ref.label ? `${ref.label} ` : ''}${this.format(ref.value)}`;
    R.text(text, left.x - 8, left.y, { color: `rgb(${rgb.join(',')})`, size: 11, weight: 600, align: 'right', mono: true });
  }

  // options.labels: true (every bar, culled where they collide) or N (the
  // N tallest). Totals sit just above each bar's top.
  _drawValueLabels(cells) {
    const opt = this.options.labels;
    if (!opt) return;
    const { camera: C, renderer: R, theme } = this;
    let list = cells.filter((c) => c.total > 0 && !c.leaving);
    if (typeof opt === 'number') list = [...list].sort((a, b) => b.total - a.total).slice(0, opt);
    // Nearest first, so the most visible labels win collisions.
    list = [...list].sort((a, b) => C.groundDepth(b.gx, b.gy) - C.groundDepth(a.gx, a.gy));
    const placed = [];
    for (const cell of list) {
      const p = C.project(cell.gx, cell.gy, this.z(cell.total));
      const text = this.format(cell.total);
      const w = R.measure(text, 11, 600, true) + 8;
      const box = { l: p.x - w / 2, r: p.x + w / 2, t: p.y - 24, b: p.y - 8 };
      if (placed.some((q) => box.l < q.r && box.r > q.l && box.t < q.b && box.b > q.t)) continue;
      placed.push(box);
      R.ctx.globalAlpha = 1 - 0.6 * this.dimFor(cell);
      R.text(text, p.x, p.y - 15, { color: theme.text, size: 11, weight: 600, mono: true });
    }
    R.ctx.globalAlpha = 1;
  }

  describe(part) {
    const { cell } = part;
    const title = this.titleFor(
      cell,
      `${cell.x}${this.stack && cell.y !== '' ? ` · ${cell.y}` : ''}${this.frameSuffix()}`,
    );
    if (!this.stack) {
      return {
        title,
        rows: [{ label: String(cell.y || 'Value'), value: this.format(cell.total), color: this.seriesColor(cell.j) }],
      };
    }
    // Top of the stack first, so the list reads in the same order as the bar.
    const rows = [...cell.parts].reverse().map((p) => ({
      label: String(p.stack),
      value: this.format(cell.value[p.index]),
      color: this.seriesColor(p.index),
      active: p === part,
    }));
    rows.push({ label: 'Total', value: this.format(cell.total) });
    return { title, rows };
  }
}
