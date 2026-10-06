// A world (or regional) map tiled with rounded hexagons. Land is a low base
// layer; every data point is binned into the hex containing its coordinates,
// and data hexes rise as rounded prisms coloured on a sequential scale.
//
// Coordinates are exact: records are projected with the chosen projection
// (Equal Earth by default) and binned on a hex grid in that projected plane.
// The chart exposes the same mapping as an API: project(), hexAt(), invert().

import { Chart } from '../core/chart.js';
import { Renderer } from '../core/renderer.js';
import { Tween, ease } from '../core/animation.js';
import { parseHex, rampAt, rgbString, sequentialStops, shade } from '../core/color.js';
import { faceBrightness } from '../core/shapes.js';
import { forEachCell, resolveProjection } from '../geo/index.js';

const SIZE = 0.5; // hex circumradius in world units
const SQRT3 = Math.sqrt(3);
const LIFT = 0.15;

const accessor = (a) => (typeof a === 'function' ? a : (d) => d[a]);

const AGGREGATES = {
  sum: (b) => b.sum,
  mean: (b) => b.sum / b.count,
  max: (b) => b.max,
  count: (b) => b.count,
};

export class IsoHexMap extends Chart {
  constructor(container, options = {}) {
    super(container, { camera: { yaw: 0, pitch: 0.72 }, ...options });
    const o = this.options;
    this.lon = accessor(o.lon ?? 'lon');
    this.lat = accessor(o.lat ?? 'lat');
    this.value = accessor(o.value ?? 'value');
    this.aggregate = typeof o.aggregate === 'function' ? o.aggregate : AGGREGATES[o.aggregate ?? 'sum'];
    this.format =
      o.format ?? ((v) => v.toLocaleString(undefined, { maximumFractionDigits: 1 }));
    this.projection = resolveProjection(o.projection);
    // Shape controls.
    this.rounding = o.rounding ?? 0.35; // 0 = sharp corners, 1 = nearly circular
    this.gap = o.gap ?? 0.14; // space between hexes, fraction of hex size
    this.extrude = o.extrude ?? true;
    this.focus = new Tween(0);
    this.intro = new Tween(0);
    this.hexes = new Map();
    this._polys = new Map();
    // Arcs live on their own layer so their flowing pulses don't force the
    // whole map to redraw every frame.
    this.overlay = new Renderer(this.container, { overlay: true });
    this.container.insertBefore(this.overlay.canvas, this.tooltip);

    this._buildGrid();
    if (o.frames) this.setFrames(o.frames);
    else this.setData(o.data ?? []);
    if (o.autoplay && this.frames.length > 1) this.play();
  }

  // ---- geography ------------------------------------------------------------

  // Bounds as [west, south, east, north]. Antarctica is left out by default.
  get bounds() {
    return this.options.bounds ?? [-180, -58, 180, 84];
  }

