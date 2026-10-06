// Line chart in depth: each series is an extruded ribbon in its own lane, with
// x (usually time) running along the floor. Lanes never tangle the way
// overlaid 2D lines do; switch to the 'front' view to read them as plain lines.

import { GridChart, key } from '../core/grid-chart.js';
import { Tween, ease } from '../core/animation.js';
import { faceBrightness, faceShade } from '../core/shapes.js';
import { parseHex, shade } from '../core/color.js';

export class IsoRibbonChart extends GridChart {
  constructor(container, options = {}) {
    super(container, { spacing: [0.5, 1.8], ...options });
    this.pools = false;
    this.thickness = options.thickness ?? 0.42;
    this.reveal = new Tween(1);
    this.crosshair = { x: true, y: false };
    this.init();
  }

  defaultHeight(width, depth) {
    return Math.max(2, Math.max(width, depth) * 0.22);
  }

  // First load draws the ribbons in from the left; later updates morph in a
  // wave along x.
  animateIn(first, now) {
    if (first) {
      for (const cell of this.cells.values()) cell.blend.set(1);
      this.reveal.set(0);
      this.reveal.to(1, now, { duration: 1800, easing: ease.cubicInOut });
      return;
    }
    for (const cell of this.cells.values()) {
      cell.blend.to(1, now, { duration: 700, delay: cell.i * 14, easing: ease.cubicOut });
    }
  }

  tick(now) {
    const active = this.reveal.tick(now);
    return super.tick(now) || active;
  }

  // Lanes: one array of cells per series, ordered along x.
  lanes() {
    const byRow = this.ys.map(() => []);
    for (const cell of this.cells.values()) if (cell.present && !cell.leaving) byRow[cell.j].push(cell);
    for (const lane of byRow) lane.sort((a, b) => a.i - b.i);
    return byRow;
  }

  drawMarks() {
    const { camera: C, renderer: R, theme } = this;
    const lanes = this.lanes()
      .map((cells, j) => ({ cells, j, gy: (j - (this.ys.length - 1) / 2) * this.spacing[1] }))
      .filter((l) => l.cells.length > 1)
      .sort((a, b) => C.groundDepth(0, a.gy) - C.groundDepth(0, b.gy));
    const hovered = this.cellOf(this.hovered);

    for (const lane of lanes) {
      const dim = hovered && hovered.j !== lane.j ? this.focus.value * 0.35 : 0;
      R.ctx.globalAlpha = 1 - dim;
      this.drawLane(lane);
    }
    R.ctx.globalAlpha = 1;

    // Crosshair markers: a dot on every ribbon at the hovered x.
    if (hovered && this.focus.value > 0) {
      R.ctx.globalAlpha = this.focus.value;
      for (const lane of lanes) {
        const cell = lane.cells.find((c) => c.i === hovered.i);
        if (!cell) continue;
        const p = C.project(cell.gx, lane.gy, this.z(cell.total));
        const ctx = R.ctx;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = this.seriesColor(lane.j);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = theme.surface;
        ctx.stroke();
      }
      R.ctx.globalAlpha = 1;
    }
  }

