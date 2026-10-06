// A continuous surface over a grid of values: a lit, coloured landscape with
// contour lines, cut out as a solid block. Each record is one grid point
// (x, y, value); frames morph the whole terrain smoothly.
//
//   new IsoSurface(el, { data, x: 'col', y: 'row', value: 'signal', contours: 8 })

import { IsoHeatmap } from './IsoHeatmap.js';
import { niceTicks } from '../core/grid-chart.js';
import { faceBrightness } from '../core/shapes.js';
import { shade } from '../core/color.js';

export class IsoSurface extends IsoHeatmap {
  constructor(container, options = {}) {
    // Heights are read against the value axis; the floor is covered anyway.
    super(container, { axis: true, grid: 'none', ...options });
    this.crosshair = { x: false, y: false };
  }

  defaultHeight(width, depth) {
    return Math.max(2.5, Math.max(width, depth) * 0.32);
  }

  // Contour levels: options.contours as a count (default 8), an explicit
  // list of values, or false for none.
  get levels() {
    const c = this.options.contours ?? 8;
    if (c === false || c === 0) return [];
    if (Array.isArray(c)) return c;
    return niceTicks(this.maxValue, c).filter((v) => v > 0 && v < this.maxValue);
  }

  // Grid of the cells' current values, [i][j].
  heightGrid() {
    const nx = this.xs.length;
    const ny = this.ys.length;
    const grid = Array.from({ length: nx }, () => new Array(ny).fill(null));
    for (const cell of this.cells.values()) if (!cell.leaving && cell.i < nx && cell.j < ny) grid[cell.i][cell.j] = cell;
    return grid;
  }

