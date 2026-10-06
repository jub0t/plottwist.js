// A continuous surface over a grid of values: a lit, coloured landscape with
// contour lines. Each record is one grid point (x, y, value); frames morph
// the whole terrain smoothly.
//
//   new IsoSurface(el, { data, x: 'col', y: 'row', value: 'signal' })
//
// Look options (all optional):
//   smooth: 3                 bicubic subdivision: coarse data, smooth terrain
//   shading: 'smooth'|'flat'  vertex-averaged or per-facet lighting
//   colorBy: 'height'|'slope' what the colour ramp follows
//   bands: true | n           stepped (hypsometric) colours instead of a ramp
//   style: 'solid'|'wireframe'
//   contours: 8 | [values] | false, contourColor, contourWidth
//   mesh: true, meshColor     grid lines over the surface
//   float: 1.2                lift the terrain and project a contour map below
//   water: 30 | { value, color, opacity, label }  a level that floods the lows
//   peaks: 3                  label the highest local maxima
//   skirt: false              no solid walls along the edges

import { IsoHeatmap } from './IsoHeatmap.js';
import { niceTicks } from '../core/grid-chart.js';
import { faceBrightness } from '../core/shapes.js';
import { parseHex, rampAt, shade } from '../core/color.js';
import { claim } from '../core/stage.js';

export class IsoSurface extends IsoHeatmap {
  constructor(container, options = {}) {
    // Heights are read against the value axis; the floor is covered anyway.
    super(container, { grid: 'none', ...options });
    this.crosshair = { x: false, y: false };
  }

  // Heights are read against the value axis, except on a floating surface,
  // which has no floor to measure from.
  get defaultAxis() {
    return !this.options.float;
  }

  set defaultAxis(_) {}