  drawLane({ cells, j, gy }) {
    const { camera: C, renderer: R, theme } = this;
    const rgb = parseHex(this.seriesColor(j));
    const half = this.thickness / 2;
    const ya = gy - half;
    const yb = gy + half;
    const P = (x, y, z) => C.project(x, y, z);

    // Points up to the reveal head, with an interpolated final point.
    const head = this.reveal.value * (cells.length - 1);
    const pts = [];
    for (let k = 0; k < cells.length; k++) {
      if (k <= head) pts.push({ x: cells[k].gx, z: this.z(cells[k].total), cell: cells[k] });
      else {
        const a = pts[pts.length - 1];
        const f = head - (k - 1);
        if (f > 0) pts.push({ x: a.x + (cells[k].gx - a.x) * f, z: a.z + (this.z(cells[k].total) - a.z) * f });
        break;
      }
    }
    if (pts.length < 2) return;

    // Near wall: the face of the lane turned toward the viewer.
    const nearY = C.faces(0, 1, 0) ? yb : ya;
    const wallN = [0, Math.sign(nearY - gy), 0];
    const first = pts[0];
    const last = pts[pts.length - 1];

    // Top strips, far to near along x.
    const order = pts.slice(0, -1).map((_, k) => k);
    order.sort((a, b) => C.groundDepth(pts[a].x, gy) - C.groundDepth(pts[b].x, gy));
    for (const k of order) {
      const a = pts[k];
      const b = pts[k + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const n = [-dz / len, 0, dx / len];
      if (!C.faces(...n)) continue;
      const fill = faceShade(C, theme, n, rgb, 1.08);
      R.polygon([P(a.x, ya, a.z), P(b.x, ya, b.z), P(b.x, yb, b.z), P(a.x, yb, a.z)], fill, fill, 0.75);
    }

    // Walls and caps fade toward the floor so lanes behind stay readable.
    const peak = Math.max(...pts.map((p) => p.z));
    const fade = (x, y, n, k = 1) => {
      const top = P(x, y, peak);
      const bottom = P(x, y, 0);
      const b = faceBrightness(C, theme, n, k);
      const grad = R.ctx.createLinearGradient(0, top.y, 0, bottom.y);
      grad.addColorStop(0, shade(rgb, b));
      grad.addColorStop(1, shade(rgb, b * (1 - 0.3 * theme.gradient), 1 - 0.85 * theme.gradient));
      return grad;
    };

    // End cap facing the viewer.
    const cap = C.faces(1, 0, 0) ? last : C.faces(-1, 0, 0) ? first : null;
    if (cap) {
      const n = [cap === last ? 1 : -1, 0, 0];
      const fill = fade(cap.x, gy, n);
      R.polygon([P(cap.x, ya, 0), P(cap.x, yb, 0), P(cap.x, yb, cap.z), P(cap.x, ya, cap.z)], fill);
    }

    if (C.faces(...wallN)) {
      const wall = [P(first.x, nearY, 0), ...pts.map((p) => P(p.x, nearY, p.z)), P(last.x, nearY, 0)];
      R.polygon(wall, fade((first.x + last.x) / 2, nearY, wallN, 0.92));
    }

    // Crisp 2px line along the near top edge carries the actual reading. On
    // glowing themes a wide, faint stroke underneath fakes the bloom cheaply.
    const ctx = R.ctx;
    ctx.beginPath();
    pts.forEach((p, k) => {
      const s = P(p.x, nearY, p.z);
      k ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y);
    });
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (theme.glow > 0) {
      ctx.strokeStyle = shade(rgb, 1.2, 0.22 * theme.glow);
      ctx.lineWidth = 7;
      ctx.stroke();
    }
    ctx.strokeStyle = shade(rgb, 1.3);
    ctx.lineWidth = 2;
    ctx.stroke();

    // Hit regions: one per point, spanning half-way to its neighbours.
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      if (!p.cell) continue;
      const l = pts[k - 1] ? mid(pts[k - 1], p) : p;
      const r = pts[k + 1] ? mid(p, pts[k + 1]) : p;
      R.hit(
        [
          [P(l.x, nearY, 0), P(l.x, nearY, l.z), P(p.x, nearY, p.z), P(r.x, nearY, r.z), P(r.x, nearY, 0)],
          [P(l.x, ya, l.z), P(p.x, ya, p.z), P(r.x, ya, r.z), P(r.x, yb, r.z), P(p.x, yb, p.z), P(l.x, yb, l.z)],
        ],
        p.cell,
      );
    }
  }

  // One tooltip for the whole x position: every series' value there.
  describe(datum) {
    const cell = this.cellOf(datum);
    const rows = this.ys.map((yv, j) => {
      const c = this.cells.get(key(cell.x, yv));
      return {
        label: String(yv),
        value: c?.present ? this.format(c.total) : '–',
        color: this.seriesColor(j),
        active: j === cell.j,
      };
    });
    return { title: this.titleFor(cell, `${cell.x}${this.frameSuffix()}`), rows };
  }
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
