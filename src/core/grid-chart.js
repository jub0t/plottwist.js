// Base for charts laid out on a categorical floor grid: one dimension along x,
// one along y, and a value (optionally split into stacked parts) per cell.
//
// It owns the data model (frames -> per-cell value vectors, with smooth blends
// between datasets and fractional-frame interpolation), the floor, axis labels,
// legends, hover crosshair and frame label. Subclasses draw the marks.

import { Chart } from './chart.js';
import { Tween, ease } from './animation.js';
import { parseHex, shade } from './color.js';

export const FLOOR_PAD = 0.35;
const MAX_LABELS = 16;

const accessor = (a) => (typeof a === 'function' ? a : (d) => d[a]);
export const key = (x, y) => `${x}\u0000${y}`;
const unique = (values) => [...new Set(values)];

export class GridChart extends Chart {
  constructor(container, options = {}) {
    super(container, options);
    this.x = accessor(options.x ?? 'x');
    const y = accessor(options.y ?? 'y');
    this.y = (d) => y(d) ?? '';
    this.value = accessor(options.value ?? 'value');
    this.stack = options.stack ? accessor(options.stack) : null;
    this.format =
      options.format ?? ((v) => v.toLocaleString(undefined, { maximumFractionDigits: 1 }));
    this.spacing = options.spacing ?? [1, 1];
    this.cells = new Map();
    this.focus = new Tween(0);
    // Which floor bands light up under the hovered cell.
    this.crosshair = { x: true, y: true };
  }

  // Subclasses call this at the end of their constructor once defaults are set.
  init() {
    const { options } = this;
    if (options.frames) this.setFrames(options.frames);
    else this.setData(options.data ?? []);
    if (options.autoplay && this.frames.length > 1) this.play();
  }

  // ---- data -----------------------------------------------------------------

  setData(data) {
    this.setFrames([{ label: null, data }]);
  }

  // frames: [{ label, data: [...] }]
  setFrames(frames) {
    const first = this.frames === undefined;
    const all = frames.flatMap((f) => f.data);
    // Category order: explicit domains win, else order of first appearance.
    this.xs = this.options.xDomain ?? unique(all.map(this.x));
    this.ys = this.options.yDomain ?? unique(all.map(this.y));
    this.stackKeys = this.stack ? unique(all.map(this.stack)) : [null];
    const S = this.stackKeys.length;
    const stackIndex = new Map(this.stackKeys.map((k, i) => [k, i]));

    this.frames = frames.map((f) => {
      const values = new Map();
      const records = new Map();
      for (const d of f.data) {
        const k = key(this.x(d), this.y(d));
        records.set(k, d);
        let vec = values.get(k);
        if (!vec) values.set(k, (vec = new Float64Array(S)));
        vec[this.stack ? stackIndex.get(this.stack(d)) : 0] += Math.max(0, +this.value(d) || 0);
      }
      return { label: f.label, values, records };
    });

    // One scale across all frames, so heights stay comparable through time.
    let max = 0;
    for (const f of this.frames)
      for (const vec of f.values.values()) max = Math.max(max, vec.reduce((a, b) => a + b, 0));
    this.maxValue = this.options.max ?? (max || 1);

    const [sx, sy] = this.spacing;
    const nx = this.xs.length;
    const ny = this.ys.length;
    this.maxHeight = this.options.height ?? this.defaultHeight(nx * sx, ny * sy);

    const next = new Map();
    this.xs.forEach((xv, i) => {
      this.ys.forEach((yv, j) => {
        const k = key(xv, yv);
        let cell = this.cells.get(k);
        if (!cell || cell.value.length !== S) {
          cell = {
            key: k,
            x: xv,
            y: yv,
            value: cell?.value.length === S ? cell.value : new Float64Array(S),
            from: new Float64Array(S),
            total: 0,
            blend: new Tween(1),
            lift: new Tween(0),
          };
          cell.parts = this.stackKeys.map((s, index) => ({ cell, index, stack: s }));
        }
        Object.assign(cell, {
          leaving: false,
          // Whether any frame has data here (sparse grids, e.g. calendars).
          present: this.frames.some((f) => f.values.has(k)),
          i,
          j,
          gx: (i - (nx - 1) / 2) * sx,
          gy: (j - (ny - 1) / 2) * sy,
        });
        next.set(k, cell);
      });
    });
    // Cells that disappear shrink away before removal.
    for (const [k, cell] of this.cells) if (!next.has(k)) next.set(k, Object.assign(cell, { leaving: true }));
    this.cells = next;

    this.timeline.length = this.frames.length;
    this.timeline.seek(Math.min(this.timeline.position, this.frames.length - 1));

    const now = performance.now();
    for (const cell of this.cells.values()) {
      cell.from.set(cell.value);
      cell.blend.set(0);
    }
    this.animateIn(first, now);

    this._radius = Math.hypot((nx * sx) / 2 + FLOOR_PAD, (ny * sy) / 2 + FLOOR_PAD) + 0.6;
    this.invalidate();
  }

