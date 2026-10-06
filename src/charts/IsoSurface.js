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
//
// Relief rendering (cartographic conventions, all on by default but shadows):
//   haze: 0.35                aerial perspective: lowlands lose contrast and
//                             fade toward the floor, peaks keep full detail
//   occlusion: 0.5            valleys and creases darken (less open sky)
//   contourStyle: 'illuminated'|'plain'  Tanaka contours: light on slopes facing
//                             the light, dark on those facing away; every fifth
//                             is an index line; contourLabels: true labels them
//   shadows: 0.45             cast shadows from the peaks (default off);
//                             shadowAngle: sun elevation in degrees (24)
//   colorScale: 'terrain'     a natural ramp: deep green lowlands to pale peaks

import { IsoHeatmap } from './IsoHeatmap.js';
import { niceTicksRange } from '../core/grid-chart.js';
import { drawBox } from '../core/shapes.js';
import { parseHex, rampAt, shade } from '../core/color.js';
import { claim } from '../core/stage.js';

// Light direction in camera space, as in camera.js.
const LIGHT_CAMERA = (() => {
  const v = [-0.45, 0.55, 0.75];
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
})();

// Named looks: preset: 'glossy' sets these options; anything passed
// alongside overrides them.
export const SURFACE_PRESETS = {
  relief: { colorScale: 'terrain', shadows: true, contourLabels: true },
  topo: { bands: true, contours: 10, colorScale: 'emerald' },
  glossy: { colorScale: 'turbo', contours: false, haze: 0, lighting: { specular: 0.6, shininess: 40 } },
  magma: { colorScale: 'magma', contours: 6, floor: false, skirt: false, lighting: { specular: 0.5, shininess: 30, rim: 0.35 } },
  pastel: {
    colorScale: 'aurora', mesh: 'triangles', contours: false, floor: false, skirt: false, haze: 0, occlusion: 0,
    lighting: { ambient: 0.72, diffuse: 0.4, specular: 0.15 },
  },
  voxel: { style: 'voxel', colorScale: 'ocean' },
  wireframe: { style: 'wireframe', contours: false },
  floating: { float: 2.4, bands: 7 },
};

export class IsoSurface extends IsoHeatmap {
  constructor(container, options = {}) {
    const preset = SURFACE_PRESETS[options.preset] ?? {};
    // Heights are read against the value axis; the floor is covered anyway.
    super(container, { grid: 'none', ...preset, ...options });
    this._presetKeys = Object.keys(preset).filter((k) => !(k in options));
    this.crosshair = { x: false, y: false };
  }

  // reconfigure({ preset: 'voxel' }) swaps the previous preset's options for
  // the new one's; other options passed alongside win.
  reconfigure(options = {}) {
    if ('preset' in options) {
      for (const k of this._presetKeys ?? []) delete this.options[k];
      const preset = SURFACE_PRESETS[options.preset] ?? {};
      this._presetKeys = Object.keys(preset).filter((k) => !(k in options));
      options = { ...preset, ...options };
    }
    super.reconfigure(options);
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

  // Surfaces keep negative values: pits fall below the zero level.
  get signed() {
    return true;
  }

  // Normalised position of a value in the domain, 0..1.
  norm(v) {
    return (v - this.minValue) / (this.maxValue - this.minValue);
  }

  // The lighting model. options.lighting overrides any of:
  //   ambient, diffuse          base and directional light (theme defaults)
  //   specular, shininess       glossy highlights (0.22, 28)
  //   rim, rimColor             light catching the silhouette (0)
  //   azimuth, elevation        light direction in degrees, relative to the
  //                             view: azimuth 0 is behind the scene, -90 from
  //                             the left, 90 from the right (default: upper
  //                             left, -140, 49)
  get lighting() {
    const o = this.options.lighting ?? {};
    const key = JSON.stringify(o) + this.theme.ambient + this.theme.diffuse;
    if (this._lightingKey === key) return this._lighting;
    let dir = LIGHT_CAMERA;
    if (o.azimuth != null || o.elevation != null) {
      const az = ((o.azimuth ?? -140) * Math.PI) / 180;
      const el = ((o.elevation ?? 49) * Math.PI) / 180;
      dir = [Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)];
    }
    // Half vector between the light and the viewer (camera space: the
    // viewer looks along -y, so "toward the viewer" is +y).
    const h = [dir[0], dir[1] + 1, dir[2]];
    const hl = Math.hypot(...h) || 1;
    this._lighting = {
      ambient: o.ambient ?? this.theme.ambient,
      diffuse: o.diffuse ?? this.theme.diffuse,
      specular: o.specular ?? 0.22,
      shininess: o.shininess ?? 28,
      rim: o.rim ?? 0,
      rimColor: parseHex(o.rimColor ?? '#ffffff'),
      dir,
      half: h.map((x) => x / hl),
    };
    this._lightingKey = key;
    return this._lighting;
  }

