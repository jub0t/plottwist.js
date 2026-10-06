// Regions at any level (countries, states, provinces, counties, districts,
// sales territories...) from GeoJSON or TopoJSON, extruded by value: a 3D
// choropleth. Regions without data form a flat base map; regions with data
// rise as solids coloured on a sequential scale.
//
//   import { worldCountries } from 'plottwist/geo/countries';
//   new IsoRegionMap(el, { regions: worldCountries(), data, key: 'country', value: 'gdp' });
//   new IsoRegionMap(el, { regions: usAtlas, object: 'counties', data: stores, lon: 'lng', lat: 'lat' });
//
// Records join to regions by `key`, matched case-insensitively against the
// feature id and the `joinOn` properties (by default name, iso2, iso3,
// isoNumeric: 'DE', 'DEU', '276' and 'Germany' all find Germany). Or give
// `lon` / `lat` instead, and each record lands in the region containing it.
// drill() / drillUp() move between levels.

import { GeoChart, accessor } from '../core/geo-chart.js';
import { parseHex, shade } from '../core/color.js';
import { faceBrightness } from '../core/shapes.js';
import { topojsonFeatures } from '../geo/topojson.js';

const LIFT = 0.25;
const JOIN_ON = ['name', 'iso2', 'iso3', 'isoNumeric'];
const INDEX = 48; // spatial index resolution (cells per side)
// Options that describe a level, saved and restored by drill() / drillUp().
const LEVEL_KEYS = [
  'regions', 'object', 'bounds', 'key', 'lon', 'lat', 'joinOn', 'regionId', 'regionName',
  'filter', 'exclude', 'labels', 'callouts', 'arcs', 'value', 'format', 'valueLabel', 'aggregate',
];

export class IsoRegionMap extends GeoChart {
  constructor(container, options = {}) {
    super(container, options);
    this.heightRatio = 0.055;
    this.layoutKeys = ['bounds', 'exclude', 'simplify', 'detail', ...LEVEL_KEYS];
    this._levels = [];
    this.configure(this.options);
    this.init();
  }

  configure(options) {
    const o = this.options;
    if (!o.regions || !(o.regions.features || o.regions.type === 'Topology')) {
      throw new Error('plottwist: IsoRegionMap needs `regions`: GeoJSON FeatureCollection or TopoJSON');
    }
    // Records find their region by key, or by coordinates when lon/lat are
    // given without a key.
    this.byPoint = o.key == null && o.lon != null && o.lat != null;
    this.key = accessor(o.key ?? 'id');
    this.lon = accessor(o.lon ?? 'lon');
    this.lat = accessor(o.lat ?? 'lat');
  }

  // The regions as GeoJSON features (TopoJSON is converted; `object` names
  // the layer, e.g. 'states').
  _features() {
    const r = this.options.regions;
    return r.type === 'Topology' ? topojsonFeatures(r, this.options.object).features : r.features;
  }

  // ---- levels ---------------------------------------------------------------

  // Go one level deeper: show `regions` (GeoJSON or TopoJSON) with new data.
  // `options` may set data or frames and any level option (bounds, key,
  // object, regionName, ...). drillUp() restores the previous level.
  drill(regions, { data, frames, ...options } = {}) {
    const level = Object.fromEntries(LEVEL_KEYS.map((k) => [k, this.options[k]]));
    this._levels.push({ level, frames: this._rawFrames, position: this.timeline.position });
    // A new level starts from a clean slate, except how values are read and shown.
    const inherit = new Set(['regions', 'value', 'format', 'valueLabel', 'aggregate']);
    for (const k of LEVEL_KEYS) if (!(k in options) && !inherit.has(k)) delete this.options[k];
    this._rawFrames = frames ?? [{ label: null, data: data ?? [] }];
    this._setHover(null);
    this.reconfigure({ ...options, regions });
    this.emit('drill', { depth: this.depth, regions: this.regions });
  }