  defaultHeight(width, depth) {
    return Math.max(2.4, Math.max(width, depth) * 0.6);
  }

  // Each cell blends from its current values into the new data. The entrance
  // is a wave rolling out from the far corner; updates use a quick stagger.
  animateIn(first, now) {
    const n = this.xs.length + this.ys.length;
    for (const cell of this.cells.values()) {
      cell.blend.to(1, now, {
        duration: first ? 900 : 650,
        delay: first ? ((cell.i + cell.j) / n) * 600 : Math.min(600, (cell.i + cell.j) * 18),
        easing: first ? ease.backOut : ease.cubicOut,
      });
    }
  }

  // Interpolated value of one stack part at a fractional timeline position.
  valueAt(cell, s, position) {
    const i = Math.floor(position);
    const t = position - i;
    const a = this.frames[i]?.values.get(cell.key)?.[s] ?? 0;
    if (t === 0 || i + 1 >= this.frames.length) return a;
    const b = this.frames[i + 1].values.get(cell.key)?.[s] ?? 0;
    return a + (b - a) * ease.cubicInOut(t);
  }

  get frameLabel() {
    return this.frames[Math.round(this.timeline.position)]?.label ?? null;
  }

  // World height for a value.
  z(v) {
    return (v / this.maxValue) * this.maxHeight;
  }

  // ---- animation --------------------------------------------------------------

  tick(now) {
    let active = false;
    const position = this.timeline.position;
    for (const cell of this.cells.values()) {
      active = cell.blend.tick(now) || active;
      active = cell.lift.tick(now) || active;
      const b = cell.blend.value;
      let total = 0;
      for (let s = 0; s < cell.value.length; s++) {
        const target = cell.leaving ? 0 : this.valueAt(cell, s, position);
        total += cell.value[s] = cell.from[s] + (target - cell.from[s]) * b;
      }
      cell.total = total;
      if (cell.leaving && b === 1) this.cells.delete(cell.key);
    }
    return this.focus.tick(now) || active;
  }

  // Hover data may be a cell or one stacked part of a cell.
  cellOf(datum) {
    return datum?.cell ?? datum;
  }

  onHoverChange(datum) {
    const now = performance.now();
    const hovered = this.cellOf(datum);
    for (const c of this.cells.values()) c.lift.to(c === hovered ? 1 : 0, now, { duration: 220 });
    this.focus.to(datum ? 1 : 0, now, { duration: 220 });
  }

  // How much a mark should fade because something else is hovered.
  dimFor(cell) {
    const hovered = this.cellOf(this.hovered);
    return hovered && cell !== hovered ? this.focus.value : 0;
  }

  // Cells ordered back to front.
  sortedCells() {
    const C = this.camera;
    return [...this.cells.values()].sort(
      (a, b) => C.groundDepth(a.gx, a.gy) - C.groundDepth(b.gx, b.gy),
    );
  }

  // ---- drawing --------------------------------------------------------------

  draw() {
    const { renderer: R, theme } = this;
    this.fitScene(this.sceneBounds(), { top: 64, right: 28, bottom: 24, left: 28 });
    this.drawFloor();
    this.drawLabels();
    this.drawMarks();
    R.ctx.globalAlpha = 1;
    this.drawLegend();

    if (this.hovered && (this.timeline.playing || this.focus.value < 1)) this._updateTooltip();
  }

  // World points the camera fits to: floor corners (with room for labels)
  // and the ceiling of the tallest possible mark.
  sceneBounds() {
    const [hx, hy] = this.floorExtent();
    const lx = hx + 1.1;
    const ly = hy + 1.1;
    const top = this.maxHeight + 0.2;
    const pts = [];
    for (const [x, y] of [[-lx, -ly], [lx, -ly], [lx, ly], [-lx, ly]]) pts.push([x, y, -0.4]);
    for (const [x, y] of [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]) pts.push([x, y, top]);
    return pts;
  }

  drawMarks() {}

  // Colour for a series slot (stack part when stacked, otherwise row).
  // options.colors may be an array, a { key: colour } map, or (key, index) => colour.
  seriesColor(index) {
    const key = this.stack ? this.stackKeys[index] : this.ys[index];
    const fallback = this.theme.series[index % this.theme.series.length];
    const c = this.options.colors;
    if (typeof c === 'function') return c(key, index) ?? fallback;
    if (Array.isArray(c)) return c[index % c.length];
    if (c && typeof c === 'object') return c[key] ?? fallback;
    return fallback;
  }