  // Diffuse brightness, specular and rim terms for a world-space normal.
  shadeNormal(n) {
    const L = this.lighting;
    const c = this.camera.toCamera(...n);
    const lambert = Math.max(0, c[0] * L.dir[0] + c[1] * L.dir[1] + c[2] * L.dir[2]);
    const nh = Math.max(0, c[0] * L.half[0] + c[1] * L.half[1] + c[2] * L.half[2]);
    return {
      k: L.ambient + L.diffuse * lambert,
      spec: L.specular ? L.specular * nh ** L.shininess : 0,
      rim: L.rim ? L.rim * (1 - Math.max(0, c[1])) ** 3 : 0,
    };
  }

  // Contour levels: options.contours as a count (default 8), an explicit
  // list of values, or false for none.
  get levels() {
    const c = this.options.contours ?? 8;
    if (c === false || c === 0) return [];
    if (Array.isArray(c)) return c;
    return niceTicksRange(this.minValue, this.maxValue, c).filter((v) => v > this.minValue && v < this.maxValue);
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
    const auto = n <= 400 ? 3 : n <= 2600 ? 2 : 1;
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
  buildMesh(k = this.smoothing) {
    const grid = this.heightGrid();
    const nx = this.xs.length;
    const ny = this.ys.length;
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
          // Bicubic Catmull-Rom over the 4 x 4 neighbourhood, clamped to
          // the domain (the spline can overshoot a little).
          const i0 = Math.floor(fi);
          const j0 = Math.floor(fj);
          const ti = fi - i0;
          const tj = fj - j0;
          const rows = [-1, 0, 1, 2].map((di) => catmull(V(i0 + di, j0 - 1), V(i0 + di, j0), V(i0 + di, j0 + 1), V(i0 + di, j0 + 2), tj));
          v = Math.max(this.minValue, Math.min(this.maxValue, catmull(rows[0], rows[1], rows[2], rows[3], ti)));
        }
        const ci = Math.round(fi);
        const cj = Math.round(fj);
        const cell = grid[ci]?.[cj] ?? null;
        // No data here (sparse grids): a hole in the surface.
        const hole = !cell || !cell.present;
        return { x: gx(fi), y: gy(fj), v, z: this.z(v) + lift, cell, hole };
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
    const mesh = {
      verts, mx, my, maxSlope, k,
      x0: verts[0][0].x, x1: verts[mx - 1][0].x, y0: verts[0][0].y, y1: verts[0][my - 1].y,
    };
    this.occlude(mesh, k);
    return mesh;
  }