  // Back to the previous level; returns false at the top.
  drillUp() {
    const prev = this._levels.pop();
    if (!prev) return false;
    this._rawFrames = prev.frames;
    this._setHover(null);
    this.reconfigure(prev.level);
    this.seek(prev.position);
    this.emit('drill', { depth: this.depth, regions: this.regions });
    return true;
  }

  // How many levels below the first we are.
  get depth() {
    return this._levels.length;
  }

  // ---- geometry ---------------------------------------------------------------

  layout() {
    const o = this.options;
    const exclude = new Set(o.exclude ?? ['ATA']);
    const bounds = o.bounds; // [west, south, east, north] crop, optional
    const polygonsOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);

    // regionId / regionName: how to identify and label a feature; filter:
    // which features to draw at all.
    const idOf = o.regionId ?? ((f, i) => f.id ?? f.properties?.id ?? f.properties?.name ?? i);
    const nameOf = o.regionName ?? ((f, id) => f.properties?.name ?? f.properties?.NAME ?? id);
    const features = this._features().filter((f, i) => {
      if (!f.geometry || exclude.has(String(idOf(f, i)))) return false;
      if (o.filter && !o.filter(f)) return false;
      if (!bounds) return true;
      const [w, s, e, n] = bounds;
      return polygonsOf(f.geometry).some((p) => p[0].some(([lon, lat]) => lon >= w && lon <= e && lat >= s && lat <= n));
    });

    // Fit to the crop if given, otherwise to every coordinate.
    const samples = [];
    if (bounds) {
      const [w, s, e, n] = bounds;
      for (let i = 0; i <= 24; i++) for (let j = 0; j <= 24; j++) samples.push([w + ((e - w) * i) / 24, s + ((n - s) * j) / 24]);
    } else {
      for (const f of features) for (const p of polygonsOf(f.geometry)) for (const pt of p[0]) samples.push(pt);
    }
    this.fitProjection(samples, o.width ?? 100);
    // detail: 1 keeps every visible bend, 0 simplifies hard. Even at full
    // detail, points closer than ~0.04% of the map width (well under a pixel
    // at typical sizes) are dropped. `simplify` sets the tolerance (world
    // units) directly.
    const detail = Math.max(0, Math.min(1, o.detail ?? 1));
    const tolerance = o.simplify ?? this.mapWidth * (0.0004 + 0.006 * (1 - detail) ** 2);

