// A pipeline as a factory floor. Stages are machines; links are conveyor
// belts whose width follows their volume, and items ride them at a rate that
// follows it too, so throughput reads as traffic. Each item keeps the colour
// of the source it came from, so you can see how sources mix and where they
// end up. What a stage loses (in > out) drops into a reject bin beside it;
// final stages collect their items in crates.
//
//   new IsoFlowChart(el, { data: links, source: 'from', target: 'to', value: 'users' })

import { Chart } from '../core/chart.js';
import { Tween, ease } from '../core/animation.js';
import { parseHex, shade, rgbString } from '../core/color.js';
import { drawBox } from '../core/shapes.js';
import { accessor, claim, drawSlab, framesOf, seriesColor } from '../core/stage.js';

const STATION = 1.3; // machine footprint
const STATION_H = 0.9;
const BELT_Z = 0.14;
const GOLDEN = 0.6180339887;

export class IsoFlowChart extends Chart {
  constructor(container, options = {}) {
    super(container, { camera: { yaw: 0.28, pitch: 0.66 }, frameDuration: 2400, ...options });
    const o = this.options;
    this.source = accessor(o.source ?? 'source');
    this.target = accessor(o.target ?? 'target');
    this.value = accessor(o.value ?? 'value');
    this.format = o.format ?? ((v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }));
    this.speed = o.speed ?? 1.5; // belt speed, world units per second
    this.focus = new Tween(0);
    this.intro = new Tween(0);
    this._last = null;
    this.setFrames(framesOf(o));
    if (o.autoplay && this.frames.length > 1) this.play();
  }

  // ---- data -----------------------------------------------------------------

  setData(data) {
    this.setFrames([{ label: null, data }]);
  }

  setFrames(frames) {
    const first = !this.nodes;
    const ids = [];
    const pairs = new Map();
    this.frames = frames.map((f) => {
      const values = new Map();
      for (const d of f.data) {
        const s = this.source(d);
        const t = this.target(d);
        if (s == null || t == null || s === t) continue;
        for (const id of [s, t]) if (!ids.includes(id)) ids.push(id);
        const k = `${s}\u0000${t}`;
        if (!pairs.has(k)) pairs.set(k, [s, t]);
        values.set(k, (values.get(k) ?? 0) + Math.max(0, +this.value(d) || 0));
      }
      return { label: f.label, values };
    });

    const oldNodes = new Map((this.nodes ?? []).map((n) => [n.id, n]));
    this.nodes = ids.map((id) => Object.assign(oldNodes.get(id) ?? { id, kind: 'node' }, { id, inputs: [], outputs: [] }));
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    const oldLinks = new Map((this.links ?? []).map((l) => [l.key, l]));
    this.links = [...pairs].map(([key, [s, t]]) =>
      Object.assign(oldLinks.get(key) ?? { key, kind: 'link', phase: 0 }, { source: byId.get(s), target: byId.get(t) }),
    );
    for (const l of this.links) {
      l.source.outputs.push(l);
      l.target.inputs.push(l);
    }
    this.sources = this.nodes.filter((n) => !n.inputs.length);
    this.sources.forEach((n, i) => (n.sourceIndex = i));

    // Scales shared by every frame.
    let maxLink = 0;
    let maxNode = 0;
    for (const f of this.frames) {
      for (const v of f.values.values()) maxLink = Math.max(maxLink, v);
      for (const n of this.nodes) {
        const inflow = n.inputs.reduce((s, l) => s + (f.values.get(l.key) ?? 0), 0);
        const outflow = n.outputs.reduce((s, l) => s + (f.values.get(l.key) ?? 0), 0);
        maxNode = Math.max(maxNode, inflow, outflow);
      }
    }
    this.maxLink = maxLink || 1;
    this.maxNode = maxNode || 1;

    this.layout();
    this.timeline.length = this.frames.length;
    this.timeline.seek(Math.min(this.timeline.position, this.frames.length - 1));
    if (first) this.intro.to(1, this.now(), { duration: 1400, easing: ease.cubicOut });
    this.update();
    this.invalidate();
  }

  get frameLabel() {
    return this.frames[Math.round(this.timeline.position)]?.label ?? null;
  }

  linkValue(link, position = this.timeline.position) {
    const i = Math.floor(position);
    const t = position - i;
    const a = this.frames[i]?.values.get(link.key) ?? 0;
    if (t === 0 || i + 1 >= this.frames.length) return a;
    const b = this.frames[i + 1].values.get(link.key) ?? 0;
    return a + (b - a) * ease.cubicInOut(t);
  }

  // ---- layout -----------------------------------------------------------------

  // Columns by longest path from a source; rows ordered to keep belts short.
  layout() {
    const col = new Map();
    const visit = (n, seen = new Set()) => {
      if (col.has(n)) return col.get(n);
      if (seen.has(n)) return 0; // cycle: break it
      seen.add(n);
      const c = n.inputs.length ? Math.max(...n.inputs.map((l) => visit(l.source, seen) + 1)) : 0;
      col.set(n, c);
      return c;
    };
    for (const n of this.nodes) n.col = visit(n);
    this.columns = Math.max(...this.nodes.map((n) => n.col), 0) + 1;
    const byCol = Array.from({ length: this.columns }, () => []);
    for (const n of this.nodes) byCol[n.col].push(n);

    // Barycentre ordering, a few sweeps each way.
    byCol.forEach((list) => list.forEach((n, i) => (n.row = i - (list.length - 1) / 2)));
    const center = (n, dir) => {
      const near = dir > 0 ? n.inputs.map((l) => l.source) : n.outputs.map((l) => l.target);
      return near.length ? near.reduce((s, m) => s + m.row, 0) / near.length : n.row;
    };
    for (let sweep = 0; sweep < 4; sweep++) {
      const dir = sweep % 2 ? -1 : 1;
      const order = dir > 0 ? byCol.slice(1) : byCol.slice(0, -1).reverse();
      for (const list of order) {
        list.sort((a, b) => center(a, dir) - center(b, dir));
        list.forEach((n, i) => (n.row = i - (list.length - 1) / 2));
      }
    }

    this.colGap = this.options.columnGap ?? 4.4;
    this.rowGap = this.options.rowGap ?? 3.1;
    for (const n of this.nodes) {
      n.x = (n.col - (this.columns - 1) / 2) * this.colGap;
      n.y = n.row * this.rowGap;
      n.sink = !n.outputs.length;
    }

    // Belt ports: outputs spread along a machine's east face in the order of
    // their targets, inputs along the west face in the order of their sources.
    for (const n of this.nodes) {
      n.outputs.sort((a, b) => a.target.y - b.target.y);
      n.inputs.sort((a, b) => a.source.y - b.source.y);
      const spread = (list, set) => list.forEach((l, i) => set(l, list.length > 1 ? ((i / (list.length - 1)) - 0.5) * STATION * 0.55 : 0));
      spread(n.outputs, (l, dy) => (l.y0 = n.y + dy));
      spread(n.inputs, (l, dy) => (l.y1 = n.y + dy));
    }
    // Vertical runs in each column gap are staggered so belts don't overlap.
    const gaps = new Map();
    for (const l of this.links) {
      const k = l.source.col;
      if (!gaps.has(k)) gaps.set(k, []);
      gaps.get(k).push(l);
    }
    for (const list of gaps.values()) {
      list.sort((a, b) => a.y0 - b.y0 || a.y1 - b.y1);
      list.forEach((l, i) => {
        const x0 = l.source.x + STATION / 2;
        const x1 = l.target.x - STATION / 2;
        const t = list.length > 1 ? 0.3 + (0.4 * i) / (list.length - 1) : 0.5;
        // Belts that skip columns turn in the first or last gap, whichever
        // keeps their long run clear of the machines in between.
        let xm = x0 + (this.colGap - STATION) * t;
        if (l.target.col - l.source.col > 1) {
          const between = this.nodes.filter((m) => m.col > l.source.col && m.col < l.target.col);
          const clearance = (y) => Math.min(...between.map((m) => Math.abs(m.y - y)), Infinity);
          if (clearance(l.y1) > clearance(l.y0)) xm = x1 - (this.colGap - STATION) * (1 - t);
        }
        l.path = Math.abs(l.y0 - l.y1) < 1e-6 ? [[x0, l.y0], [x1, l.y1]] : [[x0, l.y0], [xm, l.y0], [xm, l.y1], [x1, l.y1]];
        l.length = 0;
        for (let k = 1; k < l.path.length; k++) l.length += Math.hypot(l.path[k][0] - l.path[k - 1][0], l.path[k][1] - l.path[k - 1][1]);
      });
    }

    // Reject bins sit off each machine's +y side; output crates replace sinks.
    for (const n of this.nodes) n.bin = [n.x, n.y + STATION / 2 + 1.1];
    const ys = this.nodes.map((n) => n.y);
    const xs = this.nodes.map((n) => n.x);
    this.bounds = [Math.min(...xs) - 1.6, Math.max(...xs) + 1.6, Math.min(...ys) - 1.6, Math.max(...ys) + STATION / 2 + 2];
  }

  // Throughput, loss and source mix of every stage at the current position.
  update() {
    const position = this.timeline.position;
    for (const l of this.links) l.value = this.linkValue(l, position);
    const order = [...this.nodes].sort((a, b) => a.col - b.col);
    const S = this.sources.length;
    for (const n of order) {
      n.inflow = n.inputs.reduce((s, l) => s + l.value, 0);
      n.outflow = n.outputs.reduce((s, l) => s + l.value, 0);
      n.loss = n.inputs.length && !n.sink ? Math.max(0, n.inflow - n.outflow) : 0;
      if (!n.inputs.length) {
        n.mix = Array.from({ length: S }, (_, i) => (i === n.sourceIndex ? 1 : 0));
      } else {
        n.mix = new Array(S).fill(0);
        for (const l of n.inputs) l.source.mix?.forEach((m, i) => (n.mix[i] += (m * l.value) / (n.inflow || 1)));
      }
    }
  }

  sourceRgb(i) {
    const n = this.sources[i];
    return parseHex(seriesColor(this, n?.id, i));
  }

  // Colour of the n-th item emitted from a stage: a low-discrepancy pick from
  // its source mix, so proportions hold along the belt.
  itemRgb(mix, n) {
    const u = (((n * GOLDEN) % 1) + 1) % 1;
    let acc = 0;
    for (let i = 0; i < mix.length; i++) {
      acc += mix[i];
      if (u < acc) return this.sourceRgb(i);
    }
    return this.sourceRgb(mix.length - 1);
  }

  // ---- animation ----------------------------------------------------------------

  tick(now) {
    const dt = this._last == null ? 0 : Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    this.update();
    // Items per second scale with volume; the busiest belt carries maxRate.
    const maxRate = this.options.rate ?? 2.6;
    for (const l of this.links) {
      l.rate = (l.value / this.maxLink) * maxRate;
      l.phase += dt * l.rate * this.intro.value;
    }
    for (const n of this.nodes) {
      n.lossRate = (n.loss / this.maxLink) * maxRate;
      n.lossPhase = (n.lossPhase ?? 0) + dt * n.lossRate * this.intro.value;
    }
    this.intro.tick(now);
    this.focus.tick(now);
    return this.options.flow !== false || this.intro.value < 1 || this.focus.value % 1 !== 0;
  }

  onHoverChange() {
    this.focus.to(this.hovered ? 1 : 0, this.now(), { duration: 200 });
  }

  // ---- drawing --------------------------------------------------------------------

  beltWidth(value) {
    return 0.14 + 0.42 * Math.sqrt(value / this.maxLink);
  }

  // Point at distance s along a polyline, with its direction.
  along(path, s) {
    for (let k = 1; k < path.length; k++) {
      const [ax, ay] = path[k - 1];
      const [bx, by] = path[k];
      const len = Math.hypot(bx - ax, by - ay);
      if (s <= len || k === path.length - 1) {
        const t = len ? Math.min(1, s / len) : 0;
        return [ax + (bx - ax) * t, ay + (by - ay) * t];
      }
      s -= len;
    }
    return path[path.length - 1];
  }

  draw() {
    const { camera: C, renderer: R, theme } = this;
    const [x0, x1, y0, y1] = this.bounds;
    const pts = [];
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) pts.push([x, y, -theme.floorThickness, { b: 6 }]);
    for (const n of this.nodes) pts.push([n.x, n.y, STATION_H, { t: 42, l: 50, r: 50 }]);
    this.fitScene(pts, { top: 16, right: 16, bottom: 16, left: 16 });

    drawSlab(this, x0, x1, y0, y1);
    const hovered = this.hovered;
    const related = (item) => {
      if (!hovered) return true;
      if (hovered.kind === 'link') return item === hovered || item === hovered.source || item === hovered.target;
      return item === hovered || (item.kind === 'link' && (item.source === hovered || item.target === hovered));
    };
    const dimFor = (item) => (related(item) ? 1 : 1 - 0.7 * this.focus.value);

    // Belts lie on the floor: nothing standing can be behind them, so they
    // go down first.
    for (const l of this.links) {
      R.ctx.globalAlpha = dimFor(l);
      this.drawBelt(l);
    }
    for (const n of this.nodes) {
      if (n.loss <= 0 && !n.lossShown) continue;
      R.ctx.globalAlpha = dimFor(n);
      this.drawChute(n);
    }

    // Items, machines and bins, far to near.
    const objects = [];
    for (const l of this.links) {
      const w = this.beltWidth(l.value);
      const size = Math.min(0.36, w * 0.7);
      const spacing = this.speed / Math.max(l.rate, 1e-6);
      const reach = (l.length * this.intro.value) / spacing;
      const mix = l.source.mix;
      for (let n = Math.floor(l.phase); n > l.phase - reach - 1; n--) {
        const s = (l.phase - n) * spacing;
        if (s < 0 || s > l.length * this.intro.value) continue;
        const [x, y] = this.along(l.path, s);
        objects.push({ depth: C.groundDepth(x, y), draw: () => this.drawItem(x, y, BELT_Z, size, this.itemRgb(mix, n), dimFor(l)) });
      }
    }
    for (const n of this.nodes) {
      if (n.lossRate > 0) {
        // Rejects slide off toward the bin.
        const spacing = this.speed / n.lossRate;
        const [bx, by] = n.bin;
        const len = by - (n.y + STATION / 2);
        for (let k = Math.floor(n.lossPhase); k > n.lossPhase - len / spacing - 1; k--) {
          const s = (n.lossPhase - k) * spacing;
          if (s < 0 || s > len) continue;
          const y = n.y + STATION / 2 + s;
          objects.push({ depth: C.groundDepth(bx, y), draw: () => this.drawItem(bx, y, BELT_Z, 0.2, this.itemRgb(n.mix, k), dimFor(n) * 0.85) });
        }
      }
      objects.push({ depth: C.groundDepth(n.x, n.y), draw: () => ((R.ctx.globalAlpha = dimFor(n)), n.sink ? this.drawCrate(n) : this.drawMachine(n)) });
      if (n.loss > 0) objects.push({ depth: C.groundDepth(...n.bin), draw: () => ((R.ctx.globalAlpha = dimFor(n)), this.drawBin(n)) });
    }
    objects.sort((a, b) => a.depth - b.depth);
    for (const o of objects) o.draw();
    R.ctx.globalAlpha = 1;
    this.drawLabels(dimFor);
    if (hovered) this._updateTooltip();
  }

  drawBelt(l) {
    const { camera: C, renderer: R, theme } = this;
    const w = this.beltWidth(l.value) / 2;
    const base = parseHex(theme.grid);
    const P = (x, y, z) => C.project(x, y, z);
    const hits = [];
    // Each leg is a flat box; legs overlap at the corners.
    for (let k = 1; k < l.path.length; k++) {
      const [ax, ay] = l.path[k - 1];
      const [bx, by] = l.path[k];
      const box =
        Math.abs(ay - by) < 1e-9
          ? { x0: Math.min(ax, bx) - (k > 1 ? w : 0), x1: Math.max(ax, bx) + (k < l.path.length - 1 ? w : 0), y0: ay - w, y1: ay + w }
          : { x0: ax - w, x1: ax + w, y0: Math.min(ay, by) - w, y1: Math.max(ay, by) + w };
      hits.push(...drawBox(C, R, theme, { ...box, z0: 0, z1: BELT_Z - 0.02 }, base, { glow: 1.25 }));
    }
    // Rollers: cross-lines that travel with the belt.
    const ctx = R.ctx;
    ctx.beginPath();
    const step = 0.32;
    const offset = ((l.phase * this.speed) / Math.max(l.rate, 1e-6)) % step;
    for (let s = offset; s < l.length; s += step) {
      const [x, y] = this.along(l.path, s);
      const [x2, y2] = this.along(l.path, Math.min(l.length, s + 0.01));
      const horizontal = Math.abs(y2 - y) < Math.abs(x2 - x) || (x2 === x && y2 === y);
      const a = horizontal ? P(x, y - w * 0.8, BELT_Z - 0.02) : P(x - w * 0.8, y, BELT_Z - 0.02);
      const b = horizontal ? P(x, y + w * 0.8, BELT_Z - 0.02) : P(x + w * 0.8, y, BELT_Z - 0.02);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.strokeStyle = shade(base, 0.7);
    ctx.lineWidth = 1;
    ctx.stroke();
    R.hit(hits, l);
  }

  // The short ramp from a machine to its reject bin.
  drawChute(n) {
    const { camera: C, renderer: R, theme } = this;
    const w = 0.16;
    const y0 = n.y + STATION / 2;
    drawBox(C, R, theme, { x0: n.x - w, x1: n.x + w, y0, y1: n.bin[1], z0: 0, z1: BELT_Z - 0.02 }, parseHex(theme.grid), { glow: 1.1 });
  }

  drawItem(x, y, z, size, rgb, alpha) {
    const { camera: C, renderer: R, theme } = this;
    const h = size / 2;
    R.ctx.globalAlpha = alpha;
    drawBox(C, R, theme, { x0: x - h, x1: x + h, y0: y - h, y1: y + h, z0: z, z1: z + size }, rgb, { glow: 1.1 });
  }

  drawMachine(n) {
    const { camera: C, renderer: R, theme } = this;
    const h = STATION / 2;
    const body = shade(parseHex(theme.grid), 1.35);
    const rgbBody = parseHex(body.startsWith('rgb') ? toHex(body) : body);
    const hits = drawBox(C, R, theme, { x0: n.x - h, x1: n.x + h, y0: n.y - h, y1: n.y + h, z0: 0, z1: STATION_H * this.intro.value + 0.05 }, rgbBody);
    // Roof panel: the stage's source mix as coloured bands.
    if (C.faces(0, 0, 1)) {
      const inset = 0.2;
      const z = STATION_H * this.intro.value + 0.05;
      let x = n.x - h + inset;
      const span = STATION - inset * 2;
      n.mix.forEach((m, i) => {
        if (m <= 0) return;
        const w = span * m;
        const pts = [C.project(x, n.y - h + inset, z), C.project(x + w, n.y - h + inset, z), C.project(x + w, n.y + h - inset, z), C.project(x, n.y + h - inset, z)];
        const fill = shade(this.sourceRgb(i), 1.05);
        R.polygon(pts, fill, fill, 0.5);
        x += w;
      });
      // Busy machines glow: bloom scales with throughput.
      const busy = Math.max(n.inflow, n.outflow) / this.maxNode;
      if (theme.glow > 0 && busy > 0) {
        const c = C.project(n.x, n.y, z);
        const s = STATION * C.scale * C.zoom;
        R.glow(this.mixRgb(n.mix), c.x, c.y, s * 2.2, s * 1.4, theme.glow * 0.45 * busy);
      }
    }
    R.hit(hits, n);
  }

  // Final stages: an open crate filled to its throughput, in its source mix.
  drawCrate(n) {
    const { camera: C, renderer: R, theme } = this;
    const h = STATION / 2;
    const wall = parseHex(theme.grid);
    const P = (x, y, z) => C.project(x, y, z);
    const H = 0.75;
    const fill = (n.inflow / this.maxNode) * (H - 0.08) * this.intro.value;
    // Back walls, contents, then front walls, so the fill sits inside.
    const walls = [
      [[1, 0, 0], [[n.x + h, n.y - h], [n.x + h, n.y + h]]],
      [[-1, 0, 0], [[n.x - h, n.y + h], [n.x - h, n.y - h]]],
      [[0, 1, 0], [[n.x + h, n.y + h], [n.x - h, n.y + h]]],
      [[0, -1, 0], [[n.x - h, n.y - h], [n.x + h, n.y - h]]],
    ];
    const face = ([nrm, [[ax, ay], [bx, by]]], alpha) => {
      const k = 0.55 + 0.4 * C.light(...nrm);
      R.polygon([P(ax, ay, 0), P(bx, by, 0), P(bx, by, H), P(ax, ay, H)], shade(wall, 1 + k * 0.5, alpha), shade(wall, 1.8), 1);
    };
    const hits = [];
    for (const w of walls) if (!C.faces(...w[0])) face(w, 0.95);
    if (fill > 0.01) {
      hits.push(...drawBox(C, R, theme, { x0: n.x - h + 0.05, x1: n.x + h - 0.05, y0: n.y - h + 0.05, y1: n.y + h - 0.05, z0: 0, z1: fill }, this.mixRgb(n.mix)));
      // Top of the pile in mix bands.
      let x = n.x - h + 0.05;
      const span = STATION - 0.1;
      n.mix.forEach((m, i) => {
        if (m <= 0) return;
        const w = span * m;
        const top = shade(this.sourceRgb(i), 1.1);
        R.polygon([P(x, n.y - h + 0.05, fill), P(x + w, n.y - h + 0.05, fill), P(x + w, n.y + h - 0.05, fill), P(x, n.y + h - 0.05, fill)], top, top, 0.5);
        x += w;
      });
    }
    for (const w of walls) if (C.faces(...w[0])) face(w, 0.55);
    hits.push([P(n.x - h, n.y - h, H), P(n.x + h, n.y - h, H), P(n.x + h, n.y + h, H), P(n.x - h, n.y + h, H)]);
    R.hit(hits, n);
  }

  // A small grey bin; its fill shows how much this stage loses.
  drawBin(n) {
    const { camera: C, renderer: R, theme } = this;
    const [bx, by] = n.bin;
    const h = 0.42;
    const H = 0.5;
    const P = (x, y, z) => C.project(x, y, z);
    const wall = parseHex(theme.grid);
    const fill = Math.min(H - 0.04, (n.loss / this.maxNode) * 1.6 * (H - 0.04) + 0.03);
    const walls = [
      [[1, 0, 0], [[bx + h, by - h], [bx + h, by + h]]],
      [[-1, 0, 0], [[bx - h, by + h], [bx - h, by - h]]],
      [[0, 1, 0], [[bx + h, by + h], [bx - h, by + h]]],
      [[0, -1, 0], [[bx - h, by - h], [bx + h, by - h]]],
    ];
    const face = ([nrm, [[ax, ay], [cx, cy]]], alpha) =>
      R.polygon([P(ax, ay, 0), P(cx, cy, 0), P(cx, cy, H), P(ax, ay, H)], shade(wall, 1.2 + 0.3 * C.light(...nrm), alpha), shade(wall, 1.7), 1);
    for (const w of walls) if (!C.faces(...w[0])) face(w, 0.95);
    drawBox(C, R, theme, { x0: bx - h + 0.04, x1: bx + h - 0.04, y0: by - h + 0.04, y1: by + h - 0.04, z0: 0, z1: fill }, shade3(this.mixRgb(n.mix), 0.55));
    for (const w of walls) if (C.faces(...w[0])) face(w, 0.55);
    R.hit([[P(bx - h, by - h, H), P(bx + h, by - h, H), P(bx + h, by + h, H), P(bx - h, by + h, H)]], { kind: 'loss', node: n });
  }

  mixRgb(mix) {
    const out = [0, 0, 0];
    mix.forEach((m, i) => this.sourceRgb(i).forEach((c, k) => (out[k] += c * m)));
    return out;
  }

  drawLabels(dimFor) {
    const { camera: C, renderer: R, theme } = this;
    const ink = theme.markText ?? theme.text;
    const halo = theme.markHalo ?? theme.surface;
    const placed = [];
    const items = [...this.nodes].sort((a, b) => C.groundDepth(b.x, b.y) - C.groundDepth(a.x, a.y));
    for (const n of items) {
      R.ctx.globalAlpha = dimFor(n);
      const p = C.project(n.x, n.y, (n.sink ? 0.75 : STATION_H) + 0.1);
      const name = String(n.id);
      const value = this.format(n.sink ? n.inflow : Math.max(n.inflow, n.outflow));
      const w = Math.max(R.measure(name, 12, 600), R.measure(value, 11, 400, true)) / 2 + 3;
      if (!claim(placed, { l: p.x - w, r: p.x + w, t: p.y - 38, b: p.y - 6 }) && n !== this.hovered) continue;
      R.text(name, p.x, p.y - 28, { color: ink, size: 12, weight: 600, halo });
      R.text(value, p.x, p.y - 13, { color: ink, size: 11, mono: true, halo });
      if (n.loss > 0) {
        // Under the bin, which sits on the open floor.
        const corners = [-1, 1].flatMap((dx) => [-1, 1].map((dy) => C.project(n.bin[0] + dx * 0.42, n.bin[1] + dy * 0.42, 0)));
        const low = corners.reduce((a, b) => (b.y > a.y ? b : a));
        const rate = n.inflow ? ` · ${((n.loss / n.inflow) * 100).toFixed(0)}%` : '';
        R.text(`−${this.format(n.loss)}${rate}`, low.x, low.y + 10, { color: theme.textMuted, size: 10, mono: true, halo });
      }
    }
    R.ctx.globalAlpha = 1;
  }

  describe(item) {
    const label = this.options.valueLabel ?? 'Volume';
    const suffix = this.frameLabel != null ? ` · ${this.frameLabel}` : '';
    const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '–');
    const mixRows = (mix) =>
      mix
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => m > 0.005)
        .map(({ m, i }) => ({ label: String(this.sources[i].id), value: pct(m, 1), color: rgbString(this.sourceRgb(i)) }));
    if (item.kind === 'link') {
      return {
        title: `${item.source.id} → ${item.target.id}${suffix}`,
        rows: [
          { label, value: this.format(item.value) },
          { label: `Share of ${item.source.id}`, value: pct(item.value, item.source.outflow || item.source.inflow) },
          ...mixRows(item.source.mix),
        ],
      };
    }
    if (item.kind === 'loss') {
      const n = item.node;
      return { title: `Lost at ${n.id}${suffix}`, rows: [{ label, value: this.format(n.loss) }, { label: 'Of input', value: pct(n.loss, n.inflow) }] };
    }
    const rows = [];
    if (item.inputs.length) rows.push({ label: 'In', value: this.format(item.inflow) });
    if (item.outputs.length) rows.push({ label: 'Out', value: this.format(item.outflow) });
    if (item.loss > 0) rows.push({ label: 'Lost', value: `${this.format(item.loss)} (${pct(item.loss, item.inflow)})` });
    return { title: `${item.id}${suffix}`, rows: [...rows, ...(this.sources.length > 1 ? mixRows(item.mix) : [])] };
  }
}

function toHex(rgb) {
  const [r, g, b] = rgb.match(/\d+/g).map(Number);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

const shade3 = (rgb, k) => rgb.map((c) => c * k);