  // Valley occlusion: a vertex lower than the terrain around it sees less
  // sky. Its depth below a box-blurred copy of the surface darkens it.
  occlude(mesh, k) {
    const strength = this.options.occlusion ?? 0.5;
    const { verts, mx, my } = mesh;
    if (!strength) {
      for (const row of verts) for (const p of row) p.ao = 1;
      return;
    }
    const r = Math.max(1, Math.round(k * 2.5));
    // Separable box blur of z.
    const tmp = Array.from({ length: mx }, () => new Float64Array(my));
    for (let a = 0; a < mx; a++) {
      for (let b = 0; b < my; b++) {
        let sum = 0;
        let n = 0;
        for (let d = -r; d <= r; d++) {
          const q = verts[Math.max(0, Math.min(mx - 1, a + d))][b];
          sum += q.z;
          n++;
        }
        tmp[a][b] = sum / n;
      }
    }
    const scale = Math.max(1e-6, this.maxHeight * 0.12);
    for (let a = 0; a < mx; a++) {
      for (let b = 0; b < my; b++) {
        let sum = 0;
        let n = 0;
        for (let d = -r; d <= r; d++) {
          sum += tmp[a][Math.max(0, Math.min(my - 1, b + d))];
          n++;
        }
        const p = verts[a][b];
        const depth = Math.max(0, sum / n - p.z) / scale;
        p.ao = 1 - strength * 0.55 * Math.min(1, depth);
      }
    }
  }

  // Cast shadows: march from each vertex toward the light over the height
  // field; terrain above the ray shades it, softly near the edge.
  castShadows(mesh) {
    const strength = this.options.shadows === true ? 0.45 : +this.options.shadows || 0;
    const { verts, mx, my } = mesh;
    for (const row of verts) for (const p of row) p.shadow = 0;
    if (!strength) return;
    // The light's direction, but a low sun (default 24 degrees) so peaks
    // throw shadows that read.
    const Lw = this.lightWorld();
    const h0 = Math.hypot(Lw[0], Lw[1]);
    if (h0 < 1e-3) return;
    const elev = ((this.options.shadowAngle ?? 24) * Math.PI) / 180;
    const L = [(Lw[0] / h0) * Math.cos(elev), (Lw[1] / h0) * Math.cos(elev), Math.sin(elev)];
    const horiz = Math.cos(elev);
    const x0 = verts[0][0].x;
    const y0 = verts[0][0].y;
    const dx = verts[1][0].x - x0 || 1;
    const dy = verts[0][1].y - y0 || 1;
    const heightAt = (x, y) => {
      const fa = (x - x0) / dx;
      const fb = (y - y0) / dy;
      if (fa < 0 || fb < 0 || fa > mx - 1 || fb > my - 1) return null;
      const a = Math.min(mx - 2, Math.floor(fa));
      const b = Math.min(my - 2, Math.floor(fb));
      const u = fa - a;
      const v = fb - b;
      return (
        verts[a][b].z * (1 - u) * (1 - v) + verts[a + 1][b].z * u * (1 - v) +
        verts[a][b + 1].z * (1 - u) * v + verts[a + 1][b + 1].z * u * v
      );
    };
    const step = Math.min(Math.abs(dx), Math.abs(dy));
    const ux = (L[0] / horiz) * step;
    const uy = (L[1] / horiz) * step;
    const uz = (L[2] / horiz) * step;
    const soft = this.maxHeight * 0.04;
    for (const row of verts) {
      for (const p of row) {
        let best = 0;
        let x = p.x;
        let y = p.y;
        let z = p.z + 0.02;
        for (let i = 0; i < 200; i++) {
          x += ux;
          y += uy;
          z += uz;
          const h = heightAt(x, y);
          if (h == null || z > this.maxHeight + this.floatHeight) break;
          if (h > z) best = Math.max(best, Math.min(1, (h - z) / soft));
          if (best >= 1) break;
        }
        p.shadow = best * strength;
      }
    }
  }

  // The camera-relative light (see camera.js) as a world-space direction.
  lightWorld() {
    const C = this.camera;
    const [r, t, up] = this.lighting.dir;
    const v = t * C._cp - up * C._sp;
    const nz = t * C._sp + up * C._cp;
    return [r * C._cy + v * C._sy, -r * C._sy + v * C._cy, nz];
  }

  // Ramp position in [0, 1] for a vertex (before banding).
  tone(p, mesh) {
    const by = this.options.colorBy;
    if (by === 'slope') return p.slope / mesh.maxSlope;
    if (by === 'x') return (p.x - mesh.x0) / (mesh.x1 - mesh.x0 || 1);
    if (by === 'y') return (p.y - mesh.y0) / (mesh.y1 - mesh.y0 || 1);
    return this.norm(p.v);
  }