  // RGB used for the light pooled under a cell.
  markColor(cell) {
    return parseHex(this.seriesColor(this.stack ? 0 : cell.j));
  }

  get colorByRow() {
    return !this.stack;
  }

  floorExtent() {
    const [sx, sy] = this.spacing;
    return [(this.xs.length * sx) / 2 + FLOOR_PAD, (this.ys.length * sy) / 2 + FLOOR_PAD];
  }

  drawFloor() {
    const { camera: C, renderer: R, theme } = this;
    const ctx = R.ctx;
    const [hx, hy] = this.floorExtent();
    const [sx, sy] = this.spacing;
    const P = (x, y, z = 0) => C.project(x, y, z);
    const t = -theme.floorThickness;
    const base = parseHex(theme.floor);

    // Slab sides, then the top surface.
    if (t < 0) {
      const sides = [
        [[1, 0, 0], [P(hx, -hy, t), P(hx, hy, t), P(hx, hy), P(hx, -hy)]],
        [[-1, 0, 0], [P(-hx, hy, t), P(-hx, -hy, t), P(-hx, -hy), P(-hx, hy)]],
        [[0, 1, 0], [P(hx, hy, t), P(-hx, hy, t), P(-hx, hy), P(hx, hy)]],
        [[0, -1, 0], [P(-hx, -hy, t), P(hx, -hy, t), P(hx, -hy), P(-hx, -hy)]],
      ];
      for (const [n, pts] of sides) {
        if (C.faces(...n)) R.polygon(pts, shade(base, 0.82 + 0.1 * C.light(...n)), theme.grid, 1);
      }
    }
    R.polygon([P(-hx, -hy), P(hx, -hy), P(hx, hy), P(-hx, hy)], theme.floor, theme.grid, 1);

    // Coloured light pooled beneath each mark, brighter for bigger values:
    // a soft ellipse lying flat on the floor.
    if (theme.pool > 0 && this.pools !== false) {
      const r = Math.min(sx, sy) * C.scale * C.zoom * 0.95;
      const squash = Math.max(0.2, C._sp);
      for (const cell of this.cells.values()) {
        if (!cell.present || cell.total <= 0) continue;
        const v = Math.min(1, cell.total / this.maxValue);
        const c = P(cell.gx, cell.gy);
        R.glow(this.markColor(cell), c.x, c.y, r * 2, r * 2 * squash, theme.pool * 0.5 * (0.35 + 0.65 * v));
      }
    }

    // Crosshair: highlight the hovered cell's column and/or row on the floor.
    const hc = this.cellOf(this.hovered);
    if (hc && this.focus.value > 0) {
      ctx.globalAlpha = this.focus.value;
      const { gx, gy } = hc;
      if (this.crosshair.x) {
        const w = sx / 2;
        R.polygon([P(gx - w, -hy), P(gx + w, -hy), P(gx + w, hy), P(gx - w, hy)], theme.highlight);
      }
      if (this.crosshair.y) {
        const w = sy / 2;
        R.polygon([P(-hx, gy - w), P(hx, gy - w), P(hx, gy + w), P(-hx, gy + w)], theme.highlight);
      }
      ctx.globalAlpha = 1;
    }

    // Cell grid, thinned to the labelled ticks when columns are dense.
    const xStep = this.tickStep(this.xs.length);
    const yStep = this.tickStep(this.ys.length);
    const xLines = [];
    const yLines = [];
    for (let i = 0; i <= this.xs.length; i += xStep) xLines.push((i - this.xs.length / 2) * sx);
    for (let j = 0; j <= this.ys.length; j += yStep) yLines.push((j - this.ys.length / 2) * sy);
    const ix = hx - FLOOR_PAD;
    const iy = hy - FLOOR_PAD;
    // options.grid ('lines' | 'dots' | 'none') overrides the theme's style.
    const gridStyle = this.options.grid ?? theme.gridStyle;
    if (gridStyle === 'lines') {
      for (const x of xLines) R.line(P(x, -iy), P(x, iy), theme.grid, 1);
      for (const y of yLines) R.line(P(-ix, y), P(ix, y), theme.grid, 1);
    } else if (gridStyle === 'dots') {
      ctx.fillStyle = theme.grid;
      for (const x of xLines) {
        for (const y of yLines) {
          const p = P(x, y);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  tickStep(n) {
    return Math.max(1, Math.ceil(n / MAX_LABELS));
  }

  // Label text for a category, or null to skip it. Override with
  // options.xTicks / options.yTicks: (value, index) => string | null.
  tickLabel(axis, value, index) {
    const custom = this.options[axis === 'x' ? 'xTicks' : 'yTicks'];
    if (custom) return custom(value, index);
    const n = axis === 'x' ? this.xs.length : this.ys.length;
    return index % this.tickStep(n) === 0 ? String(value) : null;
  }

  // Category labels sit along whichever floor edges currently face the viewer.
  // Labels that would collide with one already placed are skipped; the
  // hovered row/column label always wins.
  drawLabels() {
    const { camera: C, renderer: R, theme } = this;
    const [fx, fy] = this.floorExtent();
    const hx = fx + 0.3;
    const hy = fy + 0.3;
    const ey = C.groundDepth(0, hy) > C.groundDepth(0, -hy) ? hy : -hy;
    const ex = C.groundDepth(hx, 0) > C.groundDepth(-hx, 0) ? hx : -hx;
    const hovered = this.cellOf(this.hovered);
    const c = C.project(0, 0, 0);
    const placed = [];

    const alignFor = (outward) => {
      const o = C.project(outward[0], outward[1], 0);
      const dx = o.x - c.x;
      const dir = dx / (Math.hypot(dx, o.y - c.y) || 1);
      return dir < -0.3 ? 'right' : dir > 0.3 ? 'left' : 'center';
    };

    // Reserve a label's box; false if it would overlap one already placed.
    const reserve = (x, y, width, align, force) => {
      const left = align === 'right' ? x - width : align === 'left' ? x : x - width / 2;
      const box = { l: left - 3, r: left + width + 3, t: y - 8, b: y + 8 };
      if (!force && placed.some((p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t)) return false;
      placed.push(box);
      return true;
    };

    const items = [];
    const xAlign = alignFor([0, Math.sign(ey)]);
    this.xs.forEach((xv, i) => {
      const active = hovered?.x === xv;
      const label = active ? String(xv) : this.tickLabel('x', xv, i);
      if (label == null) return;
      const gx = (i - (this.xs.length - 1) / 2) * this.spacing[0];
      const p = C.project(gx, ey, -theme.floorThickness);
      items.push({ label, x: p.x, y: p.y + 4, align: xAlign, active });
    });

    const showY = !(this.ys.length === 1 && this.ys[0] === '');
    const yAlign = alignFor([Math.sign(ex), 0]);
    if (showY) {
      this.ys.forEach((yv, j) => {
        const active = hovered?.y === yv;
        const label = active ? String(yv) : this.tickLabel('y', yv, j);
        if (label == null) return;
        const gy = (j - (this.ys.length - 1) / 2) * this.spacing[1];
        const p = C.project(ex, gy, -theme.floorThickness);
        items.push({ label, x: p.x, y: p.y + 4, align: yAlign, active, swatch: this.colorByRow ? j : null });
      });
    }

    // Active labels claim their space first.
    items.sort((a, b) => b.active - a.active);
    for (const it of items) {
      const weight = it.active ? 600 : 400;
      const width = R.measure(it.label, 12, weight) + (it.swatch != null ? 12 : 0);
      if (!reserve(it.x, it.y, width, it.align, it.active)) continue;
      const style = { color: it.active ? theme.text : theme.textMuted, weight };
      if (it.swatch == null) {
        R.text(it.label, it.x, it.y, { ...style, align: it.align });
        continue;
      }
      // Colour swatch beside the label carries series identity; text stays in ink.
      const sx = it.align === 'right' ? it.x - width : it.align === 'left' ? it.x : it.x - width / 2;
      this.swatch(sx, it.y, this.seriesColor(it.swatch));
      R.text(it.label, sx + 12, it.y, { ...style, align: 'left' });
    }
  }

  swatch(x, y, color) {
    const ctx = this.renderer.ctx;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y - 4, 8, 8, 2);
    ctx.fill();
  }

  // Stacked charts get a swatch legend in the top-right corner.
  drawLegend() {
    if (!this.stack) return;
    const { renderer: R, theme } = this;
    const hovered = this.hovered?.cell ? this.hovered.index : -1;
    let x = R.width - 20;
    for (let s = this.stackKeys.length - 1; s >= 0; s--) {
      const label = String(this.stackKeys[s]);
      const weight = s === hovered ? 600 : 400;
      x -= R.measure(label, 12, weight);
      R.text(label, x, 30, { color: s === hovered ? theme.text : theme.textMuted, weight, align: 'left' });
      x -= 12;
      this.swatch(x, 30, this.seriesColor(s));
      x -= 16;
    }
  }

  // The source datum behind a cell in the frame currently shown.
  recordOf(cell) {
    const f = this.frames[Math.round(this.timeline.position)];
    return f?.records.get(cell.key) ?? this.frames.find((fr) => fr.records.has(cell.key))?.records.get(cell.key);
  }

  // Tooltip title: options.label(datum) when given, else the fallback.
  titleFor(cell, fallback) {
    const record = this.recordOf(cell);
    return this.options.label && record ? this.options.label(record) : fallback;
  }

  frameSuffix() {
    const label = this.frameLabel;
    return label != null ? ` · ${label}` : '';
  }
}
