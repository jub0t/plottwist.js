// Two quantities on a balance scale. Each side's items are blocks stacked on
// its pan (the same item keeps the same colour on both sides), and the beam
// tilts toward the heavier side by how much heavier it is. When the data
// changes the beam rocks and settles, like a real scale.
//
//   new IsoBalanceChart(el, { data, side: 'kind', key: 'category', value: 'amount' })

import { Chart } from '../core/chart.js';
import { Tween, ease } from '../core/animation.js';
import { parseHex, rgbString, shade } from '../core/color.js';
import { drawBox, faceBrightness } from '../core/shapes.js';
import { accessor, drawSlab, framesOf, seriesColor } from '../core/stage.js';

const ARM = 3.4; // pivot to pan hook
const PAN = 1.7; // pan footprint
const BLOCK = 1.15; // block footprint
const STACK = 3.2; // height of the heaviest side's stack

export class IsoBalanceChart extends Chart {
  constructor(container, options = {}) {
    super(container, { camera: { yaw: 0.22, pitch: 0.26 }, frameDuration: 1800, ...options });
    const o = this.options;
    this.side = accessor(o.side ?? 'side');
    this.key = accessor(o.key ?? 'name');
    this.value = accessor(o.value ?? 'value');
    this.format = o.format ?? ((v) => v.toLocaleString(undefined, { maximumFractionDigits: 1 }));
    this.maxTilt = o.maxTilt ?? 0.28;
    this.focus = new Tween(0);
    this.tilt = 0;
    this.spin = 0; // angular velocity
    this._last = null;
    this.setFrames(framesOf(o));
    if (o.autoplay && this.frames.length > 1) this.play();
  }

  // ---- data -----------------------------------------------------------------

  setData(data) {
    this.setFrames([{ label: null, data }]);
  }

  setFrames(frames) {
    const sides = [];
    const items = [];
    this.frames = frames.map((f) => {
      const values = new Map();
      for (const d of f.data) {
        const s = this.side(d);
        const k = this.key(d);
        if (!sides.includes(s)) sides.push(s);
        if (!items.includes(k)) items.push(k);
        const key = `${s}\u0000${k}`;
        values.set(key, (values.get(key) ?? 0) + Math.max(0, +this.value(d) || 0));
      }
      return { label: f.label, values };
    });
    if (sides.length > 2) console.warn(`plottwist: a balance has two sides; ignoring ${sides.slice(2).join(', ')}`);
    this.sides = sides.slice(0, 2);
    while (this.sides.length < 2) this.sides.push(this.sides.length ? '' : 'A');
    this.items = items;
    // Hover data, kept stable across redraws.
    this._data = new Map();
    let max = 0;
    for (const f of this.frames) {
      for (const s of this.sides) {
        let total = 0;
        for (const k of items) total += f.values.get(`${s}\u0000${k}`) ?? 0;
        max = Math.max(max, total);
      }
    }
    this.maxTotal = this.options.max ?? (max || 1);
    // Pan geometry: the cords run from the pan corners up past the tallest
    // stack to a yoke, which hangs from the beam end.
    this.hang = STACK + 0.9;
    this.pivotZ = this.hang + Math.sin(this.maxTilt) * ARM + 0.7;
    this.timeline.length = this.frames.length;
    this.timeline.seek(Math.min(this.timeline.position, this.frames.length - 1));
    this.invalidate();
  }

  get frameLabel() {
    return this.frames[Math.round(this.timeline.position)]?.label ?? null;
  }

  valueAt(side, key, position = this.timeline.position) {
    const k = `${side}\u0000${key}`;
    const i = Math.floor(position);
    const t = position - i;
    const a = this.frames[i]?.values.get(k) ?? 0;
    if (t === 0 || i + 1 >= this.frames.length) return a;
    const b = this.frames[i + 1].values.get(k) ?? 0;
    return a + (b - a) * ease.cubicInOut(t);
  }

  total(side) {
    return this.items.reduce((s, k) => s + this.valueAt(side, k), 0);
  }

  // Beam angle for the current totals: positive tips the right side down.
  // It follows the relative difference, so a 10% gap always looks the same.
  targetTilt() {
    const l = this.total(this.sides[0]);
    const r = this.total(this.sides[1]);
    const rel = (r - l) / Math.max(l, r, 1e-9);
    return this.maxTilt * Math.tanh(rel * (this.options.sensitivity ?? 5));
  }

  // ---- physics ----------------------------------------------------------------

  // An underdamped spring: the beam swings past and rocks to rest.
  tick(now) {
    const dt = this._last == null ? 1 / 60 : Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    const goal = this.targetTilt();
    for (let k = 0; k < 4; k++) {
      const h = dt / 4;
      this.spin += (22 * (goal - this.tilt) - 3.4 * this.spin) * h;
      this.tilt += this.spin * h;
    }
    const moving = Math.abs(goal - this.tilt) > 1e-4 || Math.abs(this.spin) > 1e-4;
    return this.focus.tick(now) || moving;
  }

