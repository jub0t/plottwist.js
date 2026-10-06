// Values as liquid in glass tanks. Each category is a cylinder filled to
// value / capacity, with a target ring; when the data changes the liquid
// pours in or drains, overshoots and sloshes before it settles, so the size
// of a change is felt as well as read. Tanks below their target can switch
// colour.
//
//   new IsoTankChart(el, { frames, key: 'reservoir', value: 'stored', capacity: 'capacity', target: 'minimum' })

import { Chart } from '../core/chart.js';
import { Tween, ease } from '../core/animation.js';
import { parseHex, rgbString, shade } from '../core/color.js';
import { faceBrightness } from '../core/shapes.js';
import { accessor, claim, drawSlab, framesOf, seriesColor } from '../core/stage.js';

const TAU = Math.PI * 2;
const SIDES = 40;

export class IsoTankChart extends Chart {
  constructor(container, options = {}) {
    super(container, { camera: { yaw: 0.22, pitch: 0.4 }, frameDuration: 1800, ...options });
    const o = this.options;
    this.key = accessor(o.key ?? 'name');
    this.value = accessor(o.value ?? 'value');
    this.capacityOf = typeof o.capacity === 'number' ? () => o.capacity : o.capacity ? accessor(o.capacity) : null;
    this.targetOf = typeof o.target === 'number' ? () => o.target : o.target ? accessor(o.target) : null;
    this.format = o.format ?? ((v) => v.toLocaleString(undefined, { maximumFractionDigits: 1 }));
    this.radius = o.radius ?? 0.85;
    this.height = o.height ?? 3;
    this.focus = new Tween(0);
    this.tanks = [];
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
    const capacity = new Map();
    const target = new Map();
    let max = 0;
    this.frames = frames.map((f) => {
      const values = new Map();
      for (const d of f.data) {
        const k = this.key(d);
        if (!keys.includes(k)) keys.push(k);
        const v = Math.max(0, +this.value(d) || 0);
        values.set(k, (values.get(k) ?? 0) + v);
        max = Math.max(max, values.get(k));
        const c = this.capacityOf?.(d);
        if (c != null) capacity.set(k, +c);
        const t = this.targetOf?.(d);
        if (t != null) target.set(k, +t);
      }
      return { label: f.label, values };
    });
    // Without capacities, every tank shares one: the largest value seen.
    const shared = max || 1;
    const old = new Map(this.tanks.map((t) => [t.key, t]));
    this.tanks = keys.map((key, index) => {
      const t = old.get(key) ?? { key, level: 0, velocity: 0, slosh: 0, phase: index * 1.7, pour: 0 };
      return Object.assign(t, { index, capacity: capacity.get(key) ?? shared, target: target.get(key) ?? null });
    });
    const n = this.tanks.length;
    this.perRow = this.options.perRow ?? (n <= 6 ? n : Math.ceil(n / Math.ceil(n / 6)));
    this.rows = Math.ceil(n / this.perRow);
    this.pitch = [this.radius * 2 + 1.3, this.radius * 2 + 2];
    this.timeline.length = this.frames.length;
    this.timeline.seek(Math.min(this.timeline.position, this.frames.length - 1));
    this.invalidate();
  }

  get frameLabel() {
    return this.frames[Math.round(this.timeline.position)]?.label ?? null;
  }

  valueAt(key, position = this.timeline.position) {
    const i = Math.floor(position);
    const t = position - i;
    const a = this.frames[i]?.values.get(key) ?? 0;
    if (t === 0 || i + 1 >= this.frames.length) return a;
    const b = this.frames[i + 1].values.get(key) ?? 0;
    return a + (b - a) * ease.cubicInOut(t);
  }

  center(tank) {
    const col = tank.index % this.perRow;
    const row = Math.floor(tank.index / this.perRow);
    return [(col - (this.perRow - 1) / 2) * this.pitch[0], (row - (this.rows - 1) / 2) * this.pitch[1]];
  }

  // ---- physics ----------------------------------------------------------------