  sceneBounds() {
    const pts = super.sceneBounds();
    const lift = this.floatHeight;
    if (lift > 0) {
      const [hx, hy] = this.floorExtent();
      for (const [x, y] of [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]) pts.push([x, y, this.maxHeight + lift, { t: 8 }]);
    }
    if (this.options.peaks) for (const p of pts.filter((q) => q[2] >= this.maxHeight)) p[3] = { ...p[3], t: Math.max(p[3]?.t ?? 0, 30) };
    return pts;
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

  get floatHeight() {
    return Math.max(0, this.options.float ?? 0);
  }

  // The water level doubles as the axis reference, so tick labels make room
  // for its label.
  get reference() {
    return this.water;
  }

  // Subdivision factor: options.smooth, or automatic for small grids.
  get smoothing() {
    const n = this.xs.length * this.ys.length;
    const auto = n <= 400 ? 3 : n <= 1600 ? 2 : 1;
    return Math.max(1, Math.min(6, Math.round(this.options.smooth ?? auto)));
  }

  get water() {
    const w = this.options.water;
    if (w == null || w === false) return null;
    return typeof w === 'object' ? w : { value: w };
  }

  // Grid of the cells' current values, [i][j].
  heightGrid() {
    const nx = this.xs.length;
    const ny = this.ys.length;
    const grid = Array.from({ length: nx }, () => new Array(ny).fill(null));
    for (const cell of this.cells.values()) if (!cell.leaving && cell.i < nx && cell.j < ny) grid[cell.i][cell.j] = cell;
    return grid;
  }

  // The rendered mesh: the data grid, optionally subdivided with Catmull-Rom
  // interpolation. Each vertex keeps the data cell nearest to it for picking.
  buildMesh() {
    const grid = this.heightGrid();
    const nx = this.xs.length;
    const ny = this.ys.length;
    const k = this.smoothing;
    const V = (i, j) => grid[Math.max(0, Math.min(nx - 1, i))][Math.max(0, Math.min(ny - 1, j))]?.total ?? 0;
    const gx = (i) => (i - (nx - 1) / 2) * this.spacing[0];
    const gy = (j) => (j - (ny - 1) / 2) * this.spacing[1];
    const mx = (nx - 1) * k + 1;
    const my = (ny - 1) * k + 1;
    const lift = this.floatHeight;
    const verts = Array.from({ length: mx }, (_, a) =>
      Array.from({ length: my }, (_, b) => {
        const fi = a / k;
        const fj = b / k;
        let v;
        if (k === 1) v = V(a, b);
        else {
          // Bicubic Catmull-Rom over the 4 x 4 neighbourhood; clamped at 0.
          const i0 = Math.floor(fi);
          const j0 = Math.floor(fj);
          const ti = fi - i0;
          const tj = fj - j0;
          const rows = [-1, 0, 1, 2].map((di) => catmull(V(i0 + di, j0 - 1), V(i0 + di, j0), V(i0 + di, j0 + 1), V(i0 + di, j0 + 2), tj));
          v = Math.max(0, catmull(rows[0], rows[1], rows[2], rows[3], ti));
        }
        const ci = Math.round(fi);
        const cj = Math.round(fj);
        return { x: gx(fi), y: gy(fj), v, z: this.z(v) + lift, cell: grid[ci]?.[cj] ?? null };
      }),
    );

    // Vertex normals from central differences, for smooth shading and slope.
    let maxSlope = 1e-9;
    for (let a = 0; a < mx; a++) {
      for (let b = 0; b < my; b++) {
        const p = verts[a][b];
        const l = verts[Math.max(0, a - 1)][b];
        const r = verts[Math.min(mx - 1, a + 1)][b];
        const d = verts[a][Math.max(0, b - 1)];
        const u = verts[a][Math.min(my - 1, b + 1)];
        const dzx = (r.z - l.z) / (r.x - l.x || 1);
        const dzy = (u.z - d.z) / (u.y - d.y || 1);
        const len = Math.hypot(dzx, dzy, 1);
        p.n = [-dzx / len, -dzy / len, 1 / len];
        p.slope = Math.hypot(dzx, dzy);
        maxSlope = Math.max(maxSlope, p.slope);
      }
    }
    return { verts, mx, my, maxSlope };
  }

  // Ramp position in [0, 1] for a vertex (before banding).
  tone(p, mesh) {
    return this.options.colorBy === 'slope' ? p.slope / mesh.maxSlope : p.v / this.maxValue;
  }

  // [lo, hi, rgb] value ranges of the colour bands: between the contour
  // levels for bands: true, or n equal steps for bands: n.
  bandRanges() {
    const bands = this.options.bands;
    const edges =
      typeof bands === 'number'
        ? Array.from({ length: bands - 1 }, (_, i) => ((i + 1) / bands) * this.maxValue)
        : this.levels;
    const n = edges.length + 1;
    return Array.from({ length: n }, (_, i) => [
      i === 0 ? -Infinity : edges[i - 1],
      i === n - 1 ? Infinity : edges[i],
      rampAt(this.stops, n > 1 ? i / (n - 1) : 1),
    ]);
  }

  // Ramp colour for a ramp position, stepped into bands when asked.
  rampColor(t) {
    const bands = this.options.bands;
    if (bands) {
      const n = typeof bands === 'number' ? bands : Math.max(2, this.levels.length + 1);
      t = Math.min(n - 1, Math.floor(Math.max(0, Math.min(0.9999, t)) * n)) / (n - 1);
    }
    return rampAt(this.stops, t);
  }

  drawMarks() {
    const nx = this.xs.length;
    const ny = this.ys.length;
    if (nx < 2 || ny < 2) return;
    const mesh = this.buildMesh();
    this._mesh = mesh;
    const { camera: C, renderer: R, theme } = this;
    for (const row of mesh.verts) for (const p of row) p.k = faceBrightness(C, theme, p.n);

    if (this.floatHeight > 0) this.drawFloorMap(mesh);

    // Quads far to near. With a water level, everything below it is drawn
    // first, then the water, then what rises above: exact for a height field
    // seen from above, the same way bars meet a reference plane.
    const quads = [];
    for (let a = 0; a < mesh.mx - 1; a++) for (let b = 0; b < mesh.my - 1; b++) quads.push([a, b]);
    const V = mesh.verts;
    quads.sort((q, w) => C.groundDepth(V[q[0]][q[1]].x + V[q[0] + 1][q[1] + 1].x, V[q[0]][q[1]].y + V[q[0] + 1][q[1] + 1].y) -
      C.groundDepth(V[w[0]][w[1]].x + V[w[0] + 1][w[1] + 1].x, V[w[0]][w[1]].y + V[w[0] + 1][w[1] + 1].y));

    const water = this.water;
    if (water) {
      const zw = this.z(water.value) + this.floatHeight;
      this.drawQuads(quads, mesh, -Infinity, zw);
      this.drawWater(mesh, water, zw);
      this.drawQuads(quads, mesh, zw, Infinity);
    } else {
      this.drawQuads(quads, mesh, -Infinity, Infinity);
    }

    if (this.options.skirt !== false) this.drawSkirts(mesh);
    if (water && this.options.skirt !== false && this.floatHeight === 0) this.drawWaterSides(mesh, water);
    this.drawPeaks();
    const hovered = this.cellOf(this.hovered);
    if (hovered && this.focus.value > 0) this.drawProbe(hovered);
  }

  // Fill (and contour) every quad within the height band [lo, hi).
  drawQuads(quads, mesh, lo, hi) {
    const { camera: C, renderer: R, theme } = this;
    const ctx = R.ctx;
    const V = mesh.verts;
    const P = (p) => C.project(p.x, p.y, p.z);
    const levels = this.levels;
    const lift = this.floatHeight;
    const dark = theme.mode === 'dark';
    const contourColor = this.options.contourColor ?? (dark ? 'rgba(255,255,255,0.34)' : 'rgba(30,20,70,0.3)');
    const contourWidth = this.options.contourWidth ?? 1;
    const wire = this.options.style === 'wireframe';
    const meshOn = this.options.mesh || wire;
    const meshColor = this.options.meshColor;
    const flat = this.options.shading === 'flat';
    const clipped = lo !== -Infinity || hi !== Infinity;

    for (const [a, b] of quads) {
      const c = [V[a][b], V[a + 1][b], V[a + 1][b + 1], V[a][b + 1]];
      const tris = [
        [c[0], c[1], c[2]],
        [c[0], c[2], c[3]],
      ];
      const depth = (t) => C.groundDepth(t[0].x + t[1].x + t[2].x, t[0].y + t[1].y + t[2].y);
      if (depth(tris[0]) > depth(tris[1])) tris.reverse();
      for (const tri of tris) {
        const n = flat ? normal(tri[0], tri[1], tri[2]) : null;
        // Slopes facing away are always hidden by nearer terrain.
        if (n && !C.faces(...n)) continue;
        if (!n && !C.faces(...normal(tri[0], tri[1], tri[2]))) continue;
        const poly = clipped ? clipZ(tri, lo, hi) : tri;
        if (poly.length < 3) continue;
        let k = n ? faceBrightness(C, theme, n) : (tri[0].k + tri[1].k + tri[2].k) / 3;
        // Banded colours carry the reading; soften the lighting so they show.
        if (this.options.bands) k = 0.45 + 0.55 * k;
        const t = (this.tone(tri[0], mesh) + this.tone(tri[1], mesh) + this.tone(tri[2], mesh)) / 3;
        const rgb = this.rampColor(t);
        if (this.options.bands && !wire && this.options.colorBy !== 'slope') {
          // Crisp topographic steps: cut the triangle at the band edges.
          for (const [b0, b1, color] of this.bandRanges()) {
            const piece = clipBy(poly, 'v', b0, b1);
            if (piece.length < 3) continue;
            const f = shade(color, k);
            R.polygon(piece.map(P), f, f, 0.6);
          }
        } else {
          const fill = wire ? theme.surface : shade(rgb, k);
          R.polygon(poly.map(P), fill, fill, 0.6);
        }

        if (levels.length) {
          ctx.beginPath();
          for (const level of levels) {
            const z = this.z(level) + lift;
            if (z < lo || z >= hi) continue;
            const seg = isoSegment(tri, level);
            if (!seg) continue;
            const s0 = C.project(seg[0].x, seg[0].y, z);
            const s1 = C.project(seg[1].x, seg[1].y, z);
            ctx.moveTo(s0.x, s0.y);
            ctx.lineTo(s1.x, s1.y);
          }
          ctx.strokeStyle = wire ? shade(rgb, 1.25, 0.5) : contourColor;
          ctx.lineWidth = contourWidth;
          ctx.stroke();
        }
      }
      if (meshOn) {
        const quad = clipped ? clipZ(c, lo, hi) : c;
        if (quad.length >= 3) {
          const t = (this.tone(c[0], mesh) + this.tone(c[2], mesh)) / 2;
          const stroke = meshColor ?? (wire ? shade(this.rampColor(t), 1.3) : contourColor);
          R.polygon(quad.map(P), null, stroke, wire ? 1 : 0.5);
        }
      }
      // Hit regions: each quarter of the quad picks its nearest data point.
      if (lo === -Infinity || hi === Infinity) {
        if (clipped && hi !== Infinity) continue; // register hits once, in the upper pass
        const mid = { x: (c[0].x + c[2].x) / 2, y: (c[0].y + c[2].y) / 2, z: (c[0].z + c[1].z + c[2].z + c[3].z) / 4 };
        c.forEach((p, q) => {
          if (!p.cell) return;
          const prev = c[(q + 3) % 4];
          const next = c[(q + 1) % 4];
          const half = (u) => ({ x: (p.x + u.x) / 2, y: (p.y + u.y) / 2, z: (p.z + u.z) / 2 });
          R.hit([[p, half(next), mid, half(prev)].map(P)], p.cell);
        });
      }
    }
  }

  // With `float`, the floor carries a flat colour map of the terrain and its
  // contour lines, like a map laid under a model.
  drawFloorMap(mesh) {
    const { camera: C, renderer: R, theme } = this;
    const ctx = R.ctx;
    const V = mesh.verts;
    const stops = this.stops;
    ctx.globalAlpha = 0.8;
    for (let a = 0; a < mesh.mx - 1; a++) {
      for (let b = 0; b < mesh.my - 1; b++) {
        const c = [V[a][b], V[a + 1][b], V[a + 1][b + 1], V[a][b + 1]];
        const t = (this.tone(c[0], mesh) + this.tone(c[1], mesh) + this.tone(c[2], mesh) + this.tone(c[3], mesh)) / 4;
        const fill = shade(this.rampColor(t), 0.75);
        R.polygon(c.map((p) => C.project(p.x, p.y, 0.005)), fill, fill, 0.6);
      }
    }
    ctx.globalAlpha = 1;
    const levels = this.levels;
    if (!levels.length) return;
    ctx.beginPath();
    for (let a = 0; a < mesh.mx - 1; a++) {
      for (let b = 0; b < mesh.my - 1; b++) {
        const c = [V[a][b], V[a + 1][b], V[a + 1][b + 1], V[a][b + 1]];
        for (const tri of [[c[0], c[1], c[2]], [c[0], c[2], c[3]]]) {
          for (const level of levels) {
            const seg = isoSegment(tri, level);
            if (!seg) continue;
            const s0 = C.project(seg[0].x, seg[0].y, 0.01);
            const s1 = C.project(seg[1].x, seg[1].y, 0.01);
            ctx.moveTo(s0.x, s0.y);
            ctx.lineTo(s1.x, s1.y);
          }
        }
      }
    }
    ctx.strokeStyle = theme.mode === 'dark' ? 'rgba(255,255,255,0.4)' : 'rgba(30,20,70,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  waterRgb(water) {
    return parseHex(water.color ?? (this.theme.mode === 'dark' ? '#38bdf8' : '#0ea5e9'));
  }

  // The water surface over the whole grid, translucent.
  drawWater(mesh, water, zw) {
    const { camera: C, renderer: R, theme } = this;
    const V = mesh.verts;
    const a = V[0][0];
    const b = V[mesh.mx - 1][mesh.my - 1];
    const rgb = this.waterRgb(water);
    const opacity = water.opacity ?? 0.42;
    const pts = [C.project(a.x, a.y, zw), C.project(b.x, a.y, zw), C.project(b.x, b.y, zw), C.project(a.x, b.y, zw)];
    R.polygon(pts, `rgba(${rgb.join(',')},${opacity})`, `rgba(${rgb.join(',')},0.9)`, 1.25);
    // Label at the leftmost corner, like a reference plane.
    const left = pts.reduce((p, q) => (q.x < p.x ? q : p));
    const text = `${water.label ? `${water.label} ` : ''}${this.format(water.value)}`;
    R.text(text, left.x - 8, left.y, { color: `rgb(${rgb.join(',')})`, size: 11, weight: 600, align: 'right', mono: true, halo: theme.surface });
  }

  // Translucent water fronts on the near edges, above the terrain profile.
  drawWaterSides(mesh, water) {
    const { camera: C, renderer: R } = this;
    const zw = this.z(water.value);
    const rgb = this.waterRgb(water);
    const fill = `rgba(${rgb.join(',')},${(water.opacity ?? 0.42) * 0.8})`;
    for (const { n, pts } of this.edges(mesh)) {
      if (!C.faces(...n) || pts.every((p) => p.z >= zw)) continue;
      // One polygon per edge: along the water line, back along the terrain.
      const top = pts.map((p) => C.project(p.x, p.y, zw));
      const bottom = pts.map((p) => C.project(p.x, p.y, Math.min(p.z, zw))).reverse();
      R.polygon([...top, ...bottom], fill);
    }
  }

  edges(mesh) {
    const V = mesh.verts;
    return [
      { n: [0, -1, 0], pts: V.map((col) => col[0]) },
      { n: [0, 1, 0], pts: V.map((col) => col[mesh.my - 1]) },
      { n: [-1, 0, 0], pts: V[0] },
      { n: [1, 0, 0], pts: V[mesh.mx - 1] },
    ];
  }

  // Walls down the edges that face the viewer make the terrain a solid block.
  drawSkirts(mesh) {
    const { camera: C, renderer: R, theme } = this;
    const wire = this.options.style === 'wireframe';
    const P = (x, y, z) => C.project(x, y, z);
    for (const { n, pts } of this.edges(mesh)) {
      if (!C.faces(...n)) continue;
      // One strip per segment, coloured by its height, so the wall reads as
      // a cross-section of the terrain.
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k];
        const b = pts[k + 1];
        const rgb = this.rampColor((this.tone(a, this._mesh) + this.tone(b, this._mesh)) / 2);
        const fill = wire ? theme.surface : shade(rgb, faceBrightness(C, theme, n) * 0.8);
        // A floating surface gets a thin rim instead of walls to the floor.
        const rim = this.floatHeight > 0 ? 0.22 : null;
        const za = rim ? a.z - rim : 0;
        const zb = rim ? b.z - rim : 0;
        const poly = [P(a.x, a.y, za), P(b.x, b.y, zb), P(b.x, b.y, b.z), P(a.x, a.y, a.z)];
        R.polygon(poly, fill, wire ? shade(rgb, 1.3) : fill, wire ? 1 : 0.6);
      }
    }
  }

  // options.peaks: label the N highest local maxima of the data.
  drawPeaks() {
    const count = this.options.peaks;
    if (!count) return;
    const { camera: C, renderer: R, theme } = this;
    const grid = this.heightGrid();
    const nx = this.xs.length;
    const ny = this.ys.length;
    const peaks = [];
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const c = grid[i][j];
        if (!c) continue;
        let top = true;
        for (let di = -2; di <= 2 && top; di++) {
          for (let dj = -2; dj <= 2; dj++) {
            const o = grid[i + di]?.[j + dj];
            if (o && o !== c && o.total > c.total) {
              top = false;
              break;
            }
          }
        }
        if (top && c.total > 0) peaks.push(c);
      }
    }
    peaks.sort((a, b) => b.total - a.total);
    const placed = [];
    const ink = theme.markText ?? theme.text;
    const halo = theme.markHalo ?? theme.surface;
    for (const c of peaks.slice(0, count)) {
      const p = C.project(c.gx, c.gy, this.z(c.total) + this.floatHeight);
      const name = this.options.label ? this.titleFor(c, '') : '';
      const value = this.format(c.total);
      const w = Math.max(R.measure(name, 11, 600), R.measure(value, 11, 600, true)) / 2 + 4;
      if (!claim(placed, { l: p.x - w, r: p.x + w, t: p.y - (name ? 36 : 24), b: p.y - 4 })) continue;
      R.ctx.fillStyle = ink;
      R.ctx.beginPath();
      R.ctx.moveTo(p.x, p.y - 3);
      R.ctx.lineTo(p.x - 4, p.y - 9);
      R.ctx.lineTo(p.x + 4, p.y - 9);
      R.ctx.fill();
      R.text(value, p.x, p.y - 17, { color: ink, size: 11, weight: 600, mono: true, halo });
      if (name) R.text(name, p.x, p.y - 30, { color: ink, size: 11, weight: 600, halo });
    }
  }

  // Hovered point: its row and column traced over the surface, a ring on
  // the point and a drop line to the floor.
  drawProbe(cell) {
    const { camera: C, renderer: R, theme } = this;
    const ctx = R.ctx;
    const mesh = this._mesh;
    const k = this.smoothing;
    const P = (p) => C.project(p.x, p.y, p.z);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = theme.text;
    ctx.setLineDash([]);
    ctx.globalAlpha = this.focus.value * 0.55;
    for (const line of [mesh.verts.map((col) => col[cell.j * k]), mesh.verts[cell.i * k]]) {
      if (!line) continue;
      ctx.beginPath();
      line.forEach((p, n) => {
        if (!p) return;
        const s = P(p);
        n ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y);
      });
      ctx.stroke();
    }
    ctx.globalAlpha = this.focus.value;
    const top = C.project(cell.gx, cell.gy, this.z(cell.total) + this.floatHeight);
    const base = C.project(cell.gx, cell.gy, 0);
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

  // The level line to the axis starts from the (possibly floating) surface.
  levelValue(datum) {
    return this.cellOf(datum).total;
  }
}