  drawMarks() {
    const { camera: C, renderer: R, theme } = this;
    const ctx = R.ctx;
    const grid = this.heightGrid();
    const nx = this.xs.length;
    const ny = this.ys.length;
    if (nx < 2 || ny < 2) return;
    const P = (x, y, z) => C.project(x, y, z);
    const val = (i, j) => grid[i][j]?.total ?? 0;
    const levels = this.levels;
    const lineColor = theme.mode === 'dark' ? 'rgba(255,255,255,0.32)' : 'rgba(30,20,70,0.28)';
    const mesh = this.options.mesh ?? false;

    // Quads far to near; within each, two triangles split along the diagonal.
    const quads = [];
    for (let i = 0; i < nx - 1; i++) for (let j = 0; j < ny - 1; j++) quads.push([i, j]);
    const gx = (i) => grid[i][0]?.gx ?? (i - (nx - 1) / 2) * this.spacing[0];
    const gy = (j) => grid[0][j]?.gy ?? (j - (ny - 1) / 2) * this.spacing[1];
    quads.sort((a, b) => C.groundDepth(gx(a[0]) + gx(a[0] + 1), gy(a[1]) + gy(a[1] + 1)) - C.groundDepth(gx(b[0]) + gx(b[0] + 1), gy(b[1]) + gy(b[1] + 1)));

    const hovered = this.cellOf(this.hovered);
    for (const [i, j] of quads) {
      const corners = [
        [i, j],
        [i + 1, j],
        [i + 1, j + 1],
        [i, j + 1],
      ].map(([a, b]) => ({ x: gx(a), y: gy(b), v: val(a, b), cell: grid[a][b] }));
      for (const z of corners) z.z = this.z(z.v);
      const tris = [
        [corners[0], corners[1], corners[2]],
        [corners[0], corners[2], corners[3]],
      ];
      // Farther triangle first.
      const depth = (t) => C.groundDepth(t[0].x + t[1].x + t[2].x, t[0].y + t[1].y + t[2].y);
      if (depth(tris[0]) > depth(tris[1])) tris.reverse();
      for (const tri of tris) {
        const [a, b, c] = tri;
        const n = normal(a, b, c);
        // Slopes facing away are always hidden by nearer terrain.
        if (!C.faces(...n)) continue;
        const avg = (a.v + b.v + c.v) / 3;
        const k = faceBrightness(C, theme, n);
        const fill = shade(this.colorFor(avg), k);
        const pts = tri.map((p) => P(p.x, p.y, p.z));
        R.polygon(pts, fill, fill, 0.6);
        // Contour segments inside this triangle, drawn right after it so
        // nearer terrain hides them like it hides the surface.
        if (levels.length) {
          ctx.beginPath();
          for (const level of levels) {
            const seg = isoSegment(tri, level);
            if (!seg) continue;
            const s0 = P(seg[0].x, seg[0].y, this.z(level));
            const s1 = P(seg[1].x, seg[1].y, this.z(level));
            ctx.moveTo(s0.x, s0.y);
            ctx.lineTo(s1.x, s1.y);
          }
          ctx.strokeStyle = lineColor;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      if (mesh) {
        const pts = corners.map((p) => P(p.x, p.y, p.z));
        R.polygon(pts, null, lineColor, 0.5);
      }
      // Hit regions: each quarter of the quad picks its nearest grid point.
      const mid = { x: (corners[0].x + corners[2].x) / 2, y: (corners[0].y + corners[2].y) / 2 };
      mid.z = this.z(corners.reduce((s, p) => s + p.v, 0) / 4);
      corners.forEach((p, q) => {
        if (!p.cell) return;
        const prev = corners[(q + 3) % 4];
        const next = corners[(q + 1) % 4];
        const half = (u) => ({ x: (p.x + u.x) / 2, y: (p.y + u.y) / 2, z: (p.z + u.z) / 2 });
        R.hit([[p, half(next), mid, half(prev)].map((u) => P(u.x, u.y, u.z))], p.cell);
      });
    }

    this.drawSkirts(grid, gx, gy);
    if (hovered && this.focus.value > 0) this.drawProbe(grid, gx, gy, hovered);
  }

  // Walls down the edges that face the viewer make the terrain a solid block.
  drawSkirts(grid, gx, gy) {
    const { camera: C, renderer: R, theme } = this;
    const nx = this.xs.length;
    const ny = this.ys.length;
    const P = (x, y, z) => C.project(x, y, z);
    const edges = [
      { n: [0, -1, 0], pts: Array.from({ length: nx }, (_, i) => [i, 0]) },
      { n: [0, 1, 0], pts: Array.from({ length: nx }, (_, i) => [i, ny - 1]) },
      { n: [-1, 0, 0], pts: Array.from({ length: ny }, (_, j) => [0, j]) },
      { n: [1, 0, 0], pts: Array.from({ length: ny }, (_, j) => [nx - 1, j]) },
    ];
    for (const { n, pts } of edges) {
      if (!C.faces(...n)) continue;
      const top = pts.map(([i, j]) => ({ x: gx(i), y: gy(j), v: grid[i][j]?.total ?? 0 }));
      // One strip per segment, coloured by its height, so the wall reads as
      // a cross-section of the terrain.
      for (let k = 0; k < top.length - 1; k++) {
        const a = top[k];
        const b = top[k + 1];
        const rgb = this.colorFor((a.v + b.v) / 2);
        const fill = shade(rgb, faceBrightness(C, theme, n) * 0.8);
        const poly = [P(a.x, a.y, 0), P(b.x, b.y, 0), P(b.x, b.y, this.z(b.v)), P(a.x, a.y, this.z(a.v))];
        R.polygon(poly, fill, fill, 0.6);
      }
    }
  }

  // Hovered point: its row and column traced over the surface, a ring on
  // the point and a drop line to the floor.
  drawProbe(grid, gx, gy, cell) {
    const { camera: C, renderer: R, theme } = this;
    const ctx = R.ctx;
    const P = (x, y, z) => C.project(x, y, z);
    ctx.globalAlpha = this.focus.value;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = theme.text;
    ctx.setLineDash([]);
    for (const line of [
      grid.map((col) => col[cell.j]),
      grid[cell.i],
    ]) {
      ctx.beginPath();
      line.forEach((c, k) => {
        if (!c) return;
        const p = P(c.gx, c.gy, this.z(c.total));
        k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      });
      ctx.globalAlpha = this.focus.value * 0.55;
      ctx.stroke();
    }
    ctx.globalAlpha = this.focus.value;
    const top = P(cell.gx, cell.gy, this.z(cell.total));
    const base = P(cell.gx, cell.gy, 0);
    ctx.setLineDash([3, 3]);
    R.line(base, top, theme.text, 1);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(top.x, top.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = shade(this.colorFor(cell.total), 1.15);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = theme.surface;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

// Upward-ish normal of a triangle of world points.
function normal(a, b, c) {
  const u = [b.x - a.x, b.y - a.y, b.z - a.z];
  const v = [c.x - a.x, c.y - a.y, c.z - a.z];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1;
  return n.map((x) => x / l);
}

// The segment where a triangle crosses `level`, as two { x, y } points, or null.
function isoSegment(tri, level) {
  const out = [];
  for (let k = 0; k < 3; k++) {
    const a = tri[k];
    const b = tri[(k + 1) % 3];
    if ((a.v < level) === (b.v < level)) continue;
    const t = (level - a.v) / (b.v - a.v);
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out.length === 2 ? out : null;
}