  // The level is a damped spring chasing value / capacity: it overshoots a
  // little and settles. Its acceleration feeds the slosh, which decays.
  tick(now) {
    const dt = this._last == null ? 1 / 60 : Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    this.time = now / 1000;
    let active = this.focus.tick(now);
    const stiffness = 38;
    const damping = 7.5;
    for (const t of this.tanks) {
      t.value = this.valueAt(t.key);
      // The liquid chases each frame's value as a step, so a change pours in,
      // overshoots and sloshes; labels follow the liquid.
      const frame = this.frames[Math.round(this.timeline.position)];
      const goal = Math.min(1.04, (frame?.values.get(t.key) ?? 0) / (t.capacity || 1));
      // Semi-implicit Euler, substepped so it's stable at low frame rates.
      for (let k = 0; k < 4; k++) {
        const h = dt / 4;
        const accel = stiffness * (goal - t.level) - damping * t.velocity;
        t.velocity += accel * h;
        t.level += t.velocity * h;
        t.slosh = Math.min(0.5, t.slosh + Math.abs(accel) * h * 0.06);
      }
      t.slosh *= Math.exp(-dt / 0.9);
      t.pour += ((t.velocity > 0.02 ? Math.min(1, t.velocity * 4) : 0) - t.pour) * Math.min(1, dt * 10);
      if (Math.abs(goal - t.level) > 1e-4 || Math.abs(t.velocity) > 1e-4 || t.slosh > 0.002 || t.pour > 0.01) active = true;
    }
    return active;
  }

  onHoverChange() {
    this.focus.to(this.hovered ? 1 : 0, this.now(), { duration: 200 });
  }

  // Height of the liquid surface at a point on the rim (angle a): a tilt
  // that rocks back and forth plus a ripple, both scaled by the slosh.
  surfaceZ(t, a) {
    const base = Math.max(0, t.level) * this.height;
    if (t.slosh < 1e-4 || base <= 0) return base;
    const time = this.time ?? 0;
    const amp = t.slosh * this.radius;
    const tilt = Math.sin(time * 5.2 + t.phase) * Math.cos(a - t.phase);
    const ripple = 0.35 * Math.sin(time * 9 + 3 * a + t.phase);
    return Math.max(0, base + amp * (tilt + ripple) * Math.min(1, base / 0.3));
  }

  // Below target, judged on the liquid as drawn, so colour and label agree.
  below(t) {
    return t.target != null && Math.max(0, t.level) * t.capacity < t.target;
  }

  liquidRgb(t) {
    const o = this.options;
    if (this.below(t) && o.alertColor !== false) return parseHex(o.alertColor ?? '#f59e0b');
    if (o.color) return parseHex(o.color);
    return parseHex(seriesColor(this, t.key, t.index));
  }

  // ---- drawing ------------------------------------------------------------------

  floorBounds() {
    const hx = ((this.perRow - 1) * this.pitch[0]) / 2 + this.radius + 0.9;
    const hy = ((this.rows - 1) * this.pitch[1]) / 2 + this.radius + 0.9;
    return [hx, hy];
  }