  // [lo, hi, rgb] value ranges of the colour bands: between the contour
  // levels for bands: true, or n equal steps for bands: n.
  bandRanges() {
    const bands = this.options.bands;
    const edges =
      typeof bands === 'number'
        ? Array.from({ length: bands - 1 }, (_, i) => this.minValue + ((i + 1) / bands) * (this.maxValue - this.minValue))
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
    if (this.options.style === 'voxel') return this.drawVoxels();
    const mesh = this.buildMesh();
    this._mesh = mesh;
    const { camera: C, renderer: R, theme } = this;
    for (const row of mesh.verts) {
      for (const p of row) {
        const l = this.shadeNormal(p.n);
        p.k = l.k;
        p.spec = l.spec;
        p.rim = l.rim;
      }
    }
    this.castShadows(mesh);

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

    R.ctx.globalAlpha = this.options.opacity ?? 1;
    if (this.options.skirt !== false) this.drawSkirts(mesh);
    R.ctx.globalAlpha = 1;
    if (water && this.options.skirt !== false && this.floatHeight === 0) this.drawWaterSides(mesh, water);
    this.drawContourLabels();
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
    const flat = this.options.shading === 'flat';
    const clipped = lo !== -Infinity || hi !== Infinity;
    const haze = this.options.haze ?? 0.35;
    const hazeRgb = parseHex(theme.floor);
    const illuminated = (this.options.contourStyle ?? 'illuminated') === 'illuminated';
    const labelSpots = (this._labelSpots ??= []);
    const cut = this.options.cut;
    const cutLo = cut?.below ?? -Infinity;
    const cutHi = cut?.above ?? Infinity;
    const mesh2 = this.meshStyle(wire);
    ctx.globalAlpha = this.options.opacity ?? 1;

    for (const [a, b] of quads) {
      const c = [V[a][b], V[a + 1][b], V[a + 1][b + 1], V[a][b + 1]];
      const tris = [
        [c[0], c[1], c[2]],
        [c[0], c[2], c[3]],
      ];
      const depth = (t) => C.groundDepth(t[0].x + t[1].x + t[2].x, t[0].y + t[1].y + t[2].y);
      if (depth(tris[0]) > depth(tris[1])) tris.reverse();
      for (const tri of tris) {
        if (tri[0].hole || tri[1].hole || tri[2].hole) continue;
        const n = flat ? normal(tri[0], tri[1], tri[2]) : null;
        // Slopes facing away are always hidden by nearer terrain.
        if (n && !C.faces(...n)) continue;
        if (!n && !C.faces(...normal(tri[0], tri[1], tri[2]))) continue;
        let poly = clipped ? clipZ(tri, lo, hi) : tri;
        // Cut-aways: crisp holes where the value is outside [below, above].
        if (cut && poly.length >= 3) poly = clipBy(poly, 'v', cutLo, cutHi);
        if (poly.length < 3) continue;
        const lit = n ? this.shadeNormal(n) : null;
        let k = lit ? lit.k : (tri[0].k + tri[1].k + tri[2].k) / 3;
        const spec = lit ? lit.spec : (tri[0].spec + tri[1].spec + tri[2].spec) / 3;
        const rimL = lit ? lit.rim : (tri[0].rim + tri[1].rim + tri[2].rim) / 3;
        // Banded colours carry the reading; soften the lighting so they show.
        if (this.options.bands) k = 0.45 + 0.55 * k;
        // Occlusion and cast shadow darken; haze flattens the lowlands.
        k *= (tri[0].ao + tri[1].ao + tri[2].ao) / 3;
        k *= 1 - (tri[0].shadow + tri[1].shadow + tri[2].shadow) / 3;
        const height = this.norm((tri[0].v + tri[1].v + tri[2].v) / 3);
        const t = (this.tone(tri[0], mesh) + this.tone(tri[1], mesh) + this.tone(tri[2], mesh)) / 3;
        const rgb = this.rampColor(t);
        if (this.options.bands && !wire && this.options.colorBy !== 'slope') {
          // Crisp topographic steps: cut the triangle at the band edges.
          for (const [b0, b1, color] of this.bandRanges()) {
            const piece = clipBy(poly, 'v', b0, b1);
            if (piece.length < 3) continue;
            const f = this.relief(color, k, height, haze, hazeRgb, spec, rimL);
            R.polygon(piece.map(P), f, f, 0.6);
          }
        } else {
          const fill = wire ? theme.surface : this.relief(rgb, k, height, haze, hazeRgb, spec, rimL);
          R.polygon(poly.map(P), fill, fill, 0.6);
        }

        if (levels.length) {
          // Illuminated (Tanaka) contours: lines on slopes facing the light
          // are light, on slopes facing away dark, and widest where the
          // slope faces the light (or away from it) squarely.
          // Facing from the averaged vertex normals: per-facet normals
          // alternate across the mesh diagonal and would stipple the line.
          const avgN = [0, 1, 2].map((d) => tri[0].n[d] + tri[1].n[d] + tri[2].n[d]);
          const facing = illuminated ? this.facing(avgN.map((x) => x / (Math.hypot(...avgN) || 1))) : 0;
          const groups = [[], []]; // ordinary, index
          for (const level of levels) {
            const z = this.z(level) + lift;
            if (z < lo || z >= hi) continue;
            const seg = isoSegment(tri, level);
            if (!seg) continue;
            groups[this.isIndex(level) ? 1 : 0].push([C.project(seg[0].x, seg[0].y, z), C.project(seg[1].x, seg[1].y, z), level]);
          }
          ctx.lineCap = 'butt';
          groups.forEach((segs, isIndex) => {
            if (!segs.length) return;
            ctx.beginPath();
            for (const [s0, s1] of segs) {
              ctx.moveTo(s0.x, s0.y);
              ctx.lineTo(s1.x, s1.y);
            }
            const weight = isIndex ? 1.8 : 1;
            if (wire) {
              ctx.strokeStyle = shade(rgb, 1.25, 0.5);
              ctx.lineWidth = contourWidth;
            } else if (illuminated && !this.options.contourColor) {
              // Opaque, mixed from the facet's own colour: translucent
              // strokes would double up where segments meet.
              const base = parseRgb(this.relief(rgb, k, height, haze, hazeRgb));
              const a = 0.28 + 0.5 * Math.abs(facing);
              const toward = facing >= 0 ? [255, 255, 255] : [8, 5, 24];
              ctx.strokeStyle = `rgb(${base.map((c, i) => Math.round(c + (toward[i] - c) * Math.min(0.85, a))).join(',')})`;
              ctx.lineWidth = contourWidth * weight * (0.6 + 0.9 * Math.abs(facing));
              ctx.lineCap = 'round';
            } else {
              ctx.strokeStyle = contourColor;
              ctx.lineWidth = contourWidth * weight;
            }
            ctx.stroke();
            if (isIndex && this.options.contourLabels && !wire) for (const seg of segs) labelSpots.push({ seg, height, depth: depth(tri) });
          });
        }
      }
      if (mesh2 && !c.some((p) => p.hole)) this.drawMeshLines(c, a, b, mesh, mesh2, lo, hi, cut ? [cutLo, cutHi] : null);
      // Hit regions: each quarter of the quad picks its nearest data point.
      if (lo === -Infinity || hi === Infinity) {
        if (clipped && hi !== Infinity) continue; // register hits once, in the upper pass
        const mid = { x: (c[0].x + c[2].x) / 2, y: (c[0].y + c[2].y) / 2, z: (c[0].z + c[1].z + c[2].z + c[3].z) / 4 };
        c.forEach((p, q) => {
          if (!p.cell || p.hole) return;
          const prev = c[(q + 3) % 4];
          const next = c[(q + 1) % 4];
          const half = (u) => ({ x: (p.x + u.x) / 2, y: (p.y + u.y) / 2, z: (p.z + u.z) / 2 });
          R.hit([[p, half(next), mid, half(prev)].map(P)], p.cell);
        });
      }
    }
  }

