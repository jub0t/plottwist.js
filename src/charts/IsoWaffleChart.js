// A unit chart in cubes: each category is a stack of cubes, one cube per
// `unit` of value. Cubes keep their identity, so when the data changes they
// physically fly from shrinking stacks to growing ones: you watch the shift
// between categories instead of comparing two snapshots.
//
//   new IsoWaffleChart(el, { frames, key: 'channel', value: 'users', unit: 1e6 })

import { Chart } from '../core/chart.js';
import { Tween, ease } from '../core/animation.js';
import { parseHex } from '../core/color.js';
import { drawBox } from '../core/shapes.js';
import { accessor, claim, drawSlab, framesOf, seriesColor } from '../core/stage.js';

const CUBE = 0.8; // cube edge; the lattice pitch is 1

export class IsoWaffleChart extends Chart {
  constructor(container, options = {}) {
    super(container, { frameDuration: 1800, ...options });
    const o = this.options;
    this.key = accessor(o.key ?? 'name');
    this.value = accessor(o.value ?? 'value');
    this.format = o.format ?? ((v) => v.toLocaleString(undefined, { maximumFractionDigits: 1 }));
    this.footprint = o.footprint ?? [4, 4];
    this.cubes = [];
    this.frameIndex = -1;
    this.focus = new Tween(0);
    this.setFrames(framesOf(o));
    if (o.autoplay && this.frames.length > 1) this.play();
  }

  // ---- data -----------------------------------------------------------------

  setData(data) {
    this.setFrames([{ label: null, data }]);
  }

  setFrames(frames) {
    const keys = [];
    this.frames = frames.map((f) => {
      const values = new Map();
      for (const d of f.data) {
        const k = this.key(d);
        if (!keys.includes(k)) keys.push(k);
        values.set(k, (values.get(k) ?? 0) + Math.max(0, +this.value(d) || 0));
      }
      return { label: f.label, values };
    });
    const old = new Map((this.categories ?? []).map((c) => [c.key, c]));
    // Cubes follow their category's key, wherever it now sits in the order.
    const oldKeys = (this.categories ?? []).map((c) => c.key);
    for (const cube of this.cubes) {
      const k = keys.indexOf(oldKeys[cube.cat]);
      if (k < 0) cube.leaving = true;
      else cube.cat = k;
    }
    this.categories = keys.map((key, index) => Object.assign(old.get(key) ?? { key }, { index }));

    // One cube = `unit`: given, or a round value that keeps the biggest stack
    // to about eight layers.
    const [fx, fy] = this.footprint;
    let max = 0;
    for (const f of this.frames) for (const v of f.values.values()) max = Math.max(max, v);
    this.unit = this.options.unit ?? niceCeil(max / (fx * fy * (this.options.layers ?? 8)) || 1);
    this.maxLayers = Math.max(1, Math.ceil(Math.round(max / this.unit) / (fx * fy)));

    // Stacks in rows of `perRow`.
    const n = keys.length;
    this.perRow = Math.max(1, this.options.perRow ?? (n <= 3 ? n : Math.ceil(Math.sqrt(n))));
    this.rows = Math.ceil(n / this.perRow);
    this.pitch = [fx + 1.6, fy + 1.6];

    this.timeline.length = this.frames.length;
    this.timeline.seek(Math.min(this.timeline.position, this.frames.length - 1));
    this.frameIndex = -1; // reassign cubes on the next tick
    this.invalidate();
  }

  get frameLabel() {
    return this.frames[Math.round(this.timeline.position)]?.label ?? null;
  }

  // Interpolated value for labels, which count smoothly while cubes move.
  valueAt(key, position = this.timeline.position) {
    const i = Math.floor(position);
    const t = position - i;
    const a = this.frames[i]?.values.get(key) ?? 0;
    if (t === 0 || i + 1 >= this.frames.length) return a;
    const b = this.frames[i + 1].values.get(key) ?? 0;
    return a + (b - a) * ease.cubicInOut(t);
  }

  // Centre of a category's stack on the floor.
  stackCenter(index) {
    const col = index % this.perRow;
    const row = Math.floor(index / this.perRow);
    return [(col - (this.perRow - 1) / 2) * this.pitch[0], (row - (this.rows - 1) / 2) * this.pitch[1]];
  }

  // World position of slot s in a category's stack: layers fill row by row.
  slotPosition(index, s) {
    const [fx, fy] = this.footprint;
    const [cx, cy] = this.stackCenter(index);
    const layer = Math.floor(s / (fx * fy));
    const r = s % (fx * fy);
    return [cx + (r % fx) - (fx - 1) / 2, cy + Math.floor(r / fx) - (fy - 1) / 2, layer];
  }

  colorOf(index) {
    return parseHex(seriesColor(this, this.categories[index].key, index));
  }

