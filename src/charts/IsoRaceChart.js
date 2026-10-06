// A 3D bar chart race: the top N entities stand in a row, tallest first.
// Values interpolate continuously between frames; ranks are recomputed every
// frame and bars glide to their new slots, rising out of / sinking into the
// end of the row as they enter or leave the top N. The height scale follows
// the leader, and a back-wall axis re-ticks as it grows.
//
//   new IsoRaceChart(el, { frames, key: 'name', value: 'users', color: 'genre', top: 10 })

import { Chart } from '../core/chart.js';
import { Tween, ease } from '../core/animation.js';
import { parseHex, shade } from '../core/color.js';
import { drawBox } from '../core/shapes.js';
import { niceTicks } from '../core/grid-chart.js';

const SPACING = 1;
const DEPTH = 0.62;
const accessor = (a) => (typeof a === 'function' ? a : (d) => d[a]);

export class IsoRaceChart extends Chart {
  constructor(container, options = {}) {
    super(container, { camera: { yaw: 0.42, pitch: 0.5 }, frameDuration: 1000, ...options });
    const o = this.options;
    this.key = accessor(o.key ?? 'name');
    this.value = accessor(o.value ?? 'value');
    this.category = o.color ? accessor(o.color) : null;
    this.format = o.format ?? ((v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }));
    this.top = o.top ?? 10;
    this.barWidth = o.barWidth ?? 0.62;
    this.maxHeight = o.height ?? 5;
    this.bars = new Map();
    this.scaleMax = 0;
    this.focus = new Tween(0);
    this.intro = new Tween(0);
    if (o.frames) this.setFrames(o.frames);
    else this.setData(o.data ?? []);
    if (o.autoplay && this.frames.length > 1) this.play();
  }

  // ---- data -----------------------------------------------------------------

  setData(data) {
    this.setFrames([{ label: null, data }]);
  }

  setFrames(frames) {
    const first = this.frames === undefined;
    const categories = [];
    const info = new Map();
    this.frames = frames.map((f) => {
      const values = new Map();
      for (const d of f.data) {
        const k = this.key(d);
        values.set(k, (values.get(k) ?? 0) + (+this.value(d) || 0));
        if (!info.has(k)) {
          const cat = this.category ? this.category(d) : k;
          if (!categories.includes(cat)) categories.push(cat);
          info.set(k, { category: cat });
        }
      }
      return { label: f.label, values };
    });
    // Colour follows the entity (or its category), in order of first
    // appearance, never its rank.
    this.categories = categories;
    for (const [k, { category }] of info) {
      const bar = this.bars.get(k) ?? { key: k, pos: this.top + 1, value: 0, lift: new Tween(0) };
      bar.category = category;
      bar.colorIndex = categories.indexOf(category);
      this.bars.set(k, bar);
    }
    for (const k of [...this.bars.keys()]) if (!info.has(k)) this.bars.delete(k);

    this.timeline.length = this.frames.length;
    this.timeline.seek(Math.min(this.timeline.position, this.frames.length - 1));
    if (first) this.intro.to(1, performance.now(), { duration: 1200, easing: ease.cubicOut });
    this._last = null;
    this.invalidate();
  }

  // Interpolated value of an entity at a fractional frame position (linear,
  // so ranks swap at the moment values actually cross).
  valueAt(key, position) {
    const i = Math.floor(position);
    const t = position - i;
    const a = this.frames[i]?.values.get(key) ?? 0;
    if (t === 0 || i + 1 >= this.frames.length) return a;
    const b = this.frames[i + 1].values.get(key) ?? 0;
    return a + (b - a) * t;
  }

  get frameLabel() {
    return this.frames[Math.round(this.timeline.position)]?.label ?? null;
  }

  // Current standings: [{ key, value, rank }] for the top N.
  get standings() {
    return [...this.bars.values()]
      .filter((b) => b.rank < this.top)
      .sort((a, b) => a.rank - b.rank)
      .map((b) => ({ key: b.key, value: b.value, rank: b.rank + 1 }));
  }

  // ---- animation --------------------------------------------------------------

  tick(now) {
    const dt = this._last == null ? 16 : Math.min(100, now - this._last);
    this._last = now;
    const position = this.timeline.position;
    let active = this.intro.tick(now);

    const ranked = [...this.bars.values()];
    for (const b of ranked) b.value = this.valueAt(b.key, position);
    ranked.sort((a, b) => b.value - a.value);
    ranked.forEach((b, i) => (b.rank = b.value > 0 ? i : Infinity));

    // Bars glide toward their slot; those outside the top N head past the end.
    const k = 1 - Math.exp(-dt / 140);
    for (const b of ranked) {
      const target = Math.min(b.rank, this.top + 0.6);
      const d = target - b.pos;
      if (Math.abs(d) > 0.002) {
        b.pos += d * k;
        active = true;
      } else b.pos = target;
      active = b.lift.tick(now) || active;
    }

    // The scale follows the leader, eased so it doesn't jitter.
    const leader = ranked[0]?.value ?? 0;
    const targetMax = this.options.max ?? Math.max(leader * 1.08, 1e-9);
    if (Math.abs(targetMax - this.scaleMax) > targetMax * 0.001) {
      this.scaleMax += (targetMax - this.scaleMax) * (this.scaleMax ? 1 - Math.exp(-dt / 220) : 1);
      active = true;
    }
    return this.focus.tick(now) || active;
  }

  onHoverChange(bar) {
    const now = performance.now();
    for (const b of this.bars.values()) b.lift.to(b === bar ? 1 : 0, now, { duration: 200 });
    this.focus.to(bar ? 1 : 0, now, { duration: 200 });
  }

  // ---- geometry ---------------------------------------------------------------

  // World x of a slot (rank 0 on the left).
  slotX(pos) {
    return (pos - (this.top - 1) / 2) * SPACING;
  }

  z(v) {
    return this.scaleMax ? (v / this.scaleMax) * this.maxHeight * this.intro.value : 0;
  }

  // ---- drawing ----------------------------------------------------------------

  draw() {
    const { renderer: R, camera: C } = this;
    const hx = (this.top * SPACING) / 2 + 0.3;
    const hy = DEPTH / 2 + 0.5;
    this.fitScene(
      [
        [-hx - 0.6, -hy, -0.3], [hx + 0.6, -hy, -0.3], [hx + 0.6, hy, -0.3], [-hx - 0.6, hy, -0.3],
        [-hx, -hy, this.maxHeight + 0.6], [hx, -hy, this.maxHeight + 0.6],
      ],
      { top: 36, right: 24, bottom: 16, left: 48 },
    );
    this._drawStage(hx, hy);
    this._drawBars();
    if (this.hovered && (this.timeline.playing || this.focus.value < 1)) this._updateTooltip();
  }

  // Floor slab and a back wall with value gridlines that re-tick as the
  // scale grows.
  _drawStage(hx, hy) {
    const { renderer: R, camera: C, theme } = this;
    const ctx = R.ctx;
    const P = (x, y, z = 0) => C.project(x, y, z);
    const t = -theme.floorThickness;
    const base = parseHex(theme.floor);
    const sides = [
      [[1, 0, 0], [P(hx, -hy, t), P(hx, hy, t), P(hx, hy), P(hx, -hy)]],
      [[-1, 0, 0], [P(-hx, hy, t), P(-hx, -hy, t), P(-hx, -hy), P(-hx, hy)]],
      [[0, 1, 0], [P(hx, hy, t), P(-hx, hy, t), P(-hx, hy), P(hx, hy)]],
      [[0, -1, 0], [P(-hx, -hy, t), P(hx, -hy, t), P(hx, -hy), P(-hx, -hy)]],
    ];
    for (const [n, pts] of sides) if (C.faces(...n)) R.polygon(pts, shade(base, 0.82 + 0.1 * C.light(...n)), theme.grid, 1);
    R.polygon([P(-hx, -hy), P(hx, -hy), P(hx, hy), P(-hx, hy)], theme.floor, theme.grid, 1);

    if (this.options.axis === false || !this.scaleMax) return;
    const yFar = C.groundDepth(0, hy) < C.groundDepth(0, -hy) ? hy : -hy;
    const H = this.maxHeight * this.intro.value;
    R.polygon([P(-hx, yFar), P(hx, yFar), P(hx, yFar, H), P(-hx, yFar, H)], theme.wall ?? theme.floor, theme.grid, 1);
    const xLabel = P(-hx, yFar).x < P(hx, yFar).x ? -hx : hx;
    for (const tick of niceTicks(this.scaleMax / 1.08, 4)) {
      const z = this.z(tick);
      if (z > H + 1e-6) continue;
      if (tick > 0) R.line(P(-hx, yFar, z), P(hx, yFar, z), theme.grid, 1);
      const p = P(xLabel, yFar, z);
      R.text(this.format(tick), p.x + (xLabel < 0 ? -8 : 8), p.y, {
        color: theme.textMuted,
        size: 11,
        mono: true,
        align: xLabel < 0 ? 'right' : 'left',
      });
    }
  }

  _drawBars() {
    const { renderer: R, camera: C, theme } = this;
    const ctx = R.ctx;
    const w = this.barWidth / 2;
    const d = DEPTH / 2;
    const hovered = this.hovered;
    const visible = [...this.bars.values()]
      .filter((b) => b.pos < this.top + 0.5 && b.value > 0)
      .sort((a, b) => C.groundDepth(this.slotX(a.pos), 0) - C.groundDepth(this.slotX(b.pos), 0));

    const labels = [];
    for (const b of visible) {
      // Fade as a bar slides off the end of the row.
      const fade = Math.max(0, Math.min(1, this.top - 0.1 - b.pos + 0.6));
      ctx.globalAlpha = fade * (hovered && b !== hovered ? 1 - 0.5 * this.focus.value : 1);
      const x = this.slotX(b.pos);
      const h = Math.max(0.02, this.z(b.value));
      const rgb = parseHex(theme.series[b.colorIndex % theme.series.length]);
      const lift = b.lift.value;
      const bloom = theme.glow * (b.rank === 0 ? 0.7 : 0.25 + 0.5 * lift);
      const box = { x0: x - w, x1: x + w, y0: -d, y1: d, z0: 0, z1: h };
      R.hit(drawBox(C, R, theme, box, rgb, { glow: 1 + 0.12 * lift, bloom }), b);
      labels.push({ b, x, h, alpha: ctx.globalAlpha });
    }
    ctx.globalAlpha = 1;

    // Name and value ride on top of each bar. Values always show; a name is
    // skipped if it would overlap one already placed (leaders placed first).
    const ink = theme.markText ?? theme.text;
    const halo = theme.markHalo ?? theme.surface;
    const placed = [];
    labels.sort((a, b) => a.b.rank - b.b.rank);
    for (const { b, x, h, alpha } of labels) {
      const p = C.project(x, 0, h);
      ctx.globalAlpha = alpha;
      const name = String(b.key);
      const half = R.measure(name, 11, 600) / 2 + 3;
      const box = { l: p.x - half, r: p.x + half, t: p.y - 34, b: p.y - 19 };
      if (!placed.some((q) => box.l < q.r && box.r > q.l && box.t < q.b && box.b > q.t)) {
        placed.push(box);
        R.text(name, p.x, p.y - 26, { color: ink, size: 11, weight: 600, halo });
      }
      R.text(this.format(b.value), p.x, p.y - 12, { color: ink, size: 11, mono: true, halo });
    }
    ctx.globalAlpha = 1;
    this._drawLegend();
  }

  // Category swatches, top-right, when bars are coloured by category.
  _drawLegend() {
    if (!this.category || this.categories.length < 2) return;
    const { renderer: R, theme } = this;
    const ctx = R.ctx;
    let x = R.width - 20;
    for (let i = this.categories.length - 1; i >= 0; i--) {
      const label = String(this.categories[i]);
      x -= R.measure(label, 12);
      R.text(label, x, 22, { color: theme.textMuted, align: 'left' });
      x -= 12;
      ctx.fillStyle = theme.series[i % theme.series.length];
      ctx.beginPath();
      ctx.roundRect(x, 18, 8, 8, 2);
      ctx.fill();
      x -= 16;
    }
  }

  describe(bar) {
    const rows = [
      {
        label: this.options.valueLabel ?? 'Value',
        value: this.format(bar.value),
        color: this.theme.series[bar.colorIndex % this.theme.series.length],
      },
      { label: 'Rank', value: Number.isFinite(bar.rank) ? `#${bar.rank + 1}` : '–' },
    ];
    if (this.category) rows.push({ label: 'Category', value: String(bar.category) });
    return { title: `${bar.key}${this.frameLabel != null ? ` · ${this.frameLabel}` : ''}`, rows };
  }
}
