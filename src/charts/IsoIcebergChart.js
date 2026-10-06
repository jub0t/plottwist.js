// What's seen and what's hidden. Each category is an iceberg floating in a
// cutaway sea: the part above the waterline is one value (reported, known,
// visible), the part below another (unreported, estimated, hidden). Heights
// are to scale, so the hidden share reads at a glance. When the data
// changes, a berg rises or sinks and bobs before it settles.
//
//   new IsoIcebergChart(el, { frames, key: 'area', above: 'reported', below: 'unreported' })

import { Chart } from '../core/chart.js';
import { Tween, ease } from '../core/animation.js';
import { parseHex, rgbString, shade } from '../core/color.js';
import { faceBrightness } from '../core/shapes.js';
import { accessor, claim, framesOf } from '../core/stage.js';

const SIDES = 9;
const TOTAL_HEIGHT = 6; // world height of the biggest berg, tip to peak
// Ring profiles: [fraction of the part's height, radius factor].
const BELOW = [[0, 0.2], [0.22, 0.7], [0.5, 1], [0.78, 0.97], [1, 0.86]];
const ABOVE = [[0, 0.86], [0.38, 0.66], [0.72, 0.38], [1, 0.1]];

export class IsoIcebergChart extends Chart {
  constructor(container, options = {}) {
    super(container, { camera: { yaw: 0.3, pitch: 0.3 }, frameDuration: 2000, ...options });
    const o = this.options;
    this.key = accessor(o.key ?? 'name');
    this.above = accessor(o.above ?? 'above');
    this.below = accessor(o.below ?? 'below');
    this.format = o.format ?? ((v) => v.toLocaleString(undefined, { maximumFractionDigits: 1 }));
    this.focus = new Tween(0);
    this.bergs = [];
    this._last = null;
    this.setFrames(framesOf(o));
    if (o.autoplay && this.frames.length > 1) this.play();
  }

  // ---- data -----------------------------------------------------------------

  setData(data) {
    this.setFrames([{ label: null, data }]);
  }

  setFrames(frames) {
    const keys = [];
    let max = 0;
    this.frames = frames.map((f) => {
      const values = new Map();
      for (const d of f.data) {
        const k = this.key(d);
        if (!keys.includes(k)) keys.push(k);
        const v = values.get(k) ?? [0, 0];
        v[0] += Math.max(0, +this.above(d) || 0);
        v[1] += Math.max(0, +this.below(d) || 0);
        values.set(k, v);
        max = Math.max(max, v[0] + v[1]);
      }
      return { label: f.label, values };
    });
    this.maxTotal = this.options.max ?? (max || 1);
    const old = new Map(this.bergs.map((b) => [b.key, b]));
    this.bergs = keys.map((key, index) => {
      const b = old.get(key) ?? { key, up: 0, down: 0, vUp: 0, vDown: 0, shape: shapeFor(key) };
      return Object.assign(b, { index });
    });
    const n = this.bergs.length;
    this.perRow = this.options.perRow ?? (n <= 6 ? n : Math.ceil(n / Math.ceil(n / 6)));
    this.rows = Math.ceil(n / this.perRow);
    this.radius = this.options.radius ?? 1.1;
    this.pitch = [this.radius * 2 + 1.5, this.radius * 2 + 2];
    // The sea is as deep as the deepest berg could reach.
    let deepest = 0;
    for (const f of this.frames) for (const [, b] of f.values) deepest = Math.max(deepest, b[1]);
    this.depth = (deepest / this.maxTotal) * TOTAL_HEIGHT + 0.5;
    this.timeline.length = this.frames.length;
    this.timeline.seek(Math.min(this.timeline.position, this.frames.length - 1));
    this.invalidate();
  }

  get frameLabel() {
    return this.frames[Math.round(this.timeline.position)]?.label ?? null;
  }

