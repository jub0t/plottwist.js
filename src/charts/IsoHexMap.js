// A world (or regional) map tiled with rounded hexagons. Land is a low base
// layer; every data point is binned into the hex containing its coordinates,
// and data hexes rise as rounded prisms coloured on a sequential scale.
//
// Coordinates are exact: records are projected with the chosen projection
// (Equal Earth by default) and binned on a hex grid in that projected plane.
// The chart exposes the same mapping as an API: project(), hexAt(), invert().

import { GeoChart, accessor } from '../core/geo-chart.js';
import { shade } from '../core/color.js';
import { faceBrightness } from '../core/shapes.js';
import { forEachCell } from '../geo/index.js';

const SIZE = 0.5; // hex circumradius in world units
const SQRT3 = Math.sqrt(3);
const LIFT = 0.15;

export class IsoHexMap extends GeoChart {
  constructor(container, options = {}) {
    super(container, options);
    const o = this.options;
    this.lon = accessor(o.lon ?? 'lon');
    this.lat = accessor(o.lat ?? 'lat');
    // Shape controls.
    this.rounding = o.rounding ?? 0.35; // 0 = sharp corners, 1 = nearly circular
    this.gap = o.gap ?? 0.14; // space between hexes, fraction of hex size
    this._polys = new Map();
    this.layoutKeys = ['columns', 'bounds', 'landThreshold'];
    this.init();
  }

  // Data hexes, keyed by hex id.
  get hexes() {
    return this.items;
  }

  configure(options) {
    if ('rounding' in options) this.rounding = options.rounding;
    if ('gap' in options) this.gap = options.gap;
  }

  // ---- geography ------------------------------------------------------------

  // Bounds as [west, south, east, north]. Antarctica is left out by default.
  get bounds() {
    return this.options.bounds ?? [-180, -58, 180, 84];
  }