  // Move cubes to match frame f: each stack keeps the cubes it can, surplus
  // cubes fly to the stacks that grew, and the rest spawn or leave.
  assign(f, now) {
    const counts = this.categories.map((c) => Math.round((this.frames[f]?.values.get(c.key) ?? 0) / this.unit));
    const byCat = this.categories.map(() => []);
    const live = this.cubes.filter((c) => !c.leaving);
    for (const cube of live) {
      if (cube.cat < byCat.length && this.categories[cube.cat]) byCat[cube.cat].push(cube);
      else cube.leaving = true;
    }
    const pool = [];
    const wanted = [];
    byCat.forEach((list, k) => {
      list.sort((a, b) => a.slot - b.slot);
      // Highest slots leave first, so stacks shrink from the top.
      while (list.length > counts[k]) pool.push(list.pop());
      for (let s = list.length; s < counts[k]; s++) wanted.push([k, s]);
      list.forEach((cube, s) => this.move(cube, k, s, now, 0));
    });
    pool.reverse(); // lowest of the surplus first: they travel in a tidy order

    const moving = wanted.length + Math.max(0, pool.length - wanted.length);
    const stagger = Math.min(14, 700 / Math.max(1, moving));
    wanted.forEach(([k, s], i) => {
      let cube = pool.shift();
      if (!cube) {
        // New cubes drop in from above.
        const [x, y, z] = this.slotPosition(k, s);
        cube = { cat: k, slot: s, from: [x, y, z + 5], to: [x, y, z], fromRgb: this.colorOf(k), alphaFrom: 0, t: new Tween(0) };
        cube.toRgb = cube.fromRgb;
        this.cubes.push(cube);
        cube.t.to(1, now, { duration: 800, delay: i * stagger, easing: ease.cubicOut });
        return;
      }
      this.move(cube, k, s, now, i * stagger);
    });
    for (const [i, cube] of pool.entries()) {
      // Surplus with nowhere to go floats up and fades out.
      const p = this.positionOf(cube);
      cube.from = p;
      cube.to = [p[0], p[1], p[2] + 4];
      cube.fromRgb = cube.toRgb = this.rgbOf(cube);
      cube.alphaFrom = 1;
      cube.leaving = true;
      cube.t.set(0);
      cube.t.to(1, now, { duration: 700, delay: (wanted.length + i) * stagger, easing: ease.cubicInOut });
    }
  }

  move(cube, k, s, now, delay) {
    const to = this.slotPosition(k, s);
    // Already there, or already on its way.
    if (cube.cat === k && cube.slot === s && cube.to.every((v, i) => v === to[i])) return;
    cube.from = this.positionOf(cube);
    cube.fromRgb = this.rgbOf(cube);
    cube.to = to;
    cube.toRgb = this.colorOf(k);
    cube.alphaFrom = this.alphaOf(cube);
    cube.cat = k;
    cube.slot = s;
    cube.t.set(0);
    cube.t.to(1, now, { duration: 1000, delay, easing: ease.cubicInOut });
  }