  draw() {
    const { camera: C, renderer: R } = this;
    const [hx, hy] = this.floorBounds();
    const pts = [];
    for (const [x, y] of [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]) pts.push([x, y, -this.theme.floorThickness, { b: 8 }]);
    for (const t of this.tanks) {
      const [cx, cy] = this.center(t);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) pts.push([cx + dx * this.radius, cy + dy * this.radius, this.height + 0.15, { t: 44, l: 6, r: 6 }]);
    }
    this.fitScene(pts, { top: 14, right: 16, bottom: 14, left: 16 });
    drawSlab(this, -hx, hx, -hy, hy);
    const order = [...this.tanks].sort((a, b) => C.groundDepth(...this.center(a)) - C.groundDepth(...this.center(b)));
    for (const t of order) this.drawTank(t);
    this.drawLabels();
    if (this.hovered && (this.timeline.playing || this.focus.value < 1)) this._updateTooltip();
  }

  drawTank(t) {
    const { camera: C, renderer: R, theme } = this;
    const ctx = R.ctx;
    const [cx, cy] = this.center(t);
    const r = this.radius;
    const H = this.height;
    const P = (x, y, z) => C.project(x, y, z);
    const angles = Array.from({ length: SIDES }, (_, k) => (k / SIDES) * TAU);
    const rim = (z, rr = r) => angles.map((a) => P(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, z));
    const front = (a) => C.faces(Math.cos(a), Math.sin(a), 0);
    const dim = this.hovered && this.hovered !== t ? 1 - 0.5 * this.focus.value : 1;
    const dark = theme.mode === 'dark';
    const glass = dark ? [210, 220, 255] : [90, 80, 160];
    ctx.globalAlpha = dim;

    // Footprint shadow and the back of the glass.
    R.polygon(rim(0, r * 1.06), shade(parseHex(theme.floor), 0.75), null);
    R.polygon(silhouette(rim(0), rim(H)), `rgba(${glass.join(',')},${dark ? 0.04 : 0.06})`, null);

    // Target ring: the back half sits behind the liquid.
    const zt = t.target != null ? (t.target / t.capacity) * H : null;
    const ring = (z, half, style) => {
      ctx.beginPath();
      let open = false;
      angles.forEach((a, k) => {
        const b = angles[(k + 1) % SIDES];
        const mid = a + Math.PI / SIDES; // (a + b) / 2 breaks where angles wrap
        const show = half === 'front' ? front(mid) : !front(mid);
        if (!show) return (open = false);
        const p = P(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z);
        const q = P(cx + Math.cos(b) * r, cy + Math.sin(b) * r, z);
        if (!open) ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        open = true;
      });
      Object.assign(ctx, style);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const targetStyle = { strokeStyle: dark ? 'rgba(255,255,255,0.55)' : 'rgba(40,30,90,0.5)', lineWidth: 1.25 };
    if (zt != null) {
      ctx.setLineDash([4, 3]);
      ring(zt, 'back', targetStyle);
    }

    // Liquid: front-facing sides up to the (moving) surface, then the surface.
    const rgb = this.liquidRgb(t);
    const level = Math.max(0, t.level);
    if (level > 0.002) {
      const surf = angles.map((a) => this.surfaceZ(t, a));
      const ri = r * 0.96;
      for (let k = 0; k < SIDES; k++) {
        const a = angles[k];
        const b = angles[(k + 1) % SIDES];
        const mid = a + Math.PI / SIDES;
        const n = [Math.cos(mid), Math.sin(mid), 0];
        if (!C.faces(...n)) continue;
        const fill = shade(rgb, faceBrightness(C, theme, n) * 0.9, 0.88);
        const poly = [
          P(cx + Math.cos(a) * ri, cy + Math.sin(a) * ri, 0),
          P(cx + Math.cos(b) * ri, cy + Math.sin(b) * ri, 0),
          P(cx + Math.cos(b) * ri, cy + Math.sin(b) * ri, surf[(k + 1) % SIDES]),
          P(cx + Math.cos(a) * ri, cy + Math.sin(a) * ri, surf[k]),
        ];
        R.polygon(poly, fill, fill, 0.5);
      }
      const top = angles.map((a, k) => P(cx + Math.cos(a) * ri, cy + Math.sin(a) * ri, surf[k]));
      R.polygon(top, shade(rgb, 1.18, 0.92), shade(rgb, 1.45, 0.9), 1);
      // Bubbles rising through the liquid while it moves.
      if (t.slosh > 0.03 || t.pour > 0.05) this.drawBubbles(t, cx, cy, ri, level * H, rgb);
      if (theme.glow > 0) {
        const c = P(cx, cy, level * H);
        const s = r * C.scale * C.zoom;
        R.glow(rgb, c.x, c.y, s * 2.4, s * 1.2, theme.glow * 0.35);
      }
    }

    // The pour: a stream from above while the tank fills.
    if (t.pour > 0.02) {
      const w = r * 0.18 * t.pour;
      const zTop = H + 0.3;
      const zBot = this.surfaceZ(t, 0);
      const a = P(cx, cy, zTop);
      const b = P(cx, cy, zBot);
      const px = w * C.scale * C.zoom;
      ctx.fillStyle = shade(rgb, 1.15, 0.85);
      ctx.beginPath();
      ctx.moveTo(a.x - px, a.y);
      ctx.lineTo(a.x + px, a.y);
      ctx.lineTo(b.x + px * 0.7, b.y);
      ctx.lineTo(b.x - px * 0.7, b.y);
      ctx.fill();
    }

    // Front glass: a faint pane, a highlight stripe, and the outline.
    const sil = silhouette(rim(0), rim(H));
    R.polygon(sil, `rgba(${glass.join(',')},${dark ? 0.05 : 0.08})`, null);
    // World direction facing the viewer; the highlight sits a little left of it.
    const facing = Math.atan2(C._cy, C._sy);
    const hl = facing + 0.65;
    for (const [off, alpha] of [[0, 0.22], [0.12, 0.1]]) {
      const a0 = hl + off;
      const p0 = P(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, H * 0.08);
      const p1 = P(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, H * 0.92);
      R.line(p0, p1, `rgba(255,255,255,${alpha})`, 3);
    }
    if (zt != null) {
      ctx.setLineDash([4, 3]);
      ring(zt, 'front', targetStyle);
    }
    const outline = `rgba(${glass.join(',')},${dark ? 0.45 : 0.55})`;
    R.polygon(rim(H), null, outline, 1.25);
    ring(0, 'front', { strokeStyle: outline, lineWidth: 1.25 });
    // Vertical silhouette edges.
    const ext = extremes(rim(0), rim(H));
    for (const [p, q] of ext) R.line(p, q, outline, 1.25);
    // Graduation ticks up the glass every quarter.
    const ta = facing - 0.75;
    for (let k = 1; k < 4; k++) {
      const z = (k / 4) * H;
      const p0 = P(cx + Math.cos(ta) * r, cy + Math.sin(ta) * r, z);
      const p1 = P(cx + Math.cos(ta + 0.25) * r, cy + Math.sin(ta + 0.25) * r, z);
      R.line(p0, p1, outline, 1);
    }

    R.hit([sil], t);
    ctx.globalAlpha = 1;
  }

  drawBubbles(t, cx, cy, r, depth, rgb) {
    const { camera: C, renderer: R } = this;
    const ctx = R.ctx;
    const time = this.time ?? 0;
    const strength = Math.min(1, t.slosh * 3 + t.pour);
    ctx.fillStyle = shade(rgb, 1.6, 0.7 * strength);
    for (let k = 0; k < 10; k++) {
      const seed = (k * 0.618 + t.index * 0.37) % 1;
      const rise = ((time * (0.25 + seed * 0.3) + seed) % 1) * depth;
      const a = seed * TAU * 3;
      const rr = r * (0.2 + 0.6 * ((seed * 7.3) % 1));
      const p = C.project(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, rise);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.2 + seed * 1.6, 0, TAU);
      ctx.fill();
    }
  }

  drawLabels() {
    const { camera: C, renderer: R, theme } = this;
    const ink = theme.markText ?? theme.text;
    const halo = theme.markHalo ?? theme.surface;
    const placed = [];
    const order = [...this.tanks].sort((a, b) => C.groundDepth(...this.center(b)) - C.groundDepth(...this.center(a)));
    for (const t of order) {
      const [cx, cy] = this.center(t);
      R.ctx.globalAlpha = this.hovered && this.hovered !== t ? 1 - 0.5 * this.focus.value : 1;
      const p = C.project(cx, cy, this.height);
      // Above the rim: name, then value and how full.
      const ry = this.radius * C.scale * C.zoom * C._sp;
      const y = p.y - ry - 6;
      const name = String(t.key);
      const shown = Math.max(0, t.level) * t.capacity;
      const pct = t.capacity ? ` · ${Math.round(Math.max(0, t.level) * 100)}%` : '';
      const value = `${this.format(shown)}${pct}`;
      const w = Math.max(R.measure(name, 12, 600), R.measure(value, 11, 400, true)) / 2 + 3;
      if (!claim(placed, { l: p.x - w, r: p.x + w, t: y - 30, b: y }) && t !== this.hovered) continue;
      R.text(name, p.x, y - 20, { color: ink, size: 12, weight: 600, halo });
      R.text(value, p.x, y - 6, { color: this.below(t) ? rgbString(this.liquidRgb(t)) : ink, size: 11, mono: true, halo });
    }
    R.ctx.globalAlpha = 1;
  }

  describe(t) {
    const rows = [
      { label: this.options.valueLabel ?? 'Value', value: this.format(t.value), color: rgbString(this.liquidRgb(t)) },
      { label: 'Capacity', value: this.format(t.capacity) },
      { label: 'Full', value: `${((t.value / (t.capacity || 1)) * 100).toFixed(1)}%` },
    ];
    if (t.target != null) {
      const gap = t.value - t.target;
      rows.push({ label: this.options.targetLabel ?? 'Target', value: this.format(t.target) });
      rows.push({ label: gap >= 0 ? 'Above target' : 'Below target', value: this.format(Math.abs(gap)) });
    }
    return { title: `${t.key}${this.frameLabel != null ? ` · ${this.frameLabel}` : ''}`, rows };
  }
}

