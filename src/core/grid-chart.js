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

// Round tick values from 0 to at least `max`. Among round steps (1, 2, 2.5, 5
// x 10^n) giving 3-6 intervals, pick the one with the lowest top, so the
// axis hugs the data instead of overshooting it.
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const mag = 10 ** Math.floor(Math.log10(max / count));
  let best = null;
  for (const m of [mag / 10, mag, mag * 10]) {
    for (const f of [1, 2, 2.5, 5]) {
      const step = f * m;
      const n = Math.ceil(max / step - 1e-9);
      if (n < 3 || n > 6) continue;
      const top = n * step;
      if (!best || top < best.top - 1e-9 || (Math.abs(top - best.top) < 1e-9 && Math.abs(n - count) < Math.abs(best.n - count))) {
        best = { step, n, top };
      }
    }
  }
  return Array.from({ length: best.n + 1 }, (_, i) => +(i * best.step).toPrecision(12));
}

// Round ticks covering [min, max]; [0, ...] when min is 0, as niceTicks.
export function niceTicksRange(min, max, count = 4) {
  if (min >= 0) return niceTicks(max, count);
  if (max <= 0) return niceTicks(-min, count).map((t) => -t).reverse();
  const span = max - min;
  let best = null;
  const mag = 10 ** Math.floor(Math.log10(span / count));
  for (const m of [mag / 10, mag, mag * 10]) {
    for (const f of [1, 2, 2.5, 5]) {
      const step = f * m;
      const lo = Math.floor(min / step - 1e-9);
      const hi = Math.ceil(max / step - 1e-9);
      const n = hi - lo;
      if (n < 3 || n > 7) continue;
      const cover = (hi - lo) * step;
      if (!best || cover < best.cover - 1e-9) best = { step, lo, hi, cover };
    }
  }
  if (!best) return [min, 0, max];
  return Array.from({ length: best.hi - best.lo + 1 }, (_, i) => +((best.lo + i) * best.step).toPrecision(12));
}

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
  // Whether values below zero are kept (true for surfaces); bars and tiles
  // clamp them to zero.
  get signed() {
    return false;
  }

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

  // Change options after creation (look, scale, axis...) and rebuild from
  // the current data.
  reconfigure(options = {}) {
    Object.assign(this.options, options);
    this.setFrames(this._rawFrames);
  }

  // frames: [{ label, data: [...] }]
  setFrames(frames) {
    const first = this.frames === undefined;
    this._rawFrames = frames;
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
        const raw = +this.value(d) || 0;
        vec[this.stack ? stackIndex.get(this.stack(d)) : 0] += this.signed ? raw : Math.max(0, raw);
      }
      return { label: f.label, values, records };
    });

    // One scale across all frames, so heights stay comparable through time.
    let max = 0;
    let min = 0;
    for (const f of this.frames) {
      for (const vec of f.values.values()) {
        const t = vec.reduce((a, b) => a + b, 0);
        max = Math.max(max, t);
        min = Math.min(min, t);
      }
    }
    // With a value axis the scale tops out at a round tick, so gridlines
    // land on clean values; without one it fits the data exactly. Charts
    // that allow negative values (signed) start the scale below zero.
    const axis = this.axis;
    if (this.signed && this.options.min != null) min = Math.min(0, this.options.min);
    if (this.options.max != null) {
      this.maxValue = this.options.max;
      this.minValue = min;
      this.ticks = niceTicksRange(min, this.maxValue, axis.ticks).filter((t) => t <= this.maxValue + 1e-9 && t >= min - 1e-9);
    } else if (axis.show) {
      this.ticks = niceTicksRange(min, max || (min < 0 ? 0 : 1), axis.ticks);
      this.minValue = this.ticks[0];
      this.maxValue = this.ticks.at(-1);
    } else {
      this.minValue = min;
      this.maxValue = max || (min < 0 ? 0 : 1);
      this.ticks = [];
    }
    if (this.maxValue - this.minValue < 1e-12) this.maxValue = this.minValue + 1;

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

    const now = this.now();
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
    return ((v - this.minValue) / (this.maxValue - this.minValue)) * this.maxHeight;
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
    const now = this.now();
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
    // Room at the top for the series legend; labels reserve their own.
    const top = this.stack ? 48 : 12;
    this.fitScene(this.sceneBounds(), { top, right: 12, bottom: 12, left: 12 });
    if (this.options.floor !== false) this.drawFloor();
    this.drawWalls();
    this.drawLabels();
    this.drawMarks();
    R.ctx.globalAlpha = 1;
    this.drawLevel();
    this.drawLegend();

    if (this.hovered && (this.timeline.playing || this.focus.value < 1)) this._updateTooltip();
  }

  // World points the camera fits to: floor corners, the ceiling of the
  // tallest possible mark, and the anchor of every label with the pixel room
  // it needs, so the scene fills the canvas from any camera angle.
  sceneBounds() {
    const { camera: C, renderer: R, theme } = this;
    const [hx, hy] = this.floorExtent();
    const floorZ = -theme.floorThickness;
    const top = this.maxHeight + 0.2;
    const corners = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
    const valueRoom = this.options.labels ? 24 : 4;
    const pts = [];
    for (const [x, y] of corners) {
      pts.push([x, y, floorZ, { b: 4 }]);
      pts.push([x, y, top, { t: valueRoom }]);
    }

    // Category labels, as drawLabels() places them (bold width, so hovering
    // doesn't nudge the fit).
    const c = C.project(0, 0, 0);
    const alignFor = (ox, oy) => {
      const o = C.project(ox, oy, 0);
      const dir = (o.x - c.x) / (Math.hypot(o.x - c.x, o.y - c.y) || 1);
      return dir < -0.3 ? 'right' : dir > 0.3 ? 'left' : 'center';
    };
    const around = (align, w) =>
      align === 'right' ? { l: w + 3, r: 3, t: 4, b: 12 } : align === 'left' ? { l: 3, r: w + 3, t: 4, b: 12 } : { l: w / 2 + 3, r: w / 2 + 3, t: 4, b: 12 };
    const ey = C.groundDepth(0, hy + 0.3) > C.groundDepth(0, -hy - 0.3) ? hy + 0.3 : -hy - 0.3;
    const ex = C.groundDepth(hx + 0.3, 0) > C.groundDepth(-hx - 0.3, 0) ? hx + 0.3 : -hx - 0.3;
    const xAlign = alignFor(0, Math.sign(ey));
    this.xs.forEach((xv, i) => {
      const label = this.tickLabel('x', xv, i);
      if (label == null) return;
      const gx = (i - (this.xs.length - 1) / 2) * this.spacing[0];
      pts.push([gx, ey, floorZ, around(xAlign, R.measure(label, 12, 600))]);
    });
    if (!(this.ys.length === 1 && this.ys[0] === '')) {
      const yAlign = alignFor(Math.sign(ex), 0);
      this.ys.forEach((yv, j) => {
        const label = this.tickLabel('y', yv, j);
        if (label == null) return;
        const gy = (j - (this.ys.length - 1) / 2) * this.spacing[1];
        pts.push([ex, gy, floorZ, around(yAlign, R.measure(label, 12, 600) + (this.colorByRow ? 12 : 0))]);
      });
    }

    // Value axis labels on the wall edge drawWalls() picks.
    if (this.axis.show && this.wallFade > 0) {
      const yFar = C.groundDepth(0, hy) < C.groundDepth(0, -hy) ? hy : -hy;
      const xFar = C.groundDepth(hx, 0) < C.groundDepth(-hx, 0) ? hx : -hx;
      const useA = C.project(-xFar, yFar, 0).x < C.project(xFar, -yFar, 0).x;
      const ax = useA ? -xFar : xFar;
      const ay = useA ? yFar : -yFar;
      for (const tick of this.ticks) {
        pts.push([ax, ay, this.z(tick), { l: 10 + R.measure(this.format(tick), 11, 400, true), t: 8, b: 8 }]);
      }
      if (this.axis.title) {
        pts.push([ax, ay, this.maxHeight, { l: 10 + R.measure(this.axis.title, 11, 600), t: 26 }]);
      }
    }

    // A reference plane's label sits left of its leftmost corner.
    const ref = this.reference;
    if (ref) {
      const w = R.measure(`${ref.label ? `${ref.label} ` : ''}${this.format(ref.value)}`, 11, 600, true);
      for (const [x, y] of corners) pts.push([x, y, this.z(ref.value), { l: 10 + w, t: 8, b: 8 }]);
    }
    return pts;
  }

  drawMarks() {}

  // ---- value axis ------------------------------------------------------------

  // options.axis: true | false | { ticks, title }. Charts set `defaultAxis`.
  get axis() {
    const a = this.options.axis ?? this.defaultAxis ?? true;
    if (a === false) return { show: false, ticks: 4 };
    return { show: true, ticks: 4, title: this.options.valueLabel, ...(typeof a === 'object' ? a : {}) };
  }

  // How visible the walls are: they fade out as the view nears top-down,
  // where height can't be read anyway.
  get wallFade() {
    return Math.max(0, Math.min(1, (1.42 - this.camera.pitch) / 0.3));
  }

  // Two walls on the floor edges farthest from the camera, with gridlines at
  // the ticks and labels on the outer edge. They follow the camera, so the
  // axis is always behind the data; in front view the back wall faces the
  // viewer and the chart reads like a plain 2D bar chart.
  drawWalls() {
    this._walls = null;
    if (!this.axis.show) return;
    const fade = this.wallFade;
    if (fade <= 0) return;
    const { camera: C, renderer: R, theme } = this;
    const ctx = R.ctx;
    const [hx, hy] = this.floorExtent();
    const yFar = C.groundDepth(0, hy) < C.groundDepth(0, -hy) ? hy : -hy;
    const xFar = C.groundDepth(hx, 0) < C.groundDepth(-hx, 0) ? hx : -hx;
    const H = this.maxHeight;
    const P = (x, y, z) => C.project(x, y, z);

    ctx.globalAlpha = fade;
    const wallFill = theme.wall ?? theme.floor;
    R.polygon([P(-xFar, yFar, 0), P(xFar, yFar, 0), P(xFar, yFar, H), P(-xFar, yFar, H)], wallFill, theme.grid, 1);
    R.polygon([P(xFar, yFar, 0), P(xFar, -yFar, 0), P(xFar, -yFar, H), P(xFar, yFar, H)], wallFill, theme.grid, 1);

    // Labels go on whichever outer wall edge sits further left on screen.
    const useA = P(-xFar, yFar, 0).x < P(xFar, -yFar, 0).x;
    const ax = useA ? -xFar : xFar;
    const ay = useA ? yFar : -yFar;
    const reserved = [];
    if (this.reference) reserved.push(P(ax, ay, this.z(this.reference.value)).y);
    const hovered = this.cellOf(this.hovered);
    if (hovered && this.focus.value > 0) reserved.push(P(ax, ay, this.z(this.levelValue(this.hovered))).y);
    for (const tick of this.ticks) {
      const z = this.z(tick);
      if (tick > this.minValue) {
        ctx.beginPath();
        const a = P(-xFar, yFar, z);
        const b = P(xFar, yFar, z);
        const c = P(xFar, -yFar, z);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(c.x, c.y);
        ctx.strokeStyle = theme.grid;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      const p = P(ax, ay, z);
      // Leave room for the reference label and the hover pill.
      if (reserved.some((y) => Math.abs(y - p.y) < 18)) continue;
      R.text(this.format(tick), p.x - 8, p.y, { color: theme.textMuted, size: 11, align: 'right', mono: true });
    }
    if (this.axis.title) {
      const p = P(ax, ay, H);
      R.text(this.axis.title, p.x - 8, p.y - 18, { color: theme.textMuted, size: 11, weight: 600, align: 'right' });
    }
    ctx.globalAlpha = 1;
    this._walls = { xFar, yFar, ax, ay, fade };
  }

  // Value at the top of what's hovered (a stack reads at its part's top).
  levelValue(datum) {
    const cell = this.cellOf(datum);
    if (datum?.cell && this.stack) {
      let sum = 0;
      for (let s = 0; s <= datum.index; s++) sum += cell.value[s];
      return sum;
    }
    return cell.total;
  }

  // 3D crosshair: dashed lines from the hovered mark's top to both walls,
  // and a value pill on the axis at exactly that height.
  drawLevel() {
    const w = this._walls;
    const cell = this.cellOf(this.hovered);
    if (!w || !cell || this.focus.value <= 0) return;
    const { camera: C, renderer: R, theme } = this;
    const ctx = R.ctx;
    const value = this.levelValue(this.hovered);
    const z = this.z(value);
    const P = (x, y) => C.project(x, y, z);
    const top = P(cell.gx, cell.gy);
    ctx.globalAlpha = this.focus.value * w.fade;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = theme.text;
    ctx.lineWidth = 1;
    for (const end of [P(cell.gx, w.yFar), P(w.xFar, cell.gy)]) {
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Value pill over the tick labels.
    const a = P(w.ax, w.ay);
    const text = this.format(value);
    const tw = R.measure(text, 11, 600, true);
    ctx.beginPath();
    ctx.roundRect(a.x - tw - 16, a.y - 10, tw + 12, 20, 6);
    ctx.fillStyle = theme.text;
    ctx.fill();
    R.text(text, a.x - 10, a.y, { color: theme.surface, size: 11, weight: 600, align: 'right', mono: true });
    ctx.globalAlpha = 1;
  }

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
        const v = Math.min(1, (cell.total - this.minValue) / (this.maxValue - this.minValue));
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