  onHoverChange() {
    this.focus.to(this.hovered ? 1 : 0, this.now(), { duration: 200 });
  }

  datum(kind, side, key) {
    const k = `${kind}\u0000${side}\u0000${key}`;
    let d = this._data.get(k);
    if (!d) this._data.set(k, (d = { kind, side, key, index: this.sides.indexOf(side) }));
    return d;
  }

  itemRgb(key) {
    const i = this.items.indexOf(key);
    return parseHex(seriesColor(this, key, i));
  }

  // World position of a beam end (side 0 left, 1 right).
  hook(sideIndex) {
    const dir = sideIndex ? 1 : -1;
    const c = Math.cos(this.tilt);
    const s = Math.sin(this.tilt);
    return [dir * ARM * c, 0, this.pivotZ - dir * ARM * s];
  }

  // ---- drawing --------------------------------------------------------------------

  draw() {
    const { camera: C } = this;
    const reach = ARM + PAN / 2 + 0.3;
    const pts = [];
    for (const x of [-reach, reach]) {
      for (const y of [-PAN / 2 - 0.2, PAN / 2 + 0.2]) {
        pts.push([x, y, this.pivotZ - this.hang - Math.sin(this.maxTilt) * ARM - 0.3, { b: 46, l: 10, r: 10 }]);
        pts.push([x, y, this.pivotZ + Math.sin(this.maxTilt) * ARM + 0.3, { t: 30 }]);
      }
    }
    this.fitScene(pts, { top: 16, right: 16, bottom: 12, left: 16 });

    drawSlab(this, -1.4, 1.4, -0.8, 0.8);
    this.drawPost();
    // Pans far to near around the beam, which hangs above both.
    const order = [0, 1].sort((a, b) => C.groundDepth(this.hook(a)[0], 0) - C.groundDepth(this.hook(b)[0], 0));
    this.drawPan(order[0]);
    this.drawBeam();
    this.drawPan(order[1]);
    this.drawLabels();
    if (this.hovered && (this.timeline.playing || this.focus.value < 1)) this._updateTooltip();
  }

  drawPost() {
    const { camera: C, renderer: R, theme } = this;
    const metal = shade(parseHex(theme.grid), 1.6);
    const rgb = metal.match(/\d+/g).slice(0, 3).map(Number);
    drawBox(C, R, theme, { x0: -0.16, x1: 0.16, y0: -0.16, y1: 0.16, z0: 0, z1: this.pivotZ }, rgb);
    drawBox(C, R, theme, { x0: -0.55, x1: 0.55, y0: -0.4, y1: 0.4, z0: 0, z1: 0.18 }, rgb);
  }