  // Current position: along an arc whose height grows with the distance.
  positionOf(cube) {
    const t = cube.t.value;
    const { from: a, to: b } = cube;
    if (t >= 1) return b;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const arc = d > 0.01 ? (1.2 + d * 0.22) * Math.sin(Math.PI * t) : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t + arc];
  }

  rgbOf(cube) {
    const t = cube.t.value;
    return cube.fromRgb.map((c, i) => c + (cube.toRgb[i] - c) * t);
  }

  alphaOf(cube) {
    const t = cube.t.value;
    const target = cube.leaving ? 0 : 1;
    return cube.alphaFrom + (target - cube.alphaFrom) * t;
  }

  // ---- animation --------------------------------------------------------------

  tick(now) {
    const f = Math.max(0, Math.min(this.frames.length - 1, Math.round(this.timeline.position)));
    if (f !== this.frameIndex) {
      this.frameIndex = f;
      this.assign(f, now);
    }
    let active = false;
    for (const cube of this.cubes) active = cube.t.tick(now) || active;
    const before = this.cubes.length;
    this.cubes = this.cubes.filter((c) => !(c.leaving && c.t.value === 1));
    return this.focus.tick(now) || active || before !== this.cubes.length;
  }

  onHoverChange() {
    this.focus.to(this.hovered ? 1 : 0, this.now(), { duration: 200 });
  }

  // ---- drawing ----------------------------------------------------------------

  floorBounds() {
    const [fx, fy] = this.footprint;
    const hx = ((this.perRow - 1) * this.pitch[0] + fx) / 2 + 0.8;
    const hy = ((this.rows - 1) * this.pitch[1] + fy) / 2 + 0.8;
    return [hx, hy];
  }

  draw() {
    const { camera: C, renderer: R, theme } = this;
    const [hx, hy] = this.floorBounds();
    const [fx, fy] = this.footprint;
    const top = this.maxLayers + 0.3;
    const pts = [];
    for (const [x, y] of [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]) {
      pts.push([x, y, -theme.floorThickness, { b: 6 }]);
    }
    for (const c of this.categories) {
      const [cx, cy] = this.stackCenter(c.index);
      for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pts.push([cx + (dx * fx) / 2, cy + (dy * fy) / 2, top, { t: 40 }]);
    }
    this.fitScene(pts, { top: 16, right: 16, bottom: 28, left: 16 });

    drawSlab(this, -hx, hx, -hy, hy);
    // A pad marks where each stack stands, even while it's empty.
    for (const c of this.categories) {
      const [cx, cy] = this.stackCenter(c.index);
      const P = (x, y) => C.project(cx + x, cy + y, 0);
      const w = fx / 2 + 0.15;
      const h = fy / 2 + 0.15;
      R.polygon([P(-w, -h), P(w, -h), P(w, h), P(-w, h)], theme.highlight, theme.grid, 1);
    }

    this.drawCubes();
    this.drawLabels();
    this.drawUnit();
    if (this.hovered && (this.timeline.playing || this.focus.value < 1)) this._updateTooltip();
  }

  drawCubes() {
    const { camera: C, renderer: R, theme } = this;
    const ctx = R.ctx;
    const h = CUBE / 2;
    const hovered = this.hovered;
    // Far to near: with equal axis-aligned cubes, depth of the centre orders them.
    const list = this.cubes.map((cube) => {
      const [x, y, z] = this.positionOf(cube);
      return { cube, x, y, z, depth: C.groundDepth(x, y) * C._cp + (z + h) * C._sp };
    });
    list.sort((a, b) => a.depth - b.depth);
    for (const { cube, x, y, z } of list) {
      const alpha = this.alphaOf(cube);
      if (alpha <= 0.01) continue;
      const cat = this.categories[cube.cat];
      const dim = hovered && cat !== hovered ? 1 - 0.65 * this.focus.value : 1;
      ctx.globalAlpha = alpha * dim;
      const glow = cat === hovered ? 1 + 0.12 * this.focus.value : 1;
      const hits = drawBox(C, R, theme, { x0: x - h, x1: x + h, y0: y - h, y1: y + h, z0: z, z1: z + CUBE }, this.rgbOf(cube), { glow });
      if (cat && !cube.leaving) R.hit(hits, cat);
    }
    ctx.globalAlpha = 1;
  }

  // Name and value ride above each stack. Values always show; a name is
  // skipped if it would collide with one already placed (nearest first).
  drawLabels() {
    const { camera: C, renderer: R, theme } = this;
    const [fx, fy] = this.footprint;
    const ink = theme.markText ?? theme.text;
    const halo = theme.markHalo ?? theme.surface;
    const items = this.categories.map((c) => {
      const [cx, cy] = this.stackCenter(c.index);
      const value = this.valueAt(c.key);
      const layers = Math.ceil(Math.round(value / this.unit) / (fx * fy));
      return { c, value, p: C.project(cx, cy, layers + 0.1), depth: C.groundDepth(cx, cy) };
    });
    items.sort((a, b) => b.depth - a.depth);
    const placed = [];
    for (const { c, value, p } of items) {
      const active = c === this.hovered;
      R.ctx.globalAlpha = this.hovered && !active ? 1 - 0.5 * this.focus.value : 1;
      const name = String(c.key);
      const w = R.measure(name, 12, 600) / 2 + 3;
      if (claim(placed, { l: p.x - w, r: p.x + w, t: p.y - 36, b: p.y - 20 }) || active) {
        R.text(name, p.x, p.y - 28, { color: ink, size: 12, weight: 600, halo });
      }
      R.text(this.format(value), p.x, p.y - 13, { color: ink, size: 11, mono: true, halo });
    }
    R.ctx.globalAlpha = 1;
  }

  // The key to reading the chart: what one cube is worth.
  drawUnit() {
    const { renderer: R, theme } = this;
    const ctx = R.ctx;
    const x = 20;
    const y = R.height - 16;
    ctx.fillStyle = theme.textMuted;
    ctx.beginPath();
    ctx.roundRect(x, y - 5, 10, 10, 2);
    ctx.fill();
    const label = this.options.unitLabel ? ` ${this.options.unitLabel}` : '';
    R.text(`= ${this.format(this.unit)}${label}`, x + 16, y, { color: theme.textMuted, size: 12, align: 'left' });
  }

  describe(cat) {
    const value = this.valueAt(cat.key);
    const total = this.categories.reduce((s, c) => s + this.valueAt(c.key), 0);
    const color = seriesColor(this, cat.key, cat.index);
    return {
      title: `${cat.key}${this.frameLabel != null ? ` · ${this.frameLabel}` : ''}`,
      rows: [
        { label: this.options.valueLabel ?? 'Value', value: this.format(value), color },
        { label: 'Cubes', value: String(Math.round(value / this.unit)) },
        { label: 'Share', value: total ? `${((value / total) * 100).toFixed(1)}%` : '–' },
      ],
    };
  }
}

// Smallest 1, 2, 2.5 or 5 x 10^n at or above v.
export function niceCeil(v) {
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * mag >= v - 1e-12) return f * mag;
  return 10 * mag;
}