  // Fit the projection to the bounds, lay out the hex grid and mark land hexes.
  layout() {
    const [west, south, east, north] = this.bounds;
    const samples = [];
    const steps = 48;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        samples.push([west + ((east - west) * i) / steps, south + ((north - south) * j) / steps]);
      }
    }
    this.fitProjection(samples, (this.options.columns ?? 96) * SQRT3 * SIZE);

    // Sample the land mask; a hex is land when enough of it is covered.
    const counts = new Map();
    forEachCell(this.bounds, (lon, lat, land) => {
      const id = this._hexId(...this.toWorld(lon, lat));
      const c = counts.get(id) ?? counts.set(id, [0, 0]).get(id);
      c[0]++;
      if (land) c[1]++;
    });
    const threshold = this.options.landThreshold ?? 0.3;
    this.land = [];
    for (const [id, [total, land]] of counts) {
      if (land / total >= threshold) this.land.push(this._hex(id));
    }
    this.landById = new Map(this.land.map((h) => [h.id, h]));
    this.land.forEach((h) => (h.sweep = this.sweepOf(h.x, h.y)));
  }

  binKey(d) {
    const lon = +this.lon(d);
    const lat = +this.lat(d);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return this._hexId(...this.toWorld(lon, lat));
  }

  createItem(id) {
    return this._hex(id);
  }

  // The hex containing a coordinate: { id, q, r, lon, lat, value, ... }.
  hexAt(lon, lat) {
    const id = this._hexId(...this.toWorld(lon, lat));
    return this.items.get(id) ?? this._hex(id);
  }

  itemAt(lon, lat) {
    return this.hexAt(lon, lat);
  }

  topOf(hex) {
    const t = Math.min(1, (hex.value ?? 0) / this.maxValue);
    return (this.extrude ? t * this.maxHeight : 0.03) + (hex.lift?.value ?? 0) * LIFT;
  }

  // Pointy-top axial coordinates, cube-rounded.
  _hexId(x, y) {
    const qf = ((SQRT3 / 3) * x - y / 3) / SIZE;
    const rf = ((2 / 3) * y) / SIZE;
    const sf = -qf - rf;
    let q = Math.round(qf);
    let r = Math.round(rf);
    const s = Math.round(sf);
    const dq = Math.abs(q - qf);
    const dr = Math.abs(r - rf);
    const ds = Math.abs(s - sf);
    if (dq > dr && dq > ds) q = -r - s;
    else if (dr > ds) r = -q - s;
    return `${q},${r}`;
  }

  _hex(id) {
    const [q, r] = id.split(',').map(Number);
    const x = SIZE * SQRT3 * (q + r / 2);
    const y = SIZE * 1.5 * r;
    const [lon, lat] = this.toLonLat(x, y);
    return { id, q, r, x, y, lon, lat };
  }

  // Unit outline of a rounded, gapped hexagon: points + outward normals.
  // `segments` arc points per corner; cached per level of detail.
  _poly(segments) {
    const key = `${segments}|${this.rounding}|${this.gap}`;
    let poly = this._polys.get(key);
    if (poly) return poly;
    const s = SIZE * (1 - this.gap);
    const rr = Math.min(1, Math.max(0, this.rounding)) * s * 0.5;
    const d = rr / Math.sin(Math.PI / 3); // corner -> arc centre distance
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + (i * Math.PI) / 3;
      if (segments === 0 || rr === 0) {
        pts.push([s * Math.cos(a), s * Math.sin(a)]);
        continue;
      }
      const cx = (s - d) * Math.cos(a);
      const cy = (s - d) * Math.sin(a);
      for (let k = 0; k <= segments; k++) {
        const t = a - Math.PI / 6 + (k / segments) * (Math.PI / 3);
        pts.push([cx + rr * Math.cos(t), cy + rr * Math.sin(t)]);
      }
    }
    const normals = pts.map((p, i) => {
      const n = pts[(i + 1) % pts.length];
      const mx = (p[0] + n[0]) / 2;
      const my = (p[1] + n[1]) / 2;
      const l = Math.hypot(mx, my);
      return [mx / l, my / l];
    });
    poly = { pts, normals };
    this._polys.set(key, poly);
    return poly;
  }

  // Ground-plane picking: any hex under the pointer, even without data.
  pickGround(px, py) {
    const w = this.camera.unproject(px, py);
    if (!w) return null;
    const id = this._hexId(...w);
    return this.items.get(id) ?? this.landById.get(id) ?? null;
  }

  // ---- drawing ----------------------------------------------------------------

  draw() {
    const { renderer: R, camera: C, theme } = this;
    const hw = this.mapWidth / 2 + SIZE;
    const hd = this.mapDepth / 2 + SIZE;
    const top = this.extrude ? this.maxHeight : 0.2;
    this.fitScene(
      [
        [-hw, -hd, 0], [hw, -hd, 0], [hw, hd, 0], [-hw, hd, 0],
        // Tall columns rarely sit on the far edge; reserve half their height there.
        [-hw, -hd, top * 0.5], [hw, -hd, top * 0.5], [0, 0, top],
      ],
      { top: 48, right: 16, bottom: 16, left: 16 },
    );

    // Level of detail: fewer corner points when hexes are small on screen.
    const px = SIZE * C.scale * C.zoom;
    const segments = px < 7 ? 0 : px < 16 ? 2 : 4;
    const poly = this._poly(segments);

    this._drawLand(poly);
    this._drawData(poly);
    this.drawMapLayers();
  }

  // Land: every base hex in one path and one fill (bucketed by the entrance
  // sweep while it plays), which keeps thousands of tiles cheap.
  _drawLand(poly) {
    const { renderer: R, camera: C, theme } = this;
    const ctx = R.ctx;
    const intro = this.intro.value;
    const landColor = this.options.landColor ?? theme.land ?? theme.grid;
    const hovered = this.hovered;
    const buckets = new Map();

    for (const h of this.land) {
      const data = this.items.get(h.id);
      if (data && data.value > 0 && !data.leaving) continue; // a prism stands here
      const p = Math.max(0, Math.min(1, (intro * 1.6 - h.sweep) / 0.6));
      if (p <= 0) continue;
      const level = p >= 1 ? 1 : Math.ceil(p * 4) / 4;
      (buckets.get(level) ?? buckets.set(level, []).get(level)).push(h);
    }

    for (const [level, hexes] of buckets) {
      ctx.globalAlpha = level;
      ctx.beginPath();
      const z = (1 - level) * 0.4; // tiles settle onto the map as they appear
      for (const h of hexes) this._tracePoly(poly, h.x, h.y, z);
      ctx.fillStyle = landColor;
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Hovered empty hex: outline it so the pointer has a target.
    if (hovered && !this.items.has(hovered.id)) {
      ctx.beginPath();
      this._tracePoly(poly, hovered.x, hovered.y, 0);
      ctx.strokeStyle = theme.textMuted;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  _tracePoly(poly, cx, cy, z) {
    const C = this.camera;
    const ctx = this.renderer.ctx;
    const pts = poly.pts;
    for (let i = 0; i < pts.length; i++) {
      const p = C.project(cx + pts[i][0], cy + pts[i][1], z);
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    }
    ctx.closePath();
  }

  _drawData(poly) {
    const { renderer: R, camera: C, theme } = this;
    const hovered = this.hovered;
    const list = [...this.items.values()]
      .filter((h) => h.value > 0)
      .sort((a, b) => C.groundDepth(a.x, a.y) - C.groundDepth(b.x, b.y));

    for (const h of list) {
      const t = Math.min(1, h.value / this.maxValue);
      const lift = h.lift.value;
      const z0 = lift * LIFT;
      const z1 = z0 + (this.extrude ? Math.max(0.03, t * this.maxHeight) : 0.03);
      const rgb = this.colorFor(h.value);
      const glow = 1 + 0.15 * lift;
      R.ctx.globalAlpha = hovered && h !== hovered ? 1 - 0.4 * this.focus.value : 1;

      // Hot hexes bloom; the glow itself encodes intensity.
      const bloom = theme.glow * (t > 0.4 ? t * t : 0) + theme.glow * 0.6 * lift;
      if (bloom > 0) {
        const c = C.project(h.x, h.y, z1);
        const w = SIZE * 2 * C.scale * C.zoom * (2 + bloom);
        R.glow(rgb, c.x, c.y, w, w * 0.8, 0.5 * bloom);
      }
      R.hit(this._drawPrism(poly, h.x, h.y, z0, z1, rgb, glow), h);
    }
  }

  // Rounded hexagonal prism. The visible side is drawn as one silhouette
  // polygon with a horizontal gradient across the facing normals, which reads
  // as smooth shading on the rounded corners and costs one fill.
  _drawPrism(poly, cx, cy, z0, z1, rgb, glow) {
    const { renderer: R, camera: C, theme } = this;
    const ctx = R.ctx;
    const { pts, normals } = poly;
    const n = pts.length;
    const hits = [];
    const P = (i, z) => C.project(cx + pts[i % n][0], cy + pts[i % n][1], z);

    // Visible side edges form one contiguous run on a convex outline.
    const visible = normals.map((nm) => C.faces(nm[0], nm[1], 0));
    let start = visible.findIndex((v, i) => v && !visible[(i - 1 + n) % n]);
    if (start >= 0 && z1 - z0 > 0.001) {
      let end = start;
      while (visible[(end + 1) % n] && end - start < n) end++;
      const topChain = [];
      const bottomChain = [];
      for (let i = start; i <= end + 1; i++) {
        topChain.push(P(i, z1));
        bottomChain.push(P(i, z0));
      }
      const side = [...topChain, ...bottomChain.reverse()];
      const left = topChain[0];
      const right = topChain[topChain.length - 1];
      const shadeAt = (i) => shade(rgb, faceBrightness(C, theme, [...normals[i % n], 0], glow));
      const grad = ctx.createLinearGradient(left.x, 0, right.x, 0);
      grad.addColorStop(0, shadeAt(start));
      grad.addColorStop(0.5, shadeAt(Math.round((start + end) / 2)));
      grad.addColorStop(1, shadeAt(end));
      R.polygon(side, grad, grad, 0.75);
      hits.push(side);
    }

    const top = pts.map((_, i) => P(i, z1));
    const fill = shade(rgb, faceBrightness(C, theme, [0, 0, 1], glow) * (1 + 0.1 * theme.gradient));
    R.polygon(top, fill, fill, 0.75);
    if (theme.edge > 0 && SIZE * C.scale * C.zoom > 10) {
      R.polygon(top, null, shade(rgb, 1.45, theme.edge), 1);
    }
    hits.push(top);
    return hits;
  }
}
