// A time series coiled into a rising helix: one turn per cycle (a year by
// default), so the same point in every cycle lines up vertically and
// seasonality reads at a glance, while growth shows as the coil widening
// upward. Each point is a wedge pushed outward by its value.
//
// play() draws the series through time with a glowing head; hovering a wedge
// compares it with the same point one cycle earlier (directly below it).
//
//   new IsoHelixChart(el, { data, date: 'week', value: 'rides' })

import { Chart } from '../core/chart.js';
import { Tween, ease } from '../core/animation.js';
import { parseHex, rampAt, rgbString, sequentialStops, shade } from '../core/color.js';
import { faceBrightness } from '../core/shapes.js';
import { accessor } from '../core/stage.js';

const TAU = Math.PI * 2;
const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Cycles: where a timestamp falls (turn index and fraction of the turn), and
// the labels around the ring.
const CYCLES = {
  year: {
    split(t) {
      const d = new Date(t);
      const y = d.getUTCFullYear();
      const start = Date.UTC(y, 0, 1);
      return [y, (t - start) / (Date.UTC(y + 1, 0, 1) - start)];
    },
    ticks: MONTHS.map((m, i) => [m, (Date.UTC(2001, i, 1) - Date.UTC(2001, 0, 1)) / (365 * DAY)]),
    turnLabel: (k) => String(k),
    pointLabel: (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
  },
  week: {
    split(t) {
      const days = Math.floor(t / DAY) + 3; // 1970-01-01 was a Thursday; Monday starts the week
      const week = Math.floor(days / 7);
      return [week, (((days % 7) + 7) % 7) / 7 + (t - Math.floor(t / DAY) * DAY) / (7 * DAY)];
    },
    ticks: WEEKDAYS.map((d, i) => [d, i / 7]),
    turnLabel: (k) => new Date((k * 7 - 3) * DAY).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    pointLabel: (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', timeZone: 'UTC' }),
  },
  day: {
    split(t) {
      const day = Math.floor(t / DAY);
      return [day, (t - day * DAY) / DAY];
    },
    ticks: [0, 3, 6, 9, 12, 15, 18, 21].map((h) => [`${String(h).padStart(2, '0')}:00`, h / 24]),
    turnLabel: (k) => new Date(k * DAY).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    pointLabel: (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }),
  },
};

export class IsoHelixChart extends Chart {
  constructor(container, options = {}) {
    super(container, { camera: { pitch: 0.42 }, frameDuration: 70, loop: false, ...options });
    const o = this.options;
    this.date = accessor(o.date ?? 'date');
    this.value = accessor(o.value ?? 'value');
    this.format = o.format ?? ((v) => v.toLocaleString(undefined, { maximumFractionDigits: 1 }));
    this.radius = o.radius ?? 1.8; // inner radius of the coil
    this.reach = o.reach ?? 3.2; // how far the largest value pushes out
    this.focus = new Tween(0);
    this.grow = new Tween(0);
    this.setData(o.data ?? []);
    this.grow.to(1, this.now(), { duration: 1100, easing: ease.cubicOut });
    if (o.autoplay) this.play();
  }

  get cycle() {
    return CYCLES[this.options.cycle ?? 'year'] ?? CYCLES.year;
  }

  setData(data) {
    const cycle = this.cycle;
    const points = data
      .map((d) => {
        const raw = this.date(d);
        const t = raw instanceof Date ? raw.getTime() : typeof raw === 'number' ? raw : Date.parse(raw);
        return { d, t, value: Math.max(0, +this.value(d) || 0) };
      })
      .filter((p) => Number.isFinite(p.t))
      .sort((a, b) => a.t - b.t);
    if (!points.length) {
      this.points = [];
      this.turns = 1;
      this.maxValue = 1;
      this.timeline.length = 1;
      return this.invalidate();
    }
    const first = cycle.split(points[0].t)[0];
    let max = 0;
    for (const p of points) {
      const [k, f] = cycle.split(p.t);
      p.turn = k - first;
      p.cycleKey = k;
      p.frac = f;
      max = Math.max(max, p.value);
    }
    // Angular width: the typical gap between neighbours, so wedges tile.
    const gaps = points.slice(1).map((p, i) => p.turn + p.frac - (points[i].turn + points[i].frac)).filter((g) => g > 0);
    gaps.sort((a, b) => a - b);
    this.step = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1 / 52;
    points.forEach((p, i) => (p.index = i));
    this.points = points;
    this.firstKey = first;
    this.turns = points[points.length - 1].turn + 1;
    this.maxValue = this.options.max ?? (max || 1);
    this.turnHeight = this.options.turnHeight ?? Math.max(1, Math.min(2, 8 / this.turns));
    this.timeline.length = points.length;
    this.timeline.seek(points.length - 1);
    this.invalidate();
  }

  get frameLabel() {
    const p = this.points[Math.round(this.timeline.position)];
    return p ? this.cycle.turnLabel(p.cycleKey) : null;
  }

  // Same point one cycle earlier: the wedge directly below.
  previousCycle(p) {
    let best = null;
    for (const q of this.points) {
      if (q.turn !== p.turn - 1) continue;
      if (!best || Math.abs(q.frac - p.frac) < Math.abs(best.frac - p.frac)) best = q;
    }
    return best && Math.abs(best.frac - p.frac) <= this.step * 0.75 ? best : null;
  }

  // ---- animation --------------------------------------------------------------

  tick(now) {
    let active = this.grow.tick(now);
    active = this.focus.tick(now) || active;
    if (this.options.autoRotate && !this._dragging) active = true;
    return active;
  }

  play() {
    // Replaying from the end starts over.
    if (this.timeline.position >= this.timeline.length - 1) this.timeline.seek(0);
    super.play();
  }

  onHoverChange() {
    this.focus.to(this.hovered ? 1 : 0, this.now(), { duration: 200 });
  }

  // ---- geometry ---------------------------------------------------------------

  // Angle of a cycle fraction: the cycle starts at the back and runs
  // clockwise seen from above, so the year reads like a clock face.
  angle(frac) {
    return -frac * TAU + Math.PI / 2;
  }

  baseZ(p) {
    return (p.turn + p.frac) * this.turnHeight;
  }

  get stops() {
    return sequentialStops(this.theme, this.options.colorScale ?? this.theme.scale);
  }

  colorFor(v) {
    return rampAt(this.stops, v / this.maxValue);
  }

  // ---- drawing ----------------------------------------------------------------

  draw() {
    const { camera: C, renderer: R, theme } = this;
    const outer = this.radius + this.reach + 0.5;
    const top = this.turns * this.turnHeight + 0.4;
    const pts = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TAU;
      pts.push([Math.cos(a) * (outer + 0.5), Math.sin(a) * (outer + 0.5), 0, { l: 24, r: 24, b: 14, t: 6 }]);
      pts.push([Math.cos(a) * outer, Math.sin(a) * outer, top, { t: 10 }]);
    }
    this.fitScene(pts, { top: 14, right: 14, bottom: 14, left: 14 });

    this.drawBase(outer);
    this.drawGuides(outer, top);
    this.drawCoil();
    this.drawTurnLabels();
    this.drawLegend();
    if (this.hovered && (this.timeline.playing || this.focus.value < 1)) this._updateTooltip();
  }

  // A round floor with the cycle's ticks around the rim.
  drawBase(outer) {
    const { camera: C, renderer: R, theme } = this;
    const P = (x, y, z = 0) => C.project(x, y, z);
    const n = 72;
    const ring = Array.from({ length: n }, (_, k) => [Math.cos((k / n) * TAU) * outer, Math.sin((k / n) * TAU) * outer]);
    const t = -theme.floorThickness;
    // Rim: the near half of the disc's edge.
    for (let k = 0; k < n; k++) {
      const [ax, ay] = ring[k];
      const [bx, by] = ring[(k + 1) % n];
      const mid = [(ax + bx) / 2, (ay + by) / 2];
      if (!C.faces(mid[0], mid[1], 0)) continue;
      R.polygon([P(ax, ay, t), P(bx, by, t), P(bx, by), P(ax, ay)], shade(parseHex(theme.floor), 0.85), theme.grid, 0.5);
    }
    R.polygon(ring.map(([x, y]) => P(x, y)), theme.floor, theme.grid, 1);
    // Inner circle and spokes at the ticks.
    const ctx = R.ctx;
    ctx.beginPath();
    for (const [, f] of this.cycle.ticks) {
      const a = this.angle(f);
      const p0 = P(Math.cos(a) * this.radius * 0.6, Math.sin(a) * this.radius * 0.6);
      const p1 = P(Math.cos(a) * outer, Math.sin(a) * outer);
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
    }
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.stroke();
    // Tick labels just outside the rim.
    for (const [label, f] of this.cycle.ticks) {
      const a = this.angle(f + 1 / (2 * this.cycle.ticks.length));
      const p = P(Math.cos(a) * (outer + 0.45), Math.sin(a) * (outer + 0.45), t);
      R.text(label, p.x, p.y, { color: theme.textMuted, size: 11 });
    }
  }

  // Faint vertical guides at the ticks: the same point in every cycle.
  drawGuides(outer, top) {
    const { camera: C, renderer: R, theme } = this;
    const ctx = R.ctx;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    for (const [, f] of this.cycle.ticks) {
      const a = this.angle(f);
      const x = Math.cos(a) * (this.radius - 0.15);
      const y = Math.sin(a) * (this.radius - 0.15);
      const p0 = C.project(x, y, 0);
      const p1 = C.project(x, y, top);
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
    }
    ctx.strokeStyle = theme.grid;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  drawCoil() {
    const { camera: C, renderer: R, theme } = this;
    const head = this.timeline.position;
    const grow = this.grow.value;
    const hovered = this.hovered;
    const below = hovered ? this.previousCycle(hovered) : null;
    const half = (this.step * TAU) / 2;
    const thick = Math.min(0.45, this.turnHeight * 0.32);
    const items = [];
    for (const p of this.points) {
      if (p.index > head + 1e-6) break;
      const a = this.angle(p.frac);
      const r1 = this.radius + Math.max(0.06, (p.value / this.maxValue) * this.reach * grow);
      const z1 = this.baseZ(p) + thick;
      const mx = Math.cos(a) * (this.radius + r1) * 0.5;
      const my = Math.sin(a) * (this.radius + r1) * 0.5;
      items.push({ p, a, r1, z1, depth: C.groundDepth(mx, my) * C._cp + (z1 - thick / 2) * C._sp });
    }
    items.sort((u, v) => u.depth - v.depth);
    const headIndex = Math.floor(head);
    const floor = parseHex(theme.floor);
    // The coil is one continuous ribbon: each wedge's ends sit at the height
    // of its neighbours', so there are no steps to catch the light.
    const rise = this.step * this.turnHeight;
    const reachOf = (q) => (q && q.index <= head + 1e-6 ? this.radius + Math.max(0.06, (q.value / this.maxValue) * this.reach * grow) : null);
    for (const { p, a, r1 } of items) {
      const active = p === hovered || p === below;
      const isHead = this.timeline.playing && p.index === headIndex;
      const glow = isHead ? 1.35 : active ? 1.2 : 1;
      let rgb = this.colorFor(p.value);
      // Dim by darkening, not transparency: the coil overlaps itself.
      if (hovered && !active) rgb = mix(rgb, floor, 0.6 * this.focus.value);
      const zc = this.baseZ(p);
      const wedge = {
        // a0 is later in the cycle (higher), a1 earlier (lower).
        a0: a - half,
        a1: a + half,
        z0: zc + rise / 2,
        z1: zc - rise / 2,
        r0: this.radius,
        r1,
        // Ends show only where this wedge reaches past its neighbour.
        n0: reachOf(this.points[p.index + 1]),
        n1: reachOf(this.points[p.index - 1]),
      };
      const { hits, top } = this.drawWedge(wedge, thick, rgb, glow);
      if (active && this.focus.value > 0) {
        R.ctx.globalAlpha = this.focus.value;
        R.polygon(top, null, theme.text, 1.5);
        R.ctx.globalAlpha = 1;
      }
      if (isHead && theme.glow > 0) {
        const c = C.project(Math.cos(a) * r1, Math.sin(a) * r1, zc + thick);
        R.glow(rgb, c.x, c.y, 60, 40, theme.glow);
      }
      R.hit(hits, p);
    }
    R.ctx.globalAlpha = 1;

    // A dashed riser from last cycle's wedge up to the hovered one.
    if (hovered && below && this.focus.value > 0) {
      const tip = (p) => {
        const a = this.angle(p.frac);
        const r = this.radius + Math.max(0.06, (p.value / this.maxValue) * this.reach * grow);
        return [Math.cos(a) * r, Math.sin(a) * r, this.baseZ(p) + thick];
      };
      const a = C.project(...tip(below));
      const b = C.project(...tip(hovered));
      const ctx = R.ctx;
      ctx.globalAlpha = this.focus.value;
      ctx.setLineDash([4, 4]);
      R.line(a, b, theme.text, 1.25);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  // One wedge of the ribbon: a sloped annular sector `thick` deep. Sides are
  // lit like any face; exposed ends take the outer face's shade, so turning
  // the camera never flips them dark.
  drawWedge({ a0, a1, z0, z1, r0, r1, n0, n1 }, thick, rgb, glow) {
    const { camera: C, renderer: R, theme } = this;
    const P = (r, a, z) => C.project(Math.cos(a) * r, Math.sin(a) * r, z);
    const hits = [];
    const face = (pts, k) => {
      const fill = shade(rgb, k);
      R.polygon(pts, fill, fill, 0.6);
      hits.push(pts);
    };
    const am = (a0 + a1) / 2;
    const outerK = faceBrightness(C, theme, [Math.cos(am), Math.sin(am), 0], glow);
    // Exposed end at a0: from the neighbour's reach (or the inner edge) out.
    const end = (a, z, from, normal) => {
      if (from != null && from >= r1 - 1e-6) return;
      const lo = from == null ? r0 : Math.max(r0, from);
      if (!C.faces(...normal)) return;
      face([P(lo, a, z), P(r1, a, z), P(r1, a, z + thick), P(lo, a, z + thick)], outerK * 0.94);
    };
    end(a0, z0, n0, [Math.sin(a0), -Math.cos(a0), 0]);
    end(a1, z1, n1, [-Math.sin(a1), Math.cos(a1), 0]);
    const inner = [-Math.cos(am), -Math.sin(am), 0];
    if (C.faces(...inner)) face([P(r0, a0, z0), P(r0, a1, z1), P(r0, a1, z1 + thick), P(r0, a0, z0 + thick)], faceBrightness(C, theme, inner, glow));
    if (C.faces(Math.cos(am), Math.sin(am), 0)) face([P(r1, a0, z0), P(r1, a1, z1), P(r1, a1, z1 + thick), P(r1, a0, z0 + thick)], outerK);
    const top = [P(r0, a0, z0 + thick), P(r1, a0, z0 + thick), P(r1, a1, z1 + thick), P(r0, a1, z1 + thick)];
    face(top, faceBrightness(C, theme, [0, 0, 1], glow) * (1 + 0.1 * theme.gradient));
    return { hits, top };
  }

  // Each cycle's label where it begins, on the inside of the coil.
  drawTurnLabels() {
    const { camera: C, renderer: R, theme } = this;
    const a = this.angle(0);
    const r = this.radius - 0.35;
    const seen = new Set();
    const head = this.timeline.position;
    for (const p of this.points) {
      if (seen.has(p.turn) || p.index > head) continue;
      seen.add(p.turn);
      const s = C.project(Math.cos(a) * r, Math.sin(a) * r, p.turn * this.turnHeight + this.turnHeight * 0.3);
      R.text(this.cycle.turnLabel(p.cycleKey), s.x - 6, s.y, { color: theme.textMuted, size: 11, mono: true, align: 'right', halo: theme.surface });
    }
  }

  // Value ramp, top-right.
  drawLegend() {
    const { renderer: R, theme } = this;
    const ctx = R.ctx;
    const width = 120;
    const x = R.width - 20 - width;
    const y = 22;
    const grad = ctx.createLinearGradient(x, 0, x + width, 0);
    this.stops.forEach((c, i) => grad.addColorStop(i / (this.stops.length - 1), c));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, y, width, 8, 4);
    ctx.fill();
    const label = { color: theme.textMuted, size: 11, mono: true };
    R.text(this.format(0), x, y + 20, { ...label, align: 'left' });
    R.text(this.format(this.maxValue), x + width, y + 20, { ...label, align: 'right' });
  }

  describe(p) {
    const rows = [{ label: this.options.valueLabel ?? 'Value', value: this.format(p.value), color: rgbString(this.colorFor(p.value)) }];
    const prev = this.previousCycle(p);
    if (prev) {
      const change = prev.value ? ((p.value - prev.value) / prev.value) * 100 : null;
      rows.push({ label: `${this.cycle.turnLabel(prev.cycleKey)}`, value: this.format(prev.value), color: rgbString(this.colorFor(prev.value)) });
      if (change != null) rows.push({ label: 'Change', value: `${change >= 0 ? '+' : ''}${change.toFixed(1)}%` });
    }
    return { title: this.cycle.pointLabel(p.t), rows };
  }
}

const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);