  // The beam: a slim box rotated about the pivot.
  drawBeam() {
    const { camera: C, renderer: R, theme } = this;
    const c = Math.cos(this.tilt);
    const s = Math.sin(this.tilt);
    const H = this.pivotZ;
    const half = [ARM + 0.15, 0.14, 0.09];
    const W = (lx, ly, lz) => [lx * c + lz * s, ly, H - lx * s + lz * c];
    const metal = shade(parseHex(theme.grid), 1.9).match(/\d+/g).slice(0, 3).map(Number);
    const faces = [
      [[c * 0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
      [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
      [[0, 1, 0], [[1, 1, -1], [-1, 1, -1], [-1, 1, 1], [1, 1, 1]]],
      [[0, 0, -1], [[-1, 1, -1], [1, 1, -1], [1, -1, -1], [-1, -1, -1]]],
      [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
      [[-1, 0, 0], [[-1, 1, -1], [-1, -1, -1], [-1, -1, 1], [-1, 1, 1]]],
    ];
    for (const [n, corners] of faces) {
      // Rotate the local normal with the beam.
      const wn = [n[0] * c + n[2] * s, n[1], -n[0] * s + n[2] * c];
      if (!C.faces(...wn)) continue;
      const pts = corners.map(([a, b, d]) => C.project(...W(a * half[0], b * half[1], d * half[2])));
      const fill = shade(metal, faceBrightness(C, theme, wn));
      R.polygon(pts, fill, fill, 0.6);
    }
    // Pivot cap and a pointer showing the tilt against a small dial.
    const p = C.project(0, -0.2, H);
    R.ctx.beginPath();
    R.ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    R.ctx.fillStyle = theme.text;
    R.ctx.fill();
  }

  drawPan(sideIndex) {
    const { camera: C, renderer: R, theme } = this;
    const ctx = R.ctx;
    const side = this.sides[sideIndex];
    const [hx, , hz] = this.hook(sideIndex);
    const panZ = hz - this.hang;
    const half = PAN / 2;
    const hovered = this.hovered;
    const sideActive = hovered && (hovered.side === side);
    const dim = (k) => (hovered && !sideActive && hovered.key !== k ? 1 - 0.55 * this.focus.value : 1);
    void sideIndex;
    const cordColor = theme.mode === 'dark' ? 'rgba(220,220,255,0.55)' : 'rgba(60,50,120,0.5)';
    const yokeZ = panZ + STACK + 0.45;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => [hx + sx * (half - 0.08), sy * (half - 0.08)]);
    const far = (x, y) => C.groundDepth(x - hx, y) < 0;
    const cord = ([x, y]) => R.line(C.project(x, y, panZ + 0.1), C.project(x, y, yokeZ), cordColor, 1.25);

    // Far cords, the pan, the stack, near cords, then the yoke and its hanger.
    for (const c of corners) if (far(...c)) cord(c);
    const panRgb = shade(parseHex(theme.grid), 1.5).match(/\d+/g).slice(0, 3).map(Number);
    const panHits = drawBox(C, R, theme, { x0: hx - half, x1: hx + half, y0: -half, y1: half, z0: panZ, z1: panZ + 0.12 }, panRgb);
    R.hit(panHits, this.datum('side', side, null));

    let z = panZ + 0.12;
    const b = BLOCK / 2;
    const gap = 2 / (C.scale * C.zoom);
    for (const key of this.items) {
      const v = this.valueAt(side, key);
      if (v <= 0) continue;
      const h = (v / this.maxTotal) * STACK;
      ctx.globalAlpha = dim(key);
      const glow = hovered && hovered.key === key && hovered.side === side ? 1 + 0.15 * this.focus.value : 1;
      const hits = drawBox(C, R, theme, { x0: hx - b, x1: hx + b, y0: -b, y1: b, z0: z, z1: z + Math.max(0.02, h - gap) }, this.itemRgb(key), { glow });
      R.hit(hits, this.datum('item', side, key));
      z += h;
    }
    ctx.globalAlpha = 1;
    for (const c of corners) if (!far(...c)) cord(c);
    const yoke = corners.map(([x, y]) => C.project(x, y, yokeZ));
    R.polygon(yoke, null, cordColor, 1.5);
    R.line(C.project(hx, 0, yokeZ), C.project(hx, 0, hz), cordColor, 1.5);
    for (const [x, y] of corners) R.line(C.project(x, y, yokeZ), C.project(hx, 0, yokeZ + 0.35), cordColor, 1);
  }

  drawLabels() {
    const { camera: C, renderer: R, theme } = this;
    const ink = theme.markText ?? theme.text;
    const halo = theme.markHalo ?? theme.surface;
    const totals = this.sides.map((s) => this.total(s));
    this.sides.forEach((side, i) => {
      const [hx, , hz] = this.hook(i);
      // Under the pan: the side's name and total.
      const lows = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => C.project(hx + (sx * PAN) / 2, (sy * PAN) / 2, hz - this.hang)));
      const low = lows.reduce((a, b) => (b.y > a.y ? b : a));
      R.text(String(side), low.x, low.y + 16, { color: ink, size: 13, weight: 600, halo });
      R.text(this.format(totals[i]), low.x, low.y + 32, { color: theme.textMuted, size: 12, mono: true, halo });
    });
    // Over the pivot: which side is heavier, and by how much.
    const [l, r] = totals;
    const top = C.project(0, 0, this.pivotZ + 0.35);
    const heavier = r > l ? 1 : 0;
    const lighter = 1 - heavier;
    const diff = Math.abs(r - l);
    const pct = totals[lighter] ? ` (+${((diff / totals[lighter]) * 100).toFixed(1)}%)` : '';
    const text = diff < 1e-9 ? 'Balanced' : `${this.sides[heavier]} heavier by ${this.format(diff)}${pct}`;
    R.text(text, top.x, top.y - 12, { color: ink, size: 12, weight: 600, halo });
  }

  describe(item) {
    const suffix = this.frameLabel != null ? ` · ${this.frameLabel}` : '';
    if (item.kind === 'item') {
      const other = this.sides.find((s) => s !== item.side);
      const otherValue = this.valueAt(other, item.key);
      return {
        title: `${item.key}${suffix}`,
        rows: [
          { label: String(item.side), value: this.format(this.valueAt(item.side, item.key)), color: rgbString(this.itemRgb(item.key)), active: true },
          { label: String(other), value: this.format(otherValue), color: rgbString(this.itemRgb(item.key)) },
        ],
      };
    }
    const rows = this.items
      .map((k) => ({ k, v: this.valueAt(item.side, k) }))
      .filter(({ v }) => v > 0)
      .reverse()
      .map(({ k, v }) => ({ label: String(k), value: this.format(v), color: rgbString(this.itemRgb(k)) }));
    rows.push({ label: 'Total', value: this.format(this.total(item.side)) });
    return { title: `${item.side}${suffix}`, rows };
  }
}