    this.regions = new Map();
    this.aliases = new Map();
    this.unmatched = new Set();
    const joinOn = o.joinOn ?? JOIN_ON;
    features.forEach((f, index) => {
      const id = String(idOf(f, index));
      const polys = polygonsOf(f.geometry)
        .map((poly) =>
          poly
            .map((ring, ri) => {
              const folded = foldAntimeridian(ring);
              return this._ring(bounds ? clipRing(folded, bounds) : folded, ri > 0, tolerance);
            })
            .filter(Boolean),
        )
        .filter((rings) => rings.length && !rings[0].hole);
      if (!polys.length) return;

      // Anchor at the centroid of the largest outer ring, so overseas
      // territories don't drag a label into the ocean.
      const main = polys.map((p) => p[0]).reduce((a, b) => (Math.abs(b.area) > Math.abs(a.area) ? b : a));
      const region = { id, name: String(nameOf(f, id)), feature: f, polys, x: main.cx, y: main.cy };
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of polys) {
        for (const [x, y] of p[0].pts) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      region.bbox = [minX, minY, maxX, maxY];
      region.sweep = this.sweepOf(region.x, region.y);
      this.regions.set(id, region);
      this.aliases.set(id.toLowerCase(), id);
      for (const k of joinOn) {
        const v = f.properties?.[k];
        if (v != null && v !== '') this.aliases.set(String(v).toLowerCase(), id);
      }
    });
    this._buildIndex();
  }

  // Project and simplify a ring; compute its area, centroid and the outward
  // normal of every edge (pointing away from the solid, so into holes).
  _ring(coords, hole, tolerance) {
    if (coords.length < 3) return null;
    const world = coords.map(([lon, lat]) => this.toWorld(lon, lat));
    // Tiny islands would collapse under simplification; keep them as drawn.
    let pts = simplify(world, tolerance);
    if (pts.length < 4) pts = simplify(world, 0);
    if (pts.length < 3) return null;

    let area = 0, cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      const c = x0 * y1 - x1 * y0;
      area += c;
      cx += (x0 + x1) * c;
      cy += (y0 + y1) * c;
    }
    area /= 2;
    if (Math.abs(area) < 1e-9) return null;
    cx /= 6 * area;
    cy /= 6 * area;
    const sign = (area > 0 ? 1 : -1) * (hole ? -1 : 1);
    const normals = pts.map((p, i) => {
      const q = pts[(i + 1) % pts.length];
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const l = Math.hypot(dx, dy) || 1;
      return [(sign * dy) / l, (-sign * dx) / l];
    });
    // Lighting uses normals averaged over neighbouring edges, so jagged
    // coastlines shade smoothly instead of striping; culling uses the exact ones.
    const n = normals.length;
    const smooth = normals.map((_, i) => {
      let x = 0, y = 0;
      for (let k = -2; k <= 2; k++) {
        const m = normals[(i + k + n) % n];
        const w = 3 - Math.abs(k);
        x += m[0] * w;
        y += m[1] * w;
      }
      const l = Math.hypot(x, y) || 1;
      return [x / l, y / l];
    });
    return { pts, normals, smooth, area, cx, cy, hole };
  }

  // A coarse grid over the map listing the regions whose bounding boxes
  // touch each cell, so point lookups test a handful of regions, not all.
  _buildIndex() {
    const w = this.mapWidth || 1;
    const d = this.mapDepth || 1;
    this._index = { cells: new Map(), w, d };
    const cell = (x, y) => [
      Math.max(0, Math.min(INDEX - 1, Math.floor((x / w + 0.5) * INDEX))),
      Math.max(0, Math.min(INDEX - 1, Math.floor((y / d + 0.5) * INDEX))),
    ];
    for (const r of this.regions.values()) {
      const [x0, y0] = cell(r.bbox[0], r.bbox[1]);
      const [x1, y1] = cell(r.bbox[2], r.bbox[3]);
      for (let i = x0; i <= x1; i++) {
        for (let j = y0; j <= y1; j++) {
          const k = j * INDEX + i;
          (this._index.cells.get(k) ?? this._index.cells.set(k, []).get(k)).push(r);
        }
      }
    }
  }

  // Region id for a key ('DEU', 'de', 'Germany', 276 ...), or undefined.
  resolve(key) {
    return key == null ? undefined : this.aliases.get(String(key).toLowerCase());
  }

  binKey(d) {
    if (this.byPoint) {
      const lon = +this.lon(d);
      const lat = +this.lat(d);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      return this.regionAtWorld(...this.toWorld(lon, lat))?.id ?? null;
    }
    const k = this.key(d);
    const id = this.resolve(k);
    if (id == null && k != null && !this.unmatched.has(k)) {
      this.unmatched.add(k);
      if (this.unmatched.size === 1) {
        queueMicrotask(() =>
          console.warn(`plottwist: no region matches ${[...this.unmatched].map((u) => JSON.stringify(u)).join(', ')}`),
        );
      }
    }
    return id ?? null;
  }

  createItem(id) {
    const r = this.regions.get(id);
    return { id, name: r.name, x: r.x, y: r.y, feature: r.feature, region: r };
  }

  // An item or bare region for a key: lets arcs and callouts name regions.
  itemByKey(key) {
    const id = this.resolve(key);
    return id == null ? null : this.items.get(id) ?? this.regions.get(id);
  }

  // The region under a world point.
  regionAtWorld(x, y) {
    const { cells, w, d } = this._index;
    const i = Math.floor((x / w + 0.5) * INDEX);
    const j = Math.floor((y / d + 0.5) * INDEX);
    if (i < 0 || j < 0 || i >= INDEX || j >= INDEX) return null;
    for (const r of cells.get(j * INDEX + i) ?? []) {
      const [x0, y0, x1, y1] = r.bbox;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      for (const poly of r.polys) {
        let inside = false;
        for (const ring of poly) if (pointInRing(ring.pts, x, y)) inside = !inside;
        if (inside) return r;
      }
    }
    return null;
  }

  itemAt(lon, lat) {
    const r = this.regionAtWorld(...this.toWorld(lon, lat));
    return r && (this.items.get(r.id) ?? r);
  }

  // The region at a coordinate, with its current value if it has data.
  regionAt(lon, lat) {
    return this.itemAt(lon, lat);
  }

  topOf(item) {
    const t = Math.min(1, (item.value ?? 0) / this.maxValue);
    return (this.extrude ? t * this.maxHeight : 0) + (item.lift?.value ?? 0) * LIFT;
  }

  // Flat regions are picked through the ground plane.
  pickGround(px, py) {
    const w = this.camera.unproject(px, py);
    const r = w && this.regionAtWorld(w[0], w[1]);
    return r ? this.items.get(r.id) ?? r : null;
  }

  // ---- drawing ----------------------------------------------------------------

  draw() {
    const { renderer: R } = this;
    const hw = this.mapWidth / 2 + 1;
    const hd = this.mapDepth / 2 + 1;
    const top = this.extrude ? this.maxHeight : 0.2;
    this.fitScene(
      [
        [-hw, -hd, 0], [hw, -hd, 0], [hw, hd, 0], [-hw, hd, 0],
        [-hw, -hd, top * 0.5], [hw, -hd, top * 0.5], [0, 0, top],
      ],
      { top: 48, right: 16, bottom: 16, left: 16 },
    );
    this._drawBase();
    this._drawExtruded();
    this._drawLabels();
    this.drawMapLayers();
  }

  _trace(region, z) {
    const C = this.camera;
    const ctx = this.renderer.ctx;
    for (const poly of region.polys) {
      for (const ring of poly) {
        ring.pts.forEach(([x, y], i) => {
          const p = C.project(x, y, z);
          i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
        });
        ctx.closePath();
      }
    }
  }

  // Regions without data: one path, one fill, borders as thin gaps.
  _drawBase() {
    const { renderer: R, theme } = this;
    const ctx = R.ctx;
    ctx.globalAlpha = Math.min(1, this.intro.value * 1.5);
    ctx.beginPath();
    for (const r of this.regions.values()) {
      const item = this.items.get(r.id);
      if (item && item.value > 0) continue;
      this._trace(r, 0);
    }
    ctx.fillStyle = this.options.landColor ?? theme.land;
    ctx.fill('evenodd');
    const { borderWidth, borderColor } = this.strokes;
    if (borderWidth > 0) {
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = borderWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // Outline a hovered region that has no data.
    const h = this.hovered;
    const outline = h && !(h.value > 0) ? (h.polys ? h : h.region) : null;
    if (outline) {
      ctx.beginPath();
      this._trace(outline, 0);
      ctx.strokeStyle = theme.textMuted;
      ctx.lineWidth = Math.max(1.5, borderWidth + 0.5);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Stroke settings: borderWidth / borderColor for the borders between
  // regions, edgeWidth / edgeColor for the outline on raised tops
  // (edgeColor 'none' hides it; by default it's a highlight of the fill).
  get strokes() {
    const o = this.options;
    return {
      borderWidth: o.borderWidth ?? 0.75,
      borderColor: o.borderColor ?? this.theme.surface,
      edgeWidth: o.edgeWidth ?? 1,
      edgeColor: o.edgeColor ?? null,
    };
  }

  _drawExtruded() {
    const { renderer: R, camera: C, theme } = this;
    const hovered = this.hovered;
    const hoverRgb = parseHex(this.options.hoverColor ?? theme.series[1]);
    const list = [...this.items.values()]
      .filter((it) => it.value > 0)
      .sort((a, b) => C.groundDepth(a.x, a.y) - C.groundDepth(b.x, b.y));

    for (const item of list) {
      const t = Math.min(1, item.value / this.maxValue);
      const lift = item.lift.value;
      const z0 = lift * LIFT;
      const z1 = z0 + (this.extrude ? Math.max(0.05, t * this.maxHeight) : 0.05);
      const base = this.colorFor(item.value);
      const rgb = base.map((c, i) => c + (hoverRgb[i] - c) * lift);
      R.ctx.globalAlpha = hovered && item !== hovered ? 1 - 0.35 * this.focus.value : 1;

      const bloom = theme.glow * (t > 0.5 ? t * t * 0.7 : 0) + theme.glow * 0.7 * lift;
      if (bloom > 0) {
        const [x0, y0, x1, y1] = item.region.bbox;
        const span = Math.min(Math.max(x1 - x0, y1 - y0), this.mapWidth * 0.12) * C.scale * C.zoom;
        const c = C.project(item.x, item.y, z1);
        R.glow(rgb, c.x, c.y, span * 1.6, span * 1.1, 0.45 * bloom);
      }
      R.hit(this._drawSolid(item.region, z0, z1, rgb), item);
    }
    R.ctx.globalAlpha = 1;
  }

  // An extruded region: camera-facing wall segments back to front, then the
  // top. Each segment is lit by its own normal, so coastlines shade naturally.
  _drawSolid(region, z0, z1, rgb) {
    const { renderer: R, camera: C, theme } = this;
    const ctx = R.ctx;
    // Round joins: mitred joins spike at every sharp coastline corner.
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const walls = [];
    for (const poly of region.polys) {
      for (const ring of poly) {
        const { pts, normals } = ring;
        for (let i = 0; i < pts.length; i++) {
          const n = normals[i];
          if (!C.faces(n[0], n[1], 0)) continue;
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          walls.push({ a, b, n: ring.smooth[i], d: C.groundDepth((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) });
        }
      }
    }
    walls.sort((p, q) => p.d - q.d);
    const shades = new Map();
    for (const { a, b, n } of walls) {
      // Quantise brightness so nearby segments share one colour string.
      const k = Math.round(faceBrightness(C, theme, [n[0], n[1], 0]) * 40) / 40;
      let fill = shades.get(k);
      if (!fill) shades.set(k, (fill = shade(rgb, k * (1 - 0.15 * theme.gradient))));
      const pa0 = C.project(a[0], a[1], z0);
      const pb0 = C.project(b[0], b[1], z0);
      const pb1 = C.project(b[0], b[1], z1);
      const pa1 = C.project(a[0], a[1], z1);
      ctx.beginPath();
      ctx.moveTo(pa0.x, pa0.y);
      ctx.lineTo(pb0.x, pb0.y);
      ctx.lineTo(pb1.x, pb1.y);
      ctx.lineTo(pa1.x, pa1.y);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      // Stroke in the fill hides seams between segments.
      ctx.strokeStyle = fill;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }

    ctx.beginPath();
    this._trace(region, z1);
    ctx.fillStyle = shade(rgb, faceBrightness(C, theme, [0, 0, 1]) * (1 + 0.1 * theme.gradient));
    ctx.fill('evenodd');
    const { edgeWidth, edgeColor } = this.strokes;
    if (edgeWidth > 0 && edgeColor !== 'none') {
      ctx.strokeStyle = edgeColor ?? shade(rgb, 1.4, 0.35 + 0.4 * theme.edge);
      ctx.lineWidth = edgeWidth;
      ctx.stroke();
    }

    // Hit regions: the top of every ring.
    return region.polys.flatMap((poly) => poly.map((ring) => ring.pts.map(([x, y]) => C.project(x, y, z1))));
  }

  // options.labels: true (all regions with data) or N (the N largest values).
  _drawLabels() {
    const opt = this.options.labels;
    if (!opt || this.intro.value < 0.9) return;
    const { renderer: R, camera: C, theme } = this;
    let list = [...this.items.values()].filter((it) => it.value > 0 && !it.leaving);
    list.sort((a, b) => b.value - a.value);
    if (typeof opt === 'number') list = list.slice(0, opt);
    const placed = [];
    for (const item of list) {
      const p = C.project(item.x, item.y, this.topOf(item));
      const name = this.nameOf(item);
      const w = Math.max(R.measure(name, 11, 600), R.measure(this.format(item.value), 10, 400, true)) + 6;
      const box = { l: p.x - w / 2, r: p.x + w / 2, t: p.y - 30, b: p.y - 2 };
      if (placed.some((q) => box.l < q.r && box.r > q.l && box.t < q.b && box.b > q.t)) continue;
      placed.push(box);
      R.ctx.globalAlpha = this.hovered && item !== this.hovered ? 1 - 0.5 * this.focus.value : 1;
      R.text(name, p.x, p.y - 21, { color: theme.markText ?? theme.text, size: 11, weight: 600, halo: theme.markHalo ?? theme.surface });
      R.text(this.format(item.value), p.x, p.y - 8, { color: theme.markText ?? theme.text, size: 10, mono: true, halo: theme.markHalo ?? theme.surface });
    }
    R.ctx.globalAlpha = 1;
  }
}

function pointInRing(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Douglas-Peucker on a closed ring (the closing duplicate point is dropped).
function simplify(pts, tolerance) {
  if (pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) pts = pts.slice(0, -1);
  }
  if (pts.length <= 4 || tolerance <= 0) return pts;
  const keep = new Uint8Array(pts.length);
  // Split the ring at its first point and the point farthest from it.
  let far = 0;
  let best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > best) (best = d), (far = i);
  }
  keep[0] = keep[far] = 1;
  const stack = [[0, far], [far, pts.length]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const a = pts[i];
    const b = pts[j % pts.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    let maxD = -1;
    let idx = -1;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((pts[k][0] - a[0]) * dy - (pts[k][1] - a[1]) * dx) / len;
      if (d > maxD) (maxD = d), (idx = k);
    }
    if (maxD > tolerance) {
      keep[idx] = 1;
      stack.push([i, idx], [idx, j]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// Clip a [lon, lat] ring to [west, south, east, north] (Sutherland-Hodgman),
// so a cropped map shows only the part of each region inside the crop.
function clipRing(ring, [w, s, e, n]) {
  const edges = [
    [(p) => p[0] >= w, (a, b) => cut(a, b, 0, w)],
    [(p) => p[0] <= e, (a, b) => cut(a, b, 0, e)],
    [(p) => p[1] >= s, (a, b) => cut(a, b, 1, s)],
    [(p) => p[1] <= n, (a, b) => cut(a, b, 1, n)],
  ];
  let out = ring;
  for (const [inside, intersect] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(intersect(prev, cur));
        out.push(cur);
      } else if (inside(prev)) out.push(intersect(prev, cur));
    }
    if (!out.length) break;
  }
  return out;
}

function cut(a, b, axis, value) {
  const t = (value - a[axis]) / (b[axis] - a[axis]);
  return axis === 0 ? [value, a[1] + (b[1] - a[1]) * t] : [a[0] + (b[0] - a[0]) * t, value];
}

// Rings that cross the antimeridian jump from +180 to -180; fold them onto the
// eastern side so they don't stretch across the whole map. Runs before
// clipping, which would otherwise drag the jump across the crop.
function foldAntimeridian(ring) {
  const crosses = ring.some((c, i) => i && Math.abs(c[0] - ring[i - 1][0]) > 180);
  return crosses ? ring.map(([lon, lat]) => [lon < 0 ? 180 : lon, lat]) : ring;
}
