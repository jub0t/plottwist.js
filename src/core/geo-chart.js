// Base for map charts. Owns the projection and the lon/lat <-> world <->
// screen mapping, binning records into map items (hexes, regions) across
// frames with smooth blends, hover focus, colour scale and legend, plus the
// shared map layers: flowing arcs (on an overlay canvas) and callouts.
//
// Subclasses implement:
//   layout()            build geometry; call fitProjection() first
//   binKey(record)      item key for a record, or null to skip it
//   createItem(key)     { id, x, y, ... } for a key (world position = anchor)
//   topOf(item)         world z of the item's top (for callouts)
//   draw()              render; call drawMapLayers() at the end

import { Chart } from './chart.js';
import { Renderer } from './renderer.js';
import { Tween, ease } from './animation.js';
import { parseHex, rampAt, rgbString, sequentialStops, shade } from './color.js';
import { resolveProjection } from '../geo/index.js';

export const accessor = (a) => (typeof a === 'function' ? a : (d) => d[a]);

const AGGREGATES = {
  sum: (b) => b.sum,
  mean: (b) => b.sum / b.count,
  min: (b) => b.min,
  max: (b) => b.max,
  count: (b) => b.count,
};

export class GeoChart extends Chart {
  constructor(container, options = {}) {
    super(container, { camera: { yaw: 0, pitch: 0.72 }, ...options });
    const o = this.options;
    this.value = accessor(o.value ?? 'value');
    this.aggregate = typeof o.aggregate === 'function' ? o.aggregate : AGGREGATES[o.aggregate ?? 'sum'];
    this.format = o.format ?? ((v) => v.toLocaleString(undefined, { maximumFractionDigits: 1 }));
    this.projection = resolveProjection(o.projection);
    this.extrude = o.extrude ?? true;
    this.focus = new Tween(0);
    this.intro = new Tween(0);
    this.items = new Map();
    // Arcs live on their own layer so their flowing pulses don't force the
    // whole map to redraw every frame.
    this.overlay = new Renderer(this.container, { overlay: true });
    this.container.insertBefore(this.overlay.canvas, this.tooltip);
  }

  // Subclasses call this at the end of their constructor.
  init() {
    this.layout();
    const o = this.options;
    if (o.frames) this.setFrames(o.frames);
    else this.setData(o.data ?? []);
    if (o.autoplay && this.frames.length > 1) this.play();
  }

  // ---- projection -----------------------------------------------------------