  // Lay out the hex grid over the projected bounds and mark land hexes.
  _buildGrid() {
    const [west, south, east, north] = this.bounds;
    const P = this.projection;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const steps = 48;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        const [x, y] = P.forward(west + ((east - west) * i) / steps, south + ((north - south) * j) / steps);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    const columns = this.options.columns ?? 96;
    this._k = (columns * SQRT3 * SIZE) / (maxX - minX);
    this._mid = [(minX + maxX) / 2, (minY + maxY) / 2];
    this.mapWidth = (maxX - minX) * this._k;
    this.mapDepth = (maxY - minY) * this._k;

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
      if (land / total < threshold) continue;
      this.land.push(this._hex(id));
    }
    this.landById = new Map(this.land.map((h) => [h.id, h]));
    // West -> east, for the entrance sweep.
    this.land.forEach((h) => (h.sweep = (h.x / this.mapWidth + 0.5) * 0.7 + (h.y / this.mapDepth + 0.5) * 0.3));
  }

  // World [x, y] for a coordinate. North is away from the default camera.
  toWorld(lon, lat) {
    const [x, y] = this.projection.forward(lon, lat);
    return [(x - this._mid[0]) * this._k, -(y - this._mid[1]) * this._k];
  }

  // Coordinate for a world [x, y].
  toLonLat(x, y) {
    return this.projection.invert(x / this._k + this._mid[0], -y / this._k + this._mid[1]);
  }

  // Screen position of a coordinate (optionally at a height above the map).
  project(lon, lat, z = 0) {
    const [x, y] = this.toWorld(lon, lat);
    return this.camera.project(x, y, z);
  }

  // Coordinate under a screen point, or null if it misses the map plane.
  invert(px, py) {
    const w = this.camera.unproject(px, py);
    return w && this.toLonLat(...w);
  }

  // The hex containing a coordinate: { id, q, r, lon, lat, value, ... }.
  hexAt(lon, lat) {
    const id = this._hexId(...this.toWorld(lon, lat));
    return this.hexes.get(id) ?? this._hex(id);
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

  // Change grid/projection options at runtime (columns, projection, bounds,
  // landThreshold, rounding, gap) and rebuild. Data is re-binned in place.
  reconfigure(options) {
    Object.assign(this.options, options);
    if ('projection' in options) this.projection = resolveProjection(options.projection);
    if ('rounding' in options) this.rounding = options.rounding;
    if ('gap' in options) this.gap = options.gap;
    if ('extrude' in options) this.extrude = options.extrude;
    const regrid = ['columns', 'projection', 'bounds', 'landThreshold'].some((k) => k in options);
    if (regrid) {
      this._buildGrid();
      this.hexes.clear();
      this._fit = null;
      const frames = this._rawFrames;
      this.frames = undefined; // replay the entrance on the new grid
      this.intro.set(0);
      this.setFrames(frames);
    }
    this.invalidate();
  }

  // ---- data -----------------------------------------------------------------

  setData(data) {
    this.setFrames([{ label: null, data }]);
  }

  // frames: [{ label, data: [{ lon, lat, value, ... }] }]
  setFrames(frames) {
    const first = this.frames === undefined;
    this._rawFrames = frames;
    this.frames = frames.map((f) => {
      const bins = new Map();
      for (const d of f.data) {
        const lon = +this.lon(d);
        const lat = +this.lat(d);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const id = this._hexId(...this.toWorld(lon, lat));
        const v = +this.value(d) || 0;
        const b = bins.get(id) ?? bins.set(id, { sum: 0, count: 0, max: -Infinity, records: [] }).get(id);
        b.sum += v;
        b.count++;
        b.max = Math.max(b.max, v);
        b.records.push(d);
      }
      const values = new Map();
      for (const [id, b] of bins) values.set(id, this.aggregate(b));
      return { label: f.label, values, bins };
    });

    let max = 0;
    for (const f of this.frames) for (const v of f.values.values()) max = Math.max(max, v);
    this.maxValue = this.options.max ?? (max || 1);
    this.maxHeight = this.options.height ?? this.mapWidth * 0.12;

    const now = performance.now();
    const ids = new Set(this.frames.flatMap((f) => [...f.values.keys()]));
    for (const [id, hex] of this.hexes) if (!ids.has(id)) hex.leaving = true;
    for (const id of ids) {
      let hex = this.hexes.get(id);
      if (!hex) {
        hex = Object.assign(this._hex(id), { value: 0, blend: new Tween(1), lift: new Tween(0) });
        hex.sweep = (hex.x / this.mapWidth + 0.5) * 0.7 + (hex.y / this.mapDepth + 0.5) * 0.3;
        this.hexes.set(id, hex);
      }
      hex.leaving = false;
    }
    for (const hex of this.hexes.values()) {
      hex.from = hex.value;
      hex.blend.set(0);
      hex.blend.to(1, now, {
        duration: first ? 900 : 650,
        delay: first ? 500 + hex.sweep * 900 : hex.sweep * 300,
        easing: first ? ease.backOut : ease.cubicOut,
      });
    }
    if (first) this.intro.to(1, now, { duration: 1600, easing: ease.cubicOut });

    this.timeline.length = this.frames.length;
    this.timeline.seek(Math.min(this.timeline.position, this.frames.length - 1));
    this.invalidate();
  }

  valueAt(hex, position) {
    const i = Math.floor(position);
    const t = position - i;
    const a = this.frames[i]?.values.get(hex.id) ?? 0;
    if (t === 0 || i + 1 >= this.frames.length) return a;
    const b = this.frames[i + 1].values.get(hex.id) ?? 0;
    return a + (b - a) * ease.cubicInOut(t);
  }

  get frameLabel() {
    return this.frames[Math.round(this.timeline.position)]?.label ?? null;
  }

  // Bin (records, count, sum) for a hex in the frame on screen.
  binOf(hex) {
    return this.frames[Math.round(this.timeline.position)]?.bins.get(hex.id) ?? null;
  }

  // ---- animation --------------------------------------------------------------

  tick(now) {
    let active = this.intro.tick(now);
    const position = this.timeline.position;
    for (const hex of this.hexes.values()) {
      active = hex.blend.tick(now) || active;
      active = hex.lift.tick(now) || active;
      const target = hex.leaving ? 0 : this.valueAt(hex, position);
      hex.value = hex.from + (target - hex.from) * hex.blend.value;
      if (hex.leaving && hex.blend.value === 1) this.hexes.delete(hex.id);
    }
    return this.focus.tick(now) || active;
  }

  // Redraw the arc layer; keep animating while pulses flow.
  drawOverlay() {
    const O = this.overlay;
    O.ctx.clearRect(0, 0, O.width, O.height);
    if (!this.options.arcs?.length) return false;
    this._drawArcs(O);
    return this.options.flow !== false || this.intro.value < 1;
  }

  destroy() {
    super.destroy();
    this.overlay.destroy();
  }

  onHoverChange(hex) {
    const now = performance.now();
    for (const h of this.hexes.values()) h.lift.to(h === hex ? 1 : 0, now, { duration: 200 });
    this.focus.to(hex ? 1 : 0, now, { duration: 200 });
  }

  // Ground-plane picking: any hex under the pointer, even without data.
  pickGround(px, py) {
    const w = this.camera.unproject(px, py);
    if (!w) return null;
    const id = this._hexId(...w);
    return this.hexes.get(id) ?? this.landById.get(id) ?? null;
  }

  // ---- colour ---------------------------------------------------------------

  get stops() {
    return sequentialStops(this.theme, this.options.colorScale ?? this.theme.scale);
  }

  colorFor(value) {
    return rampAt(this.stops, value / this.maxValue);
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
    R.ctx.globalAlpha = 1;
    this._drawCallouts();
    this._drawLegend();
    if (this.hovered && (this.timeline.playing || this.focus.value < 1)) this._updateTooltip();
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
      const data = this.hexes.get(h.id);
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
    if (hovered && !this.hexes.has(hovered.id)) {
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
    const list = [...this.hexes.values()]
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

  // Arcs between coordinates: options.arcs = [{ from: [lon, lat], to: [lon, lat], color? }].
  // A bright pulse travels along each one while options.flow !== false.
  _drawArcs(R) {
    const arcs = this.options.arcs;
    const { camera: C, theme } = this;
    const ctx = R.ctx;
    const intro = this.intro.value;
    const time = performance.now() / 1000;

    arcs.forEach((arc, i) => {
      const [x0, y0] = this.toWorld(...arc.from);
      const [x1, y1] = this.toWorld(...arc.to);
      const dist = Math.hypot(x1 - x0, y1 - y0);
      const h = arc.height ?? Math.min(this.maxHeight * 1.4, dist * 0.35);
      const steps = 40;
      const reveal = Math.max(0, Math.min(1, intro * 1.8 - 0.6 - i * 0.05));
      if (reveal <= 0) return;
      const pts = [];
      for (let k = 0; k <= steps * reveal; k++) {
        const t = k / steps;
        pts.push(C.project(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, Math.sin(Math.PI * t) * h));
      }
      if (pts.length < 2) return;
      const a = parseHex(arc.color ?? theme.series[i % theme.series.length]);
      const b = parseHex(arc.colorTo ?? theme.series[(i + 1) % theme.series.length]);
      const grad = ctx.createLinearGradient(pts[0].x, pts[0].y, pts.at(-1).x, pts.at(-1).y);
      grad.addColorStop(0, rgbString(a));
      grad.addColorStop(1, rgbString(b));

      const trace = () => {
        ctx.beginPath();
        pts.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      };
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      trace();
      ctx.strokeStyle = shade(a, 1.1, 0.18 * (theme.glow || 0.5));
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.6;
      ctx.stroke();

      // Travelling pulse.
      if (this.options.flow !== false && reveal >= 1) {
        let length = 0;
        for (let k = 1; k < pts.length; k++) length += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y);
        const pulse = Math.max(12, length * 0.12);
        ctx.setLineDash([pulse, length]);
        ctx.lineDashOffset = -(((time * 0.45 + i * 0.37) % 1) * (length + pulse)) + pulse;
        ctx.strokeStyle = shade(b, 1.5);
        ctx.lineWidth = 2.4;
        trace();
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Endpoint markers.
      for (const [p, c] of [[pts[0], a], [reveal >= 1 ? pts.at(-1) : null, b]]) {
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = rgbString(c);
        ctx.fill();
      }
    });
  }

  // Callouts: pill labels pinned above hexes. options.callouts is a number
  // (label the top N hexes by value) or [{ lon, lat, title, value? }].
  _drawCallouts() {
    const opt = this.options.callouts;
    if (!opt || this.intro.value < 0.9) return;
    const { renderer: R, camera: C, theme } = this;
    const ctx = R.ctx;
    const alpha = Math.min(1, (this.intro.value - 0.9) / 0.1);

    let items;
    if (typeof opt === 'number') {
      items = [...this.hexes.values()]
        .filter((h) => h.value > 0 && !h.leaving)
        .sort((a, b) => b.value - a.value)
        .slice(0, opt)
        .map((h) => {
          const rec = this.binOf(h)?.records[0];
          return { hex: h, title: rec && this.options.label ? this.options.label(rec) : formatCoord(h.lon, h.lat) };
        });
    } else {
      items = opt.map((c) => {
        const hex = this.hexAt(c.lon, c.lat);
        return { hex, title: c.title, value: c.value };
      });
    }

    const placed = [];
    ctx.globalAlpha = alpha;
    for (const { hex, title, value } of items) {
      const t = Math.min(1, (hex.value ?? 0) / this.maxValue);
      const z = (this.extrude ? t * this.maxHeight : 0.03) + (hex.lift?.value ?? 0) * LIFT;
      const anchor = C.project(hex.x, hex.y, z);
      const text = value ?? (hex.value ? this.format(hex.value) : '');
      const tw = R.measure(title, 11, 500);
      const vw = R.measure(text, 13, 600, true);
      const w = Math.max(tw, vw) + 34;
      const h = 38;
      const x = anchor.x - w / 2;
      const y = anchor.y - 22 - h;
      if (placed.some((p) => x < p.r && x + w > p.l && y < p.b && y + h > p.t)) continue;
      placed.push({ l: x - 4, r: x + w + 4, t: y - 4, b: y + h + 4 });

      R.line(anchor, { x: anchor.x, y: y + h }, theme.textMuted, 1);
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 10);
      ctx.fillStyle = theme.tooltip;
      ctx.fill();
      ctx.strokeStyle = theme.tooltipBorder;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x + 13, y + h / 2, 4, 0, Math.PI * 2);
      ctx.fillStyle = rgbString(this.colorFor(hex.value || this.maxValue));
      ctx.fill();
      R.text(title, x + 24, y + 13, { color: theme.textMuted, size: 11, weight: 500, align: 'left' });
      R.text(text, x + 24, y + 27, { color: theme.text, size: 13, weight: 600, align: 'left', mono: true });
    }
    ctx.globalAlpha = 1;
  }

  _drawLegend() {
    const { renderer: R, theme } = this;
    if (!this.hexes.size) return;
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
    const hv = this.hovered?.value;
    if (hv > 0) {
      const t = Math.min(1, hv / this.maxValue);
      ctx.fillStyle = theme.text;
      ctx.beginPath();
      ctx.moveTo(x + t * width, y - 2);
      ctx.lineTo(x + t * width - 4, y - 7);
      ctx.lineTo(x + t * width + 4, y - 7);
      ctx.fill();
    }
    const label = { color: theme.textMuted, size: 11, mono: true };
    R.text(this.format(0), x, y + 20, { ...label, align: 'left' });
    R.text(this.format(this.maxValue), x + width, y + 20, { ...label, align: 'right' });
  }

  describe(hex) {
    const bin = this.binOf(hex);
    const rec = bin?.records[0];
    const title = rec && this.options.label ? this.options.label(rec) : formatCoord(hex.lon, hex.lat);
    if (!(hex.value > 0)) return { title, rows: [{ label: 'No data', value: '' }] };
    const rows = [
      {
        label: this.options.valueLabel ?? 'Value',
        value: this.format(hex.value),
        color: rgbString(this.colorFor(hex.value)),
      },
    ];
    if (bin && bin.count > 1) rows.push({ label: 'Points', value: String(bin.count) });
    return { title: `${title}${this.frameLabel != null ? ` · ${this.frameLabel}` : ''}`, rows };
  }
}

function formatCoord(lon, lat) {
  const f = (v, pos, neg) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? pos : neg}`;
  return `${f(lat, 'N', 'S')}, ${f(lon, 'E', 'W')}`;
}