// Catmull-Rom spline through p1..p2 at t, with neighbours p0 and p3.
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t2 * t);
}

// Upward-ish normal of a triangle of world points.
function normal(a, b, c) {
  const u = [b.x - a.x, b.y - a.y, b.z - a.z];
  const v = [c.x - a.x, c.y - a.y, c.z - a.z];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1;
  return n.map((x) => x / l);
}

// The segment where a triangle crosses `level` (by value), or null.
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

const clipZ = (poly, lo, hi) => clipBy(poly, 'z', lo, hi);

// Clip a polygon of { x, y, z, v } to lo <= p[key] <= hi, interpolating
// every coordinate along cut edges.
function clipBy(poly, key, lo, hi) {
  const cut = (pts, keep, edge) => {
    const out = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k];
      const b = pts[(k + 1) % pts.length];
      const ka = keep(a[key]);
      const kb = keep(b[key]);
      if (ka) out.push(a);
      if (ka !== kb) {
        const t = (edge - a[key]) / (b[key] - a[key]);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, v: a.v + (b.v - a.v) * t });
      }
    }
    return out;
  };
  let out = poly;
  if (lo !== -Infinity) out = cut(out, (x) => x >= lo, lo);
  if (hi !== Infinity && out.length) out = cut(out, (x) => x <= hi, hi);
  return out;
}