  // style: 'voxel': the terrain as columns of blocks, heights stepped into
  // terraces. voxel: { step (value per terrace; default a sixteenth of the
  // range), resolution (columns per data cell, 1), gap (0..0.5, 0) }.
  drawVoxels() {
    const { camera: C, renderer: R, theme } = this;
    const o = this.options.voxel ?? {};
    const res = Math.max(1, Math.min(4, Math.round(o.resolution ?? 1)));
    const mesh = this.buildMesh(res);
    this._mesh = mesh;
    const range = this.maxValue - this.minValue;
    const step = o.step ?? range / 16;
    const gap = Math.max(0, Math.min(0.5, o.gap ?? 0));
    const hx = (this.spacing[0] / res / 2) * (1 - gap);
    const hy = (this.spacing[1] / res / 2) * (1 - gap);
    const haze = this.options.haze ?? 0.35;
    const hazeRgb = parseHex(theme.floor);
    const cols = [];
    for (const row of mesh.verts) for (const p of row) if (!p.hole) cols.push(p);
    cols.sort((a, b) => C.groundDepth(a.x, a.y) - C.groundDepth(b.x, b.y));
    const hovered = this.cellOf(this.hovered);
    for (const p of cols) {
      // Terraces count up from the bottom of the domain.
      const q = step > 0 ? this.minValue + Math.max(1, Math.round((p.v - this.minValue) / step)) * step : p.v;
      const t = this.norm(Math.min(this.maxValue, q));
      const rgb = parseRgb(this.relief(this.rampColor(t), 1, t, haze, hazeRgb));
      const top = Math.max(0.04, this.z(Math.min(this.maxValue, q)));
      const glow = hovered && p.cell === hovered ? 1 + 0.2 * this.focus.value : 1;
      const hits = drawBox(C, R, theme, { x0: p.x - hx, x1: p.x + hx, y0: p.y - hy, y1: p.y + hy, z0: 0, z1: top }, rgb, { glow });
      if (p.cell) R.hit(hits, p.cell);
    }
    this.drawPeaks();
    if (hovered && this.focus.value > 0) this.drawProbe(hovered);
  }