  valuesAt(key, position = this.timeline.position) {
    const i = Math.floor(position);
    const t = position - i;
    const a = this.frames[i]?.values.get(key) ?? [0, 0];
    if (t === 0 || i + 1 >= this.frames.length) return a;
    const b = this.frames[i + 1].values.get(key) ?? [0, 0];
    const e = ease.cubicInOut(t);
    return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e];
  }

  center(b) {
    const col = b.index % this.perRow;
    const row = Math.floor(b.index / this.perRow);
    return [(col - (this.perRow - 1) / 2) * this.pitch[0], (row - (this.rows - 1) / 2) * this.pitch[1]];
  }

  // ---- physics ----------------------------------------------------------------

  // Heights above and below the waterline are springs chasing each frame's
  // values: a berg that gains or loses mass overshoots and bobs.
  tick(now) {
    const dt = this._last == null ? 1 / 60 : Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    let active = this.focus.tick(now);
    const frame = this.frames[Math.round(this.timeline.position)];
    for (const b of this.bergs) {
      b.values = this.valuesAt(b.key);
      const [ua, ub] = frame?.values.get(b.key) ?? [0, 0];
      const goalUp = (ua / this.maxTotal) * TOTAL_HEIGHT;
      const goalDown = (ub / this.maxTotal) * TOTAL_HEIGHT;
      for (let k = 0; k < 4; k++) {
        const h = dt / 4;
        b.vUp += (26 * (goalUp - b.up) - 4.2 * b.vUp) * h;
        b.vDown += (26 * (goalDown - b.down) - 4.2 * b.vDown) * h;
        b.up += b.vUp * h;
        b.down += b.vDown * h;
      }
      if (Math.abs(goalUp - b.up) + Math.abs(goalDown - b.down) > 1e-4 || Math.abs(b.vUp) + Math.abs(b.vDown) > 1e-4) active = true;
    }
    return active;
  }

  onHoverChange() {
    this.focus.to(this.hovered ? 1 : 0, this.now(), { duration: 200 });
  }

  // ---- geometry ---------------------------------------------------------------

  // Rings of the berg (world points), bottom tip to peak; `water` is the
  // index of the ring that sits exactly on the waterline.
  rings(b) {
    const [cx, cy] = this.center(b);
    const r = this.radius * (0.75 + 0.25 * Math.sqrt(Math.max(0, b.up + b.down) / TOTAL_HEIGHT));
    const ring = (z, k, j) =>
      b.shape.angles.map((a, v) => {
        const rr = r * k * b.shape.jitter[j][v];
        return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, z];
      });
    const down = Math.max(0.05, b.down);
    const up = Math.max(0.05, b.up);
    const below = BELOW.map(([f, k], j) => ring(-down * (1 - f), k, j));
    const above = ABOVE.slice(1).map(([f, k], j) => ring(up * f, k, BELOW.length + j));
    return { list: [...below, ...above], water: BELOW.length - 1 };
  }

  // ---- drawing ------------------------------------------------------------------

  seaBounds() {
    const hx = ((this.perRow - 1) * this.pitch[0]) / 2 + this.radius * 1.3 + 0.6;
    const hy = ((this.rows - 1) * this.pitch[1]) / 2 + this.radius * 1.3 + 0.6;
    return [hx, hy];
  }

  waterRgb() {
    return parseHex(this.options.waterColor ?? (this.theme.mode === 'dark' ? '#1d6fa8' : '#5aa9e0'));
  }

  draw() {
    const { camera: C, renderer: R, theme } = this;
    const [hx, hy] = this.seaBounds();
    const D = this.depth;
    const top = (this.maxTotal ? TOTAL_HEIGHT : 1) + 0.3;
    const pts = [];
    for (const [x, y] of [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]) {
      pts.push([x, y, -D, { b: 10 }]);
      pts.push([x, y, Math.min(top, TOTAL_HEIGHT * 0.6), { t: 36 }]);
    }
    this.fitScene(pts, { top: 14, right: 16, bottom: 14, left: 16 });

    const P = (x, y, z) => C.project(x, y, z);
    const water = this.waterRgb();
    const ctx = R.ctx;
    const order = [...this.bergs].sort((a, b) => C.groundDepth(...this.center(a)) - C.groundDepth(...this.center(b)));
    const geo = new Map(order.map((b) => [b, this.rings(b)]));

    // Seabed and the far walls of the water, seen through the near ones.
    R.polygon([P(-hx, -hy, -D), P(hx, -hy, -D), P(hx, hy, -D), P(-hx, hy, -D)], shade(water, 0.35), null);
    const walls = [
      [[1, 0, 0], [[hx, -hy], [hx, hy]]],
      [[-1, 0, 0], [[-hx, hy], [-hx, -hy]]],
      [[0, 1, 0], [[hx, hy], [-hx, hy]]],
      [[0, -1, 0], [[-hx, -hy], [hx, -hy]]],
    ];
    for (const [n, [[ax, ay], [bx, by]]] of walls) {
      if (C.faces(...n)) continue;
      R.polygon([P(ax, ay, -D), P(bx, by, -D), P(bx, by, 0), P(ax, ay, 0)], shade(water, 0.5, 0.5), null);
    }

    // Under the water, then the water itself, then what floats above.
    for (const b of order) this.drawPart(b, geo.get(b), 'below', water);
    ctx.globalAlpha = 1;
    // Near walls: clear at the surface, deepening toward the seabed.
    for (const [n, [[ax, ay], [bx, by]]] of walls) {
      if (!C.faces(...n)) continue;
      const quad = [P(ax, ay, -D), P(bx, by, -D), P(bx, by, 0), P(ax, ay, 0)];
      const top = Math.min(quad[2].y, quad[3].y);
      const bottom = Math.max(quad[0].y, quad[1].y);
      const grad = ctx.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0, shade(water, 1.2, 0.12));
      grad.addColorStop(1, shade(water, 0.55, 0.55));
      R.polygon(quad, grad, shade(water, 1.3, 0.6), 1);
    }
    R.polygon([P(-hx, -hy, 0), P(hx, -hy, 0), P(hx, hy, 0), P(-hx, hy, 0)], shade(water, 1.15, 0.22), shade(water, 1.5, 0.85), 1.25);
    // Foam where each berg meets the water.
    for (const b of order) {
      const g = geo.get(b);
      const ring = g.list[g.water].map((p) => P(...p));
      R.polygon(ring, null, theme.mode === 'dark' ? 'rgba(235,248,255,0.85)' : 'rgba(255,255,255,0.95)', 2);
    }
    for (const b of order) this.drawPart(b, geo.get(b), 'above', water);
    ctx.globalAlpha = 1;
    this.drawLabels(geo);
    if (this.hovered && (this.timeline.playing || this.focus.value < 1)) this._updateTooltip();
  }

  // Facets between consecutive rings, bottom to top (nearer, higher facets
  // paint over lower ones, which is right seen from above).
  drawPart(b, geo, part, water) {
    const { camera: C, renderer: R, theme } = this;
    const ctx = R.ctx;
    const { list, water: w } = geo;
    const [from, to] = part === 'below' ? [0, w] : [w, list.length - 1];
    const ice = parseHex(this.options.iceColor ?? '#dff3ff');
    const dim = this.hovered && this.hovered !== b ? 1 - 0.5 * this.focus.value : 1;
    const glow = this.hovered === b ? 1 + 0.1 * this.focus.value : 1;
    const [cx, cy] = this.center(b);
    const hits = [];
    ctx.globalAlpha = dim * (part === 'below' ? 0.92 : 1);
    for (let i = from; i < to; i++) {
      const lo = list[i];
      const hi = list[i + 1];
      for (let v = 0; v < SIDES; v++) {
        const a = lo[v];
        const c = lo[(v + 1) % SIDES];
        const d = hi[(v + 1) % SIDES];
        const e = hi[v];
        const n = outward(a, c, d, [cx, cy, (a[2] + d[2]) / 2]);
        if (!C.faces(...n)) continue;
        let rgb = ice;
        // Facets catch the light unevenly, like ice.
        const k = faceBrightness(C, theme, n, glow) * b.shape.tone[i][v];
        if (part === 'below') rgb = ice.map((x, j) => x + (water[j] - x) * 0.35);
        const fill = shade(rgb, k);
        const poly = [a, c, d, e].map((p) => C.project(...p));
        R.polygon(poly, fill, fill, 0.6);
        hits.push(poly);
      }
    }
    if (part === 'above') {
      const peak = list[list.length - 1];
      const cap = peak.map((p) => C.project(...p));
      if (C.faces(0, 0, 1)) {
        const fill = shade(ice, faceBrightness(C, theme, [0, 0, 1], glow) * 1.05);
        R.polygon(cap, fill, fill, 0.6);
        hits.push(cap);
      }
    }
    R.hit(hits, b);
  }

  drawLabels(geo) {
    const { camera: C, renderer: R, theme } = this;
    const ink = theme.markText ?? theme.text;
    const halo = theme.markHalo ?? theme.surface;
    const placed = [];
    const order = [...this.bergs].sort((a, b) => C.groundDepth(...this.center(b)) - C.groundDepth(...this.center(a)));
    for (const b of order) {
      const g = geo.get(b);
      const [cx, cy] = this.center(b);
      const [up, down] = b.values ?? [0, 0];
      R.ctx.globalAlpha = this.hovered && this.hovered !== b ? 1 - 0.5 * this.focus.value : 1;
      // Above the peak: name and the visible amount.
      const peak = C.project(cx, cy, Math.max(0.05, b.up));
      const name = String(b.key);
      const w = R.measure(name, 12, 600) / 2 + 3;
      if (claim(placed, { l: peak.x - w, r: peak.x + w, t: peak.y - 34, b: peak.y - 4 }) || b === this.hovered) {
        R.text(name, peak.x, peak.y - 24, { color: ink, size: 12, weight: 600, halo });
        R.text(this.format(up), peak.x, peak.y - 10, { color: ink, size: 11, mono: true, halo });
      }
      // Under the tip: the hidden amount and share.
      const tip = C.project(cx, cy, -Math.max(0.05, b.down));
      const share = up + down ? Math.round((down / (up + down)) * 100) : 0;
      R.text(`${this.format(down)} · ${share}% hidden`, tip.x, tip.y + 12, { color: ink, size: 11, mono: true, halo });
      void g;
    }
    R.ctx.globalAlpha = 1;
  }

  describe(b) {
    const [up, down] = b.values ?? [0, 0];
    const total = up + down;
    const pct = (v) => (total ? `${((v / total) * 100).toFixed(1)}%` : '–');
    return {
      title: `${b.key}${this.frameLabel != null ? ` · ${this.frameLabel}` : ''}`,
      rows: [
        { label: this.options.aboveLabel ?? 'Above', value: `${this.format(up)} (${pct(up)})`, color: '#dff3ff' },
        { label: this.options.belowLabel ?? 'Below', value: `${this.format(down)} (${pct(down)})`, color: rgbString(this.waterRgb()) },
        { label: 'Total', value: this.format(total) },
      ],
    };
  }
}

// A berg's fixed irregularity, seeded from its key so it keeps its shape.
function shapeFor(key) {
  let seed = 7;
  for (const ch of String(key)) seed = (seed * 31 + ch.charCodeAt(0)) % 2147483647;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const rings = BELOW.length + ABOVE.length;
  const angles = Array.from({ length: SIDES }, (_, v) => ((v + (rnd() - 0.5) * 0.5) / SIDES) * Math.PI * 2);
  const jitter = Array.from({ length: rings }, () => Array.from({ length: SIDES }, () => 0.82 + rnd() * 0.32));
  const tone = Array.from({ length: rings }, () => Array.from({ length: SIDES }, () => 0.9 + rnd() * 0.18));
  return { angles, jitter, tone };
}

// Normal of a quad (a, c, d), flipped to point away from the axis point.
function outward(a, c, d, center) {
  const u = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1;
  n = n.map((x) => x / l);
  const out = [(a[0] + d[0]) / 2 - center[0], (a[1] + d[1]) / 2 - center[1], 0];
  return n[0] * out[0] + n[1] * out[1] < 0 ? n.map((x) => -x) : n;
}
