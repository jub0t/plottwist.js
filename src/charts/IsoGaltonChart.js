// A distribution that builds itself: every record is a ball dropped through
// a board of pegs into the bins of a histogram, like a Galton board. Unlike
// a real one, each ball's path is chosen so it lands in the bin its value
// belongs to, so the pile is the true histogram, formed one ball at a time.
// Balls can be coloured by a category to show how groups make up the shape.
//
// Ball positions are a pure function of the timeline, so scrubbing and
// export are exact: play() pours, seek() rewinds.
//
//   new IsoGaltonChart(el, { data, value: 'minutes', color: 'mode', bins: 16 })

import { Chart } from '../core/chart.js';
import { Tween, ease } from '../core/animation.js';
import { parseHex, shade } from '../core/color.js';
import { accessor, drawLegend, seriesColor } from '../core/stage.js';

const PEG_GAP = 1; // horizontal distance between pegs in a row
const ROW_GAP = 0.42;
const DEPTH = 0.5; // board thickness (y)

export class IsoGaltonChart extends Chart {
  constructor(container, options = {}) {
    super(container, { camera: { yaw: 0.32, pitch: 0.34 }, loop: false, ...options });
    const o = this.options;
    this.value = accessor(o.value ?? 'value');
    this.category = o.color ? accessor(o.color) : null;
    this.format = o.format ?? ((v) => v.toLocaleString(undefined, { maximumFractionDigits: 1 }));
    this.focus = new Tween(0);
    this.sprites = new Map();
    this.setData(o.data ?? []);
    if (o.autoplay !== false && this.balls.length) this.play();
    else this.seek(this.timeline.length - 1);
  }

  // ---- data -----------------------------------------------------------------

  setData(data) {
    const o = this.options;
    const values = data.map((d) => +this.value(d)).filter(Number.isFinite);
    const records = data.filter((d) => Number.isFinite(+this.value(d)));
    this.categories = [];
    if (this.category) for (const d of records) if (!this.categories.includes(this.category(d))) this.categories.push(this.category(d));

    // Bins: `bins` equal steps over [min, max] (or the given domain).
    const B = Math.max(3, Math.min(31, o.bins ?? 15));
    let [lo, hi] = o.domain ?? [Math.min(...values), Math.max(...values)];
    if (!(hi > lo)) [lo, hi] = [lo - 1, lo + 1];
    this.domain = [lo, hi];
    this.binCount = B;
    this.rows = B - 1;
    const binOf = (v) => Math.max(0, Math.min(B - 1, Math.floor(((v - lo) / (hi - lo)) * B)));

    // One ball per record, up to maxBalls; beyond that each ball stands for
    // several records (sampled evenly).
    const maxBalls = o.maxBalls ?? 600;
    this.unit = Math.max(1, Math.ceil(records.length / maxBalls));
    const picked = records.filter((_, i) => i % this.unit === 0);
    // Shuffle (seeded) so groups mix in the pour rather than arriving in order.
    let seed = 12345;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = picked.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [picked[i], picked[j]] = [picked[j], picked[i]];
    }

    // Balls per bin: count them first, then size the balls so the tallest
    // stack stays about `stackHeight` high (4 abreast in each bin).
    this.counts = new Array(B).fill(0);
    for (const d of picked) this.counts[binOf(+this.value(d))]++;
    const tallest = Math.max(1, ...this.counts);
    this.perRow = o.perBin ?? 4;
    const fit = (o.stackHeight ?? 4.5) / (Math.ceil(tallest / this.perRow) * 0.92);
    this.ballD = o.ballSize ?? Math.max(0.08, Math.min((PEG_GAP * 0.92) / this.perRow, fit));
    if (this.ballD * this.perRow > PEG_GAP * 0.95) this.perRow = Math.max(1, Math.floor((PEG_GAP * 0.92) / this.ballD));
    const filled = new Array(B).fill(0);
    this.balls = picked.map((d, index) => {
      const v = +this.value(d);
      const bin = binOf(v);
      // Exactly `bin` right turns among the rows, in a seeded random order.
      const turns = Array.from({ length: this.rows }, (_, r) => r < bin);
      for (let i = turns.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [turns[i], turns[j]] = [turns[j], turns[i]];
      }
      const slot = filled[bin]++;
      const cat = this.category ? this.categories.indexOf(this.category(d)) : 0;
      return { d, v, bin, turns, slot, cat, index };
    });
    this.maxCount = Math.max(1, ...this.counts);
    this.mean = values.reduce((s, v) => s + v, 0) / (values.length || 1);