  // Mesh overlay settings, or null for none:
  //   mesh: true | 'quads' | 'triangles' | 'x' | 'y'
  //   meshStep (mesh rows per line; default one per data cell), meshColor,
  //   meshOpacity, meshWidth
  meshStyle(wire) {
    const m = this.options.mesh ?? (wire ? 'quads' : false);
    if (!m) return null;
    const pattern = m === true ? 'quads' : m;
    const dark = this.theme.mode === 'dark';
    const opacity = this.options.meshOpacity ?? (wire ? 1 : 0.4);
    return {
      pattern,
      step: Math.max(1, Math.round(this.options.meshStep ?? (pattern === 'triangles' ? 1 : this.smoothing))),
      color: this.options.meshColor ?? (dark || pattern === 'triangles' ? '#ffffff' : '#2b2156'),
      opacity,
      width: this.options.meshWidth ?? (wire ? 1 : 0.6),
      wire,
    };
  }

  // Mesh lines of one quad (its near edges), clipped to the pass's height
  // band and any cut-away, drawn right after the quad so nearer terrain
  // hides them.
  drawMeshLines(c, a, b, mesh, st, lo, hi, cut) {
    const { camera: C, renderer: R } = this;
    const ctx = R.ctx;
    const segs = [];
    const { pattern, step } = st;
    const xLines = pattern !== 'y';
    const yLines = pattern !== 'x';
    if (xLines && b % step === 0) segs.push([c[0], c[1]]);
    if (xLines && b + 1 === mesh.my - 1 && (b + 1) % step === 0) segs.push([c[3], c[2]]);
    if (yLines && a % step === 0) segs.push([c[0], c[3]]);
    if (yLines && a + 1 === mesh.mx - 1 && (a + 1) % step === 0) segs.push([c[1], c[2]]);
    if (pattern === 'triangles') segs.push([c[0], c[2]]);
    if (!segs.length) return;
    const alpha = ctx.globalAlpha;
    ctx.beginPath();
    for (let [p, q] of segs) {
      let seg = clipSegment(p, q, 'z', lo, hi);
      if (seg && cut) seg = clipSegment(seg[0], seg[1], 'v', cut[0], cut[1]);
      if (!seg) continue;
      const s0 = C.project(seg[0].x, seg[0].y, seg[0].z);
      const s1 = C.project(seg[1].x, seg[1].y, seg[1].z);
      ctx.moveTo(s0.x, s0.y);
      ctx.lineTo(s1.x, s1.y);
    }
    if (st.wire) {
      const t = (this.tone(c[0], mesh) + this.tone(c[2], mesh)) / 2;
      ctx.strokeStyle = this.options.meshColor ?? shade(this.rampColor(t), 1.3);
    } else ctx.strokeStyle = st.color;
    ctx.globalAlpha = alpha * st.opacity;
    ctx.lineWidth = st.width;
    ctx.stroke();
    ctx.globalAlpha = alpha;
  }