// Outline of a vertical cylinder from its bottom and top rims (screen points):
// the leftmost and rightmost points split each rim into near and far arcs.
function silhouette(bottom, top) {
  const [l, r] = extremeIndices(bottom);
  const n = bottom.length;
  const arc = (pts, from, to, near) => {
    // Walk from `from` to `to` along the arc that is lower (near) or higher (far) on screen.
    const walk = (dir) => {
      const out = [];
      for (let k = from; ; k = (k + dir + n) % n) {
        out.push(pts[k]);
        if (k === to) break;
      }
      return out;
    };
    const a = walk(1);
    const b = walk(-1);
    const avg = (list) => list.reduce((s, p) => s + p.y, 0) / list.length;
    return near ? (avg(a) > avg(b) ? a : b) : avg(a) > avg(b) ? b : a;
  };
  return [...arc(bottom, l, r, true), ...arc(top, r, l, false)];
}

function extremeIndices(pts) {
  let l = 0;
  let r = 0;
  pts.forEach((p, k) => {
    if (p.x < pts[l].x) l = k;
    if (p.x > pts[r].x) r = k;
  });
  return [l, r];
}

function extremes(bottom, top) {
  const [l, r] = extremeIndices(bottom);
  return [
    [bottom[l], top[l]],
    [bottom[r], top[r]],
  ];
}
