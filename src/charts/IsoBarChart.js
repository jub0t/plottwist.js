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

  drawMarks() {
    const { camera: C, renderer: R, theme } = this;
    const w = this.barWidth / 2;
    // A 2px surface gap between stacked parts, in world units.
    const gap = 2 / (C.scale * C.zoom);
    const hovered = this.hovered;

    for (const cell of this.sortedCells()) {
      R.ctx.globalAlpha = 1 - 0.55 * this.dimFor(cell);
      const lift = cell.lift.value;
      const box = { x0: cell.gx - w, x1: cell.gx + w, y0: cell.gy - w, y1: cell.gy + w };
      let z = lift * LIFT;

      if (cell.total <= 0) {
        // Keep empty cells pickable as a flat tile.
        const hits = drawBox(C, R, theme, { ...box, z0: z, z1: z + 0.015 }, parseHex(theme.grid));
        R.hit(hits, cell.parts[0]);
        continue;
      }
      for (const part of cell.parts) {
        const h = this.z(cell.value[part.index]);
        if (h <= 0) continue;
        const color = this.seriesColor(this.stack ? part.index : cell.j);
        const isHovered = part === hovered || (!this.stack && cell === hovered?.cell);
        const glow = 1 + (isHovered ? 0.14 : 0.06) * lift;
        const z1 = z + Math.max(h - (this.stack ? gap : 0), 0.015);
        // Only the top of each bar blooms, stronger when hovered.
        const isTop = part.index === cell.parts.length - 1 || !this.stack;
        const bloom = theme.glow * ((isTop ? 0.45 : 0) + 0.55 * lift);
        R.hit(drawBox(C, R, theme, { ...box, z0: z, z1 }, parseHex(color), { glow, bloom }), part);
        z += h;
      }
    }
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