  // Final colour of a facet: lit ramp colour, then aerial perspective. Low
  // ground loses lighting contrast and drifts toward the floor colour, so
  // peaks stand forward with full detail (Imhof).
  relief(rgb, k, height, haze, hazeRgb, spec = 0, rim = 0) {
    const h = haze * (1 - Math.max(0, Math.min(1, height)));
    const kk = 1 + (k - 1) * (1 - 0.6 * h);
    let out = kk <= 1 ? rgb.map((c) => c * kk) : rgb.map((c) => c + (255 - c) * Math.min(1, kk - 1));
    const m = 0.45 * h;
    out = out.map((c, i) => c + (hazeRgb[i] - c) * m);
    // Highlights wash toward white; rim light toward its colour.
    if (spec > 0) out = out.map((c) => c + (255 - c) * Math.min(1, spec));
    if (rim > 0) {
      const rc = this.lighting.rimColor;
      out = out.map((c, i) => c + (rc[i] - c) * Math.min(1, rim));
    }
    return `rgb(${out.map((c) => Math.round(Math.max(0, Math.min(255, c)))).join(',')})`;
  }

  // How squarely a slope faces the light, -1 (away) to 1 (toward), from the
  // horizontal part of its normal, weighted by steepness.
  facing(n) {
    const c = this.camera.toCamera(...n);
    const [lr, lt] = this.lighting.dir;
    const lh = Math.hypot(lr, lt) || 1;
    const ch = Math.hypot(c[0], c[1]);
    if (ch < 1e-6) return 0;
    const cos = (c[0] * lr + c[1] * lt) / (lh * ch);
    return cos * Math.min(1, ch * 2.5);
  }

  // Index contours, drawn heavier: every fifth step, or every second when
  // there are only a few levels.
  isIndex(level) {
    const lv = this.levels;
    if (this.minValue < 0 && Math.abs(level) < 1e-9) return true;
    if (lv.length < 2) return false;
    const step = lv[1] - lv[0];
    const every = lv.length >= 8 ? 5 : 2;
    return Math.abs(Math.round(level / step) % every) === 0;
  }

