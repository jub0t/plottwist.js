// [radius fraction, alpha weight] for the glow's stacked ellipses.
const GLOW_RINGS = [
  [1, 0.1],
  [0.66, 0.16],
  [0.38, 0.24],
];

// Canvas 2D renderer: owns the canvas, handles HiDPI and resizing, draws
// polygons and text, and records hit regions for pointer picking.

export class Renderer {
  // overlay: an extra layer stacked above the main canvas that ignores the
  // pointer, for content that animates independently of the scene.
  constructor(container, { onResize, overlay = false } = {}) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = overlay
      ? 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;'
      : 'display:block;width:100%;height:100%;touch-action:none;';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.width = 0;
    this.height = 0;
    this.hits = [];
    this.fontFamily = 'system-ui, sans-serif';
    this.fontMono = 'ui-monospace, monospace';

    this._observer = new ResizeObserver(() => {
      this.resize();
      onResize?.(this.width, this.height);
    });
    this._observer.observe(container);
    this.resize();
  }

  resize() {
    const { width, height } = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Clear the canvas. It stays transparent unless a background is given.
  begin(background) {
    const { ctx, width, height } = this;
    ctx.clearRect(0, 0, width, height);
    if (background && background !== 'transparent') {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }
    this.hits = [];
  }

  // Additive soft glow centred at (x, y), w x h CSS pixels: three concentric
  // translucent ellipses approximate a radial falloff. Plain path fills are
  // much cheaper than shadowBlur, per-frame gradients or offscreen compositing.
  glow(rgb, x, y, w, h, alpha) {
    alpha *= this.ctx.globalAlpha;
    if (alpha <= 0.03 || w < 1) return;
    const { ctx } = this;
    const op = ctx.globalCompositeOperation;
    const a = ctx.globalAlpha;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 1;
    const c = `${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0}`;
    for (const [r, k] of GLOW_RINGS) {
      ctx.beginPath();
      ctx.ellipse(x, y, (w / 2) * r, (h / 2) * r, 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${c},${Math.min(1, alpha * k)})`;
      ctx.fill();
    }
    ctx.globalCompositeOperation = op;
    ctx.globalAlpha = a;
  }

  polygon(points, fill, stroke, lineWidth = 1) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }

  line(a, b, stroke, lineWidth = 1) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  font(size = 12, weight = 400, mono = false) {
    return `${weight} ${size}px ${mono ? this.fontMono : this.fontFamily}`;
  }

  measure(str, size = 12, weight = 400, mono = false) {
    this.ctx.font = this.font(size, weight, mono);
    return this.ctx.measureText(str).width;
  }

  // halo: an outline colour drawn under the text so it reads on any mark.
  text(str, x, y, { color, size = 12, weight = 400, align = 'center', baseline = 'middle', mono = false, halo } = {}) {
    const { ctx } = this;
    ctx.font = this.font(size, weight, mono);
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    if (halo) {
      ctx.strokeStyle = halo;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeText(str, x, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  // Register a pickable region. Later registrations sit on top.
  hit(polygons, datum) {
    this.hits.push({ polygons, datum });
  }

  pick(x, y) {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      if (this.hits[i].polygons.some((p) => inside(p, x, y))) return this.hits[i].datum;
    }
    return null;
  }

  destroy() {
    this._observer.disconnect();
    this.canvas.remove();
  }
}

function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}