  // Scale and centre the projection so `coords` ([lon, lat] samples) span
  // `width` world units. Sets mapWidth and mapDepth.
  fitProjection(coords, width) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [lon, lat] of coords) {
      const [x, y] = this.projection.forward(lon, lat);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    this._k = width / (maxX - minX || 1);
    this._mid = [(minX + maxX) / 2, (minY + maxY) / 2];
    this.mapWidth = (maxX - minX) * this._k;
    this.mapDepth = (maxY - minY) * this._k;
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

  // World [x, y] for an arc/callout endpoint: [lon, lat] or an item key.
  pointOf(ref) {
    if (Array.isArray(ref)) return this.toWorld(ref[0], ref[1]);
    const item = this.items.get(ref) ?? this.itemByKey?.(ref);
    return item ? [item.x, item.y] : null;
  }

  // Change options at runtime and rebuild what they affect. Keys listed in
  // `layoutKeys` rebuild geometry and re-bin the data.
  reconfigure(options) {
    Object.assign(this.options, options);
    if ('projection' in options) this.projection = resolveProjection(options.projection);
    if ('extrude' in options) this.extrude = options.extrude;
    if ('value' in options) this.value = accessor(options.value ?? 'value');
    if ('format' in options && options.format) this.format = options.format;
    if ('aggregate' in options) {
      const a = options.aggregate ?? 'sum';
      this.aggregate = typeof a === 'function' ? a : AGGREGATES[a];
    }
    this.configure?.(options);
    if (['projection', 'value', 'aggregate', ...(this.layoutKeys ?? [])].some((k) => k in options)) {
      this.layout();
      this.items.clear();
      this._fit = null;
      const frames = this._rawFrames;
      this.frames = undefined; // replay the entrance on the new layout
      this.intro.set(0);
      this.setFrames(frames);
    }
    this.invalidate();
  }

  // ---- data -----------------------------------------------------------------

  setData(data) {
    this.setFrames([{ label: null, data }]);
  }

  // frames: [{ label, data }]; records are binned by binKey().
  setFrames(frames) {
    const first = this.frames === undefined;
    this._rawFrames = frames;
    this.frames = frames.map((f) => {
      const bins = new Map();
      for (const d of f.data) {
        const key = this.binKey(d);
        if (key == null) continue;
        const v = +this.value(d) || 0;
        const b =
          bins.get(key) ??
          bins.set(key, { sum: 0, count: 0, min: Infinity, max: -Infinity, records: [] }).get(key);
        b.sum += v;
        b.count++;
        b.min = Math.min(b.min, v);
        b.max = Math.max(b.max, v);
        b.records.push(d);
      }
      const values = new Map();
      for (const [key, b] of bins) values.set(key, this.aggregate(b));
      return { label: f.label, values, bins };
    });

    let max = 0;
    for (const f of this.frames) for (const v of f.values.values()) max = Math.max(max, v);
    this.maxValue = this.options.max ?? (max || 1);
    this.maxHeight = this.options.height ?? this.mapWidth * (this.heightRatio ?? 0.12);

    const now = performance.now();
    const keys = new Set(this.frames.flatMap((f) => [...f.values.keys()]));
    for (const [key, item] of this.items) if (!keys.has(key)) item.leaving = true;
    for (const key of keys) {
      let item = this.items.get(key);
      if (!item) {
        item = Object.assign(this.createItem(key), { value: 0, blend: new Tween(1), lift: new Tween(0) });
        item.sweep = this.sweepOf(item.x, item.y);
        this.items.set(key, item);
      }
      item.leaving = false;
    }
    for (const item of this.items.values()) {
      item.from = item.value;
      item.blend.set(0);
      item.blend.to(1, now, {
        duration: first ? 900 : 650,
        delay: first ? 500 + item.sweep * 900 : item.sweep * 300,
        easing: first ? ease.backOut : ease.cubicOut,
      });
    }
    if (first) this.intro.to(1, now, { duration: 1600, easing: ease.cubicOut });

    this.timeline.length = this.frames.length;
    this.timeline.seek(Math.min(this.timeline.position, this.frames.length - 1));
    this.invalidate();
  }

  // Entrance order: a sweep from west to east, slightly north to south.
  sweepOf(x, y) {
    return (x / this.mapWidth + 0.5) * 0.7 + (y / this.mapDepth + 0.5) * 0.3;
  }

  valueAt(item, position) {
    const i = Math.floor(position);
    const t = position - i;
    const a = this.frames[i]?.values.get(item.id) ?? 0;
    if (t === 0 || i + 1 >= this.frames.length) return a;
    const b = this.frames[i + 1].values.get(item.id) ?? 0;
    return a + (b - a) * ease.cubicInOut(t);
  }

  get frameLabel() {
    return this.frames[Math.round(this.timeline.position)]?.label ?? null;
  }

  // Bin (records, count, sum, ...) for an item in the frame on screen.
  binOf(item) {
    return this.frames[Math.round(this.timeline.position)]?.bins.get(item.id) ?? null;
  }

  // ---- animation --------------------------------------------------------------

  tick(now) {
    let active = this.intro.tick(now);
    const position = this.timeline.position;
    for (const item of this.items.values()) {
      active = item.blend.tick(now) || active;
      active = item.lift.tick(now) || active;
      const target = item.leaving ? 0 : this.valueAt(item, position);
      item.value = item.from + (target - item.from) * item.blend.value;
      if (item.leaving && item.blend.value === 1) this.items.delete(item.id);
    }
    return this.focus.tick(now) || active;
  }

  onHoverChange(item) {
    const now = performance.now();
    for (const it of this.items.values()) it.lift.to(it === item ? 1 : 0, now, { duration: 200 });
    this.focus.to(item ? 1 : 0, now, { duration: 200 });
  }

  // Redraw the arc layer; keep animating while pulses flow.
  drawOverlay() {
    const O = this.overlay;
    O.ctx.clearRect(0, 0, O.width, O.height);
    if (!this.options.arcs?.length) return false;
    this.drawArcs(O);
    return this.options.flow !== false || this.intro.value < 1;
  }

  destroy() {
    super.destroy();
    this.overlay.destroy();
  }

  // ---- colour ---------------------------------------------------------------

  get stops() {
    return sequentialStops(this.theme, this.options.colorScale ?? this.theme.scale);
  }

  colorFor(value) {
    return rampAt(this.stops, value / this.maxValue);
  }

  // ---- shared layers --------------------------------------------------------

  // Callouts, legend and live tooltip; subclasses call this after their marks.
  drawMapLayers() {
    this.renderer.ctx.globalAlpha = 1;
    this.drawCallouts();
    this.drawLegend();
    if (this.hovered && (this.timeline.playing || this.focus.value < 1)) this._updateTooltip();
  }

  // Arcs between places: options.arcs = [{ from, to, color?, colorTo?, height? }]
  // where from/to are [lon, lat] or item keys (e.g. region ids). A bright
  // pulse travels along each one while options.flow !== false.
  drawArcs(R) {
    const { camera: C, theme } = this;
    const ctx = R.ctx;
    const intro = this.intro.value;
    const time = performance.now() / 1000;

    this.options.arcs.forEach((arc, i) => {
      const from = this.pointOf(arc.from);
      const to = this.pointOf(arc.to);
      if (!from || !to) return;
      const [x0, y0] = from;
      const [x1, y1] = to;
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

  // Display name for an item: options.label(record), the item's own name,
  // or its coordinates.
  nameOf(item) {
    const rec = this.binOf(item)?.records[0];
    if (rec && this.options.label) return this.options.label(rec);
    if (item.name) return item.name;
    const [lon, lat] = item.lon != null ? [item.lon, item.lat] : this.toLonLat(item.x, item.y);
    return formatCoord(lon, lat);
  }

  // Callouts: pill labels pinned above items. options.callouts is a number
  // (the top N by value) or [{ at: [lon, lat] | key, title, value? }].
  drawCallouts() {
    const opt = this.options.callouts;
    if (!opt || this.intro.value < 0.9) return;
    const { renderer: R, camera: C, theme } = this;
    const ctx = R.ctx;
    const alpha = Math.min(1, (this.intro.value - 0.9) / 0.1);

    let entries;
    if (typeof opt === 'number') {
      entries = [...this.items.values()]
        .filter((it) => it.value > 0 && !it.leaving)
        .sort((a, b) => b.value - a.value)
        .slice(0, opt)
        .map((item) => ({ item, title: this.nameOf(item) }));
    } else {
      entries = opt.map((c) => {
        const at = c.at ?? [c.lon, c.lat];
        const item = Array.isArray(at) ? this.itemAt?.(at[0], at[1]) : this.items.get(at) ?? this.itemByKey?.(at);
        const [x, y] = item ? [item.x, item.y] : this.pointOf(at);
        return { item: item ?? { x, y, value: 0 }, title: c.title, value: c.value };
      });
    }

    const placed = [];
    ctx.globalAlpha = alpha;
    for (const { item, title, value } of entries) {
      const anchor = C.project(item.x, item.y, this.topOf(item));
      const text = value ?? (item.value ? this.format(item.value) : '');
      const w = Math.max(R.measure(title, 11, 500), R.measure(text, 13, 600, true)) + 34;
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
      ctx.fillStyle = rgbString(this.colorFor(item.value || this.maxValue));
      ctx.fill();
      R.text(title, x + 24, y + 13, { color: theme.textMuted, size: 11, weight: 500, align: 'left' });
      R.text(text, x + 24, y + 27, { color: theme.text, size: 13, weight: 600, align: 'left', mono: true });
    }
    ctx.globalAlpha = 1;
  }

  // Sequential legend, top-right, with a marker for the hovered value.
  drawLegend() {
    const { renderer: R, theme } = this;
    if (!this.items.size) return;
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

  describe(item) {
    const bin = this.binOf(item);
    const title = this.nameOf(item);
    if (!(item.value > 0)) return { title, rows: [{ label: 'No data', value: '' }] };
    const rows = [
      {
        label: this.options.valueLabel ?? 'Value',
        value: this.format(item.value),
        color: rgbString(this.colorFor(item.value)),
      },
    ];
    if (bin && bin.count > 1) rows.push({ label: 'Points', value: String(bin.count) });
    return { title: `${title}${this.frameLabel != null ? ` · ${this.frameLabel}` : ''}`, rows };
  }
}

export function formatCoord(lon, lat) {
  const f = (v, pos, neg) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? pos : neg}`;
  return `${f(lat, 'N', 'S')}, ${f(lon, 'E', 'W')}`;
}