  // options.contourLabels: index contour values on the nearest, flattest
  // stretches, a few per level.
  drawContourLabels() {
    const spots = this._labelSpots ?? [];
    this._labelSpots = [];
    if (!spots.length) return;
    const { renderer: R, theme } = this;
    const placed = [];
    const perLevel = new Map();
    spots.sort((a, b) => b.depth - a.depth);
    for (const { seg } of spots) {
      const [s0, s1, level] = seg;
      const count = perLevel.get(level) ?? 0;
      if (count >= 2) continue;
      const angle = Math.atan2(s1.y - s0.y, s1.x - s0.x);
      if (Math.abs(Math.sin(angle)) > 0.45) continue; // only gently sloping runs
      const x = (s0.x + s1.x) / 2;
      const y = (s0.y + s1.y) / 2;
      const text = this.format(level);
      const w = R.measure(text, 10, 600, true) / 2 + 3;
      if (!claim(placed, { l: x - w - 40, r: x + w + 40, t: y - 8, b: y + 8 })) continue;
      perLevel.set(level, count + 1);
      R.text(text, x, y, { color: theme.markText ?? theme.text, size: 10, weight: 600, mono: true, halo: theme.markHalo ?? theme.surface });
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
    // Specular glint: a soft sheen on the water toward the light, clipped
    // to the water's surface.
    if (water.glint !== false) {
      const ctx = R.ctx;
      const L = this.lightWorld();
      const gx = a.x + (b.x - a.x) * (0.5 + 0.28 * Math.sign(L[0] || 1) * Math.min(1, Math.abs(L[0]) * 2));
      const gy = a.y + (b.y - a.y) * (0.5 + 0.28 * Math.sign(L[1] || 1) * Math.min(1, Math.abs(L[1]) * 2));
      const c = C.project(gx, gy, zw);
      const span = Math.hypot(pts[0].x - pts[2].x, pts[0].y - pts[2].y);
      ctx.save();
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.clip();
      ctx.translate(c.x, c.y);
      ctx.scale(1, 0.45);
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, span * 0.32);
      grad.addColorStop(0, 'rgba(255,255,255,0.5)');
      grad.addColorStop(0.35, 'rgba(255,255,255,0.18)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(-span, -span, span * 2, span * 2);
      ctx.restore();
    }
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
      const k0 = this.shadeNormal(n).k * 0.8;
      const strata = this.options.skirtStyle !== 'flat' && !wire && this.floatHeight === 0;
      const ctx = R.ctx;
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k];
        const b = pts[k + 1];
        if (a.hole || b.hole) continue;
        const rgb = this.rampColor((this.tone(a, this._mesh) + this.tone(b, this._mesh)) / 2);
        let fill = wire ? theme.surface : shade(rgb, k0);
        if (strata) {
          // The wall shows the ramp from the base up to the edge: a cross-
          // section through the colour bands, like rock strata.
          const top = P(a.x, a.y, Math.max(a.z, b.z));
          const bottom = P(a.x, a.y, 0);
          if (Math.abs(bottom.y - top.y) > 2) {
            const g = ctx.createLinearGradient(0, bottom.y, 0, top.y);
            const t = Math.max(this.tone(a, this._mesh), this.tone(b, this._mesh));
            g.addColorStop(0, shade(this.rampColor(0), k0 * 0.85));
            g.addColorStop(1, shade(this.rampColor(t), k0));
            fill = g;
          }
        }
        // A floating surface gets a thin rim instead of walls to the floor.
        const rim = this.floatHeight > 0 ? 0.22 : null;
        const za = rim ? a.z - rim : 0;
        const zb = rim ? b.z - rim : 0;
        const poly = [P(a.x, a.y, za), P(b.x, b.y, zb), P(b.x, b.y, b.z), P(a.x, a.y, a.z)];
        // Stroke in the fill (gradient included) so neighbouring strips meet
        // without hairline seams.
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
        if (top && c.total > this.minValue) peaks.push(c);
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

const parseRgb = (str) => str.match(/\d+/g).slice(0, 3).map(Number);

// Clip a segment of { x, y, z, v } to lo <= p[key] <= hi; null if nothing is left.
function clipSegment(p, q, key, lo, hi) {
  if (lo === -Infinity && hi === Infinity) return [p, q];
  const a = p[key];
  const d = q[key] - a;
  let t0 = 0;
  let t1 = 1;
  if (Math.abs(d) < 1e-12) {
    if (a < lo || a > hi) return null;
  } else {
    // a + d t >= lo and a + d t <= hi.
    const tl = (lo - a) / d;
    const th = (hi - a) / d;
    if (d > 0) {
      t0 = Math.max(t0, tl);
      t1 = Math.min(t1, th);
    } else {
      t0 = Math.max(t0, th);
      t1 = Math.min(t1, tl);
    }
  }
  if (t0 >= t1) return null;
  const at = (t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: p.z + (q.z - p.z) * t, v: p.v + (q.v - p.v) * t });
  return [at(t0), at(t1)];
}