    // Timing: a ball is released every `interval` ms and takes `fall` ms to
    // land; the timeline counts released balls.
    this.interval = o.interval ?? Math.max(6, Math.min(50, 7000 / Math.max(1, this.balls.length)));
    this.fall = o.fall ?? 1700;
    this.timeline.frameDuration = this.interval;
    this.timeline.length = this.balls.length + Math.ceil(this.fall / this.interval) + 1;
    this.timeline.seek(Math.min(this.timeline.position, this.timeline.length - 1));

    // Board geometry (x across, z up, the board stands at y = 0).
    this.binTop = this.stackHeight(this.maxCount) + 0.6;
    this.pegTop = this.binTop + 0.9 + this.rows * ROW_GAP;
    this.hopper = this.pegTop + 1.4;
    this.halfWidth = (B * PEG_GAP) / 2;
    this.invalidate();
  }

  get frameLabel() {
    const landed = Math.max(0, Math.min(this.balls.length, Math.floor(this.timeline.position - this.fall / this.interval) + 1));
    return `${landed * this.unit} / ${this.balls.length * this.unit}`;
  }

  stackHeight(count) {
    return Math.ceil(count / this.perRow) * this.ballD * 0.92;
  }

  binX(b) {
    return (b - (this.binCount - 1) / 2) * PEG_GAP;
  }

  // Where ball i is at timeline position p: null before release.
  ballPosition(ball, p) {
    const s = ((p - ball.index) * this.interval) / this.fall; // 0..1 through the fall
    if (s < 0) return null;
    const R = this.rows;
    const rest = this.restPosition(ball);
    if (s >= 1) return rest;
    // Phases: drop to the first peg (12%), one hop per row (70%), then fall
    // into the bin (18%).
    const pegZ = (r) => this.pegTop - r * ROW_GAP;
    const pegX = (r) => {
      let rights = 0;
      for (let k = 0; k < r; k++) rights += ball.turns[k] ? 1 : 0;
      return (rights - r / 2) * PEG_GAP;
    };
    if (s < 0.12) {
      const u = s / 0.12;
      return [0, 0, this.hopper - (this.hopper - pegZ(0) - this.ballD * 0.6) * u * u];
    }
    if (s < 0.82) {
      const f = ((s - 0.12) / 0.7) * R;
      const r = Math.min(R - 1, Math.floor(f));
      const u = f - r;
      const x0 = pegX(r);
      const x1 = x0 + (ball.turns[r] ? 0.5 : -0.5) * PEG_GAP;
      const z0 = pegZ(r) + this.ballD * 0.6;
      const z1 = pegZ(r + 1) + this.ballD * 0.6;
      // A little hop off each peg.
      return [x0 + (x1 - x0) * u, 0, z0 + (z1 - z0) * u + Math.sin(Math.PI * u) * ROW_GAP * 0.45];
    }
    const u = (s - 0.82) / 0.18;
    const sx = pegX(R);
    const sz = this.pegTop - R * ROW_GAP + this.ballD * 0.6;
    return [sx + (rest[0] - sx) * ease.cubicOut(u), 0, sz + (rest[2] - sz) * u * u];
  }

  restPosition(ball) {
    const col = ball.slot % this.perRow;
    const level = Math.floor(ball.slot / this.perRow);
    // Alternate rows sit offset, like stacked marbles.
    const offset = level % 2 && this.perRow > 1 ? 0.25 * this.ballD : 0;
    return [this.binX(ball.bin) + (col - (this.perRow - 1) / 2) * this.ballD + offset, 0, this.ballD / 2 + level * this.ballD * 0.92];
  }

  // Counts landed in each bin at position p.
  landedCounts(p) {
    const counts = new Array(this.binCount).fill(0);
    const cut = p - this.fall / this.interval;
    for (const b of this.balls) if (b.index <= cut) counts[b.bin]++;
    return counts;
  }

  // ---- animation ----------------------------------------------------------------

  tick(now) {
    return this.focus.tick(now);
  }

  onHoverChange() {
    this.focus.to(this.hovered ? 1 : 0, this.now(), { duration: 200 });
  }

  ballRgb(ball) {
    if (!this.category) return parseHex(this.options.ballColor ?? seriesColor(this, null, 0));
    return parseHex(seriesColor(this, this.categories[ball.cat], ball.cat));
  }

  // A shaded sphere, rendered once per colour and size and stamped.
  sprite(rgb, px) {
    const size = Math.max(2, Math.round(px * 2) / 2);
    const key = `${rgb.map(Math.round).join(',')}|${size}`;
    let c = this.sprites.get(key);
    if (c) return c;
    const dpr = window.devicePixelRatio || 1;
    c = document.createElement('canvas');
    c.width = c.height = Math.ceil(size * dpr) + 2;
    const g = c.getContext('2d');
    const r = (size * dpr) / 2;
    const m = c.width / 2;
    const grad = g.createRadialGradient(m - r * 0.35, m - r * 0.4, r * 0.1, m, m, r);
    grad.addColorStop(0, shade(rgb, 1.55));
    grad.addColorStop(0.45, shade(rgb, 1.05));
    grad.addColorStop(1, shade(rgb, 0.55));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(m, m, r, 0, Math.PI * 2);
    g.fill();
    c.cssSize = c.width / dpr;
    if (this.sprites.size > 200) this.sprites.clear();
    this.sprites.set(key, c);
    return c;
  }

  // ---- drawing --------------------------------------------------------------------

  draw() {
    const { camera: C, renderer: R, theme } = this;
    const w = this.halfWidth + 0.3;
    const pts = [];
    for (const x of [-w, w]) {
      for (const y of [-DEPTH, DEPTH]) {
        pts.push([x, y, -theme.floorThickness, { b: 30 }]);
        pts.push([x, y, this.hopper + 0.4, { t: 8 }]);
      }
    }
    this.fitScene(pts, { top: this.category ? 40 : 16, right: 16, bottom: 16, left: 16 });

    this.drawBoard();
    const p = this.timeline.position;
    this.drawBins(p);
    this.drawPegs();
    this.drawBalls(p);
    this.drawOverlays(p);
    if (this.category && this.categories.length > 1) {
      drawLegend(this, this.categories.map((c, i) => ({ label: c, color: seriesColor(this, c, i) })));
    }
    if (this.hovered && (this.timeline.playing || this.focus.value < 1)) this._updateTooltip();
  }

  // The back panel, a base, and the hopper.
  drawBoard() {
    const { camera: C, renderer: R, theme } = this;
    const P = (x, y, z) => C.project(x, y, z);
    const w = this.halfWidth + 0.3;
    const floor = parseHex(theme.floor);
    // Base slab under the bins.
    const t = theme.floorThickness;
    const base = { x0: -w, x1: w, y0: -DEPTH, y1: DEPTH, z0: -t, z1: 0 };
    const faces = [
      [[0, -1, 0], [P(base.x0, base.y0, base.z0), P(base.x1, base.y0, base.z0), P(base.x1, base.y0, 0), P(base.x0, base.y0, 0)]],
      [[1, 0, 0], [P(base.x1, base.y0, base.z0), P(base.x1, base.y1, base.z0), P(base.x1, base.y1, 0), P(base.x1, base.y0, 0)]],
      [[-1, 0, 0], [P(base.x0, base.y1, base.z0), P(base.x0, base.y0, base.z0), P(base.x0, base.y0, 0), P(base.x0, base.y1, 0)]],
    ];
    for (const [n, pts] of faces) if (C.faces(...n)) R.polygon(pts, shade(floor, 0.85), theme.grid, 1);
    R.polygon([P(-w, -DEPTH, 0), P(w, -DEPTH, 0), P(w, DEPTH, 0), P(-w, DEPTH, 0)], theme.floor, theme.grid, 1);
    // Back panel: a tall board the pegs stand out of.
    const top = this.hopper + 0.4;
    R.polygon([P(-w, DEPTH, 0), P(w, DEPTH, 0), P(w, DEPTH, top), P(-w, DEPTH, top)], theme.wall ?? theme.floor, theme.grid, 1);
    // Funnel at the top.
    const fz = this.pegTop + 0.5;
    const ctx = R.ctx;
    ctx.beginPath();
    for (const side of [-1, 1]) {
      const a = P(side * 1.6, 0, this.hopper + 0.4);
      const b = P(side * 0.32, 0, fz);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.strokeStyle = theme.textMuted;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Slats between bins, and the bins as hit regions.
  drawBins(p) {
    const { camera: C, renderer: R, theme } = this;
    const P = (x, y, z) => C.project(x, y, z);
    const ctx = R.ctx;
    const hovered = this.hovered?.kind === 'bin' ? this.hovered.bin : -1;
    for (let b = 0; b < this.binCount; b++) {
      const x0 = this.binX(b) - PEG_GAP / 2;
      const x1 = x0 + PEG_GAP;
      const poly = [P(x0, 0, 0), P(x1, 0, 0), P(x1, 0, this.binTop), P(x0, 0, this.binTop)];
      if (b === hovered) {
        ctx.globalAlpha = this.focus.value;
        R.polygon([P(x0, DEPTH, 0), P(x1, DEPTH, 0), P(x1, DEPTH, this.binTop), P(x0, DEPTH, this.binTop)], theme.highlight);
        ctx.globalAlpha = 1;
      }
      R.hit([poly], { kind: 'bin', bin: b });
    }
    ctx.beginPath();
    for (let b = 0; b <= this.binCount; b++) {
      const x = this.binX(b) - PEG_GAP / 2;
      for (const y of [DEPTH, -DEPTH * 0.6]) {
        const a = P(x, y, 0);
        const c = P(x, y, this.binTop);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(c.x, c.y);
      }
    }
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Pegs: short posts out of the back panel, in a triangle.
  drawPegs() {
    const { camera: C, renderer: R, theme } = this;
    const ctx = R.ctx;
    const px = Math.max(1.5, 0.09 * C.scale * C.zoom);
    const rgb = parseHex(theme.textMuted.startsWith('#') ? theme.textMuted : '#9897b8');
    for (let r = 0; r < this.rows; r++) {
      for (let k = 0; k <= r; k++) {
        const x = (k - r / 2) * PEG_GAP;
        const z = this.pegTop - r * ROW_GAP;
        const back = C.project(x, DEPTH, z);
        const front = C.project(x, -DEPTH * 0.4, z);
        ctx.strokeStyle = shade(rgb, 0.7);
        ctx.lineWidth = px * 1.6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(back.x, back.y);
        ctx.lineTo(front.x, front.y);
        ctx.stroke();
        ctx.fillStyle = shade(rgb, 1.1);
        ctx.beginPath();
        ctx.arc(front.x, front.y, px, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawBalls(p) {
    const { camera: C, renderer: R } = this;
    const ctx = R.ctx;
    const px = this.ballD * C.scale * C.zoom;
    const hovered = this.hovered;
    for (const ball of this.balls) {
      const pos = this.ballPosition(ball, p);
      if (!pos) break; // released in order
      let rgb = this.ballRgb(ball);
      if (hovered && this.focus.value > 0) {
        const on = hovered.kind === 'bin' ? ball.bin === hovered.bin : hovered.kind === 'category' ? ball.cat === hovered.index : true;
        if (!on) rgb = rgb.map((c, i) => c + (parseHex(this.theme.floor)[i] - c) * 0.6 * this.focus.value);
      }
      const img = this.sprite(rgb, px);
      const s = C.project(...pos);
      ctx.drawImage(img, s.x - img.cssSize / 2, s.y - img.cssSize / 2, img.cssSize, img.cssSize);
    }
  }

  // Bin value ticks, a density curve over the landed balls, and the mean.
  drawOverlays(p) {
    const { camera: C, renderer: R, theme } = this;
    const ctx = R.ctx;
    const P = (x, z) => C.project(x, -DEPTH * 0.6, z);
    const [lo, hi] = this.domain;
    const span = hi - lo;
    const xOf = (v) => -this.halfWidth + ((v - lo) / span) * this.binCount * PEG_GAP;

    // Axis ticks along the base front edge.
    const ticks = niceTicksIn(lo, hi, 6);
    for (const v of ticks) {
      const a = C.project(xOf(v), -DEPTH, -theme.floorThickness);
      R.line(a, { x: a.x, y: a.y + 5 }, theme.textMuted, 1);
      R.text(this.format(v), a.x, a.y + 16, { color: theme.textMuted, size: 11, mono: true });
    }

    const counts = this.landedCounts(p);
    const total = counts.reduce((a, b) => a + b, 0);
    if (total < 8) return;
    // Smoothed outline over the stacks (a light kernel over the bin counts).
    if (this.options.curve !== false) {
      const smooth = counts.map((_, b) => {
        let s = 0;
        let w = 0;
        for (let k = -2; k <= 2; k++) {
          const c = counts[b + k];
          if (c == null) continue;
          const kw = Math.exp(-(k * k) / 2.2);
          s += c * kw;
          w += kw;
        }
        return s / w;
      });
      ctx.beginPath();
      const steps = this.binCount * 6;
      for (let i = 0; i <= steps; i++) {
        const f = (i / steps) * (this.binCount - 1);
        const b = Math.floor(f);
        const t = f - b;
        const c = (smooth[b] ?? 0) * (1 - t) + (smooth[b + 1] ?? smooth[b]) * t;
        const s = P(this.binX(0) + f * PEG_GAP, (c / this.perRow) * this.ballD * 0.92 + this.ballD * 0.5);
        i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y);
      }
      ctx.strokeStyle = theme.text;
      ctx.globalAlpha = 0.7 * Math.min(1, total / 40);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Mean of the landed balls.
    let sum = 0;
    for (const b of this.balls) if (b.index <= p - this.fall / this.interval) sum += b.v;
    const mean = sum / total;
    const x = xOf(mean);
    const a = P(x, 0);
    const b = P(x, this.binTop);
    ctx.setLineDash([4, 4]);
    R.line(a, b, theme.text, 1);
    ctx.setLineDash([]);
    R.text(`mean ${this.format(mean)}`, b.x, b.y - 10, { color: theme.text, size: 11, weight: 600, mono: true, halo: theme.surface });
  }

  describe(item) {
    if (item.kind !== 'bin') return null;
    const [lo, hi] = this.domain;
    const step = (hi - lo) / this.binCount;
    const a = lo + item.bin * step;
    const counts = this.landedCounts(this.timeline.position);
    const total = counts.reduce((s, c) => s + c, 0);
    const n = counts[item.bin] * this.unit;
    const rows = [
      { label: this.options.countLabel ?? 'Count', value: n.toLocaleString() },
      { label: 'Share', value: total ? `${((counts[item.bin] / total) * 100).toFixed(1)}%` : '–' },
    ];
    if (this.category) {
      const byCat = this.categories.map(() => 0);
      const cut = this.timeline.position - this.fall / this.interval;
      for (const b of this.balls) if (b.bin === item.bin && b.index <= cut) byCat[b.cat]++;
      this.categories.forEach((c, i) => rows.push({ label: String(c), value: (byCat[i] * this.unit).toLocaleString(), color: seriesColor(this, c, i) }));
    }
    return { title: `${this.format(a)} – ${this.format(a + step)}`, rows };
  }
}

// Round ticks within [lo, hi].
function niceTicksIn(lo, hi, count) {
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

