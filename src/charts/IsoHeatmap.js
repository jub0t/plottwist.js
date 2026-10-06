// A dense grid of tiles coloured on a sequential ramp, optionally extruded so
// height echoes the value. Works as a matrix heatmap or, with week/weekday
// axes, a 3D contribution calendar.

import { GridChart } from '../core/grid-chart.js';
import { drawBox } from '../core/shapes.js';
import { rampAt, rgbString, sequentialStops } from '../core/color.js';

const LIFT = 0.12;

export class IsoHeatmap extends GridChart {
  constructor(container, options = {}) {
    super(container, options);
    this.tileWidth = options.tileWidth ?? 0.86;
    this.extrude = options.extrude ?? true;
    // Tiles already cover the floor, so pooled light under them is wasted work.
    this.pools = false;
    // Colour carries the value; walls would only clutter a dense grid.
    this.defaultAxis = false;
    this.init();
  }

  get colorByRow() {
    return false;
  }

  defaultHeight(width, depth) {
    return Math.min(3, Math.max(1.2, Math.max(width, depth) * 0.12));
  }

  // options.colorScale: a named scale ('violet', 'emerald', 'orange', ...)
  // or an explicit array of stops, low -> high. Defaults to the theme's scale.
  get stops() {
    return sequentialStops(this.theme, this.options.colorScale ?? this.theme.scale);
  }

  colorFor(value) {
    return rampAt(this.stops, (value - this.minValue) / (this.maxValue - this.minValue));
  }

  markColor(cell) {
    return this.colorFor(cell.total);
  }

  drawMarks() {
    const { camera: C, renderer: R, theme } = this;
    const w = this.tileWidth / 2;
    for (const cell of this.sortedCells()) {
      if (!cell.present) continue;
      R.ctx.globalAlpha = 1 - 0.45 * this.dimFor(cell);
      const z0 = cell.lift.value * LIFT;
      const h = this.extrude ? this.z(cell.total) : 0;
      const box = {
        x0: cell.gx - w,
        x1: cell.gx + w,
        y0: cell.gy - w,
        y1: cell.gy + w,
        z0,
        z1: z0 + Math.max(h, 0.06),
      };
      const glow = 1 + 0.12 * cell.lift.value;
      // Only the hottest cells bloom, so the glow itself encodes intensity.
      const t = (cell.total - this.minValue) / (this.maxValue - this.minValue);
      const bloom = t > 0.45 || cell.lift.value > 0 ? theme.glow * (t * t * 0.8 + 0.5 * cell.lift.value) : 0;
      R.hit(drawBox(C, R, theme, box, this.colorFor(cell.total), { glow, bloom }), cell);
    }
  }

  // Gradient legend: the ramp from 0 to the shared max, top-right.
  drawLegend() {
    const { renderer: R, theme } = this;
    const ctx = R.ctx;
    const width = 120;
    const x = R.width - 20 - width;
    const y = 22;
    const grad = ctx.createLinearGradient(x, 0, x + width, 0);
    const stops = this.stops;
    stops.forEach((c, i) => grad.addColorStop(i / (stops.length - 1), c));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, y, width, 8, 4);
    ctx.fill();

    const hovered = this.hovered;
    if (hovered) {
      const t = Math.min(1, (hovered.total - this.minValue) / (this.maxValue - this.minValue));
      ctx.fillStyle = theme.text;
      ctx.beginPath();
      ctx.moveTo(x + t * width, y - 2);
      ctx.lineTo(x + t * width - 4, y - 7);
      ctx.lineTo(x + t * width + 4, y - 7);
      ctx.fill();
    }
    const label = { color: theme.textMuted, size: 11, mono: true };
    R.text(this.format(this.minValue), x, y + 20, { ...label, align: 'left' });
    R.text(this.format(this.maxValue), x + width, y + 20, { ...label, align: 'right' });
  }

  describe(cell) {
    const title = this.titleFor(
      cell,
      `${cell.x}${cell.y !== '' ? ` · ${cell.y}` : ''}${this.frameSuffix()}`,
    );
    return {
      title,
      rows: [
        {
          label: this.options.valueLabel ?? 'Value',
          value: this.format(cell.total),
          color: rgbString(this.colorFor(cell.total)),
        },
      ],
    };
  }
}
