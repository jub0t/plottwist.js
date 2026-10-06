// Base class for every plottwist chart. Owns the render loop, camera,
// interaction (orbit, inertia, pinch-zoom, keyboard), tooltip and events.
// Subclasses implement tick(now) -> boolean and draw().

import { Camera, ISO_PITCH, ISO_YAW } from './camera.js';
import { Renderer } from './renderer.js';
import { Timeline, Tween, ease } from './animation.js';
import { resolveTheme } from './color.js';

const MIN_PITCH = 0.001;
const MAX_PITCH = Math.PI / 2 - 0.001;

// Named camera presets. 'top' and 'front' flatten the scene into an honest 2D
// reading of the same data; transitions between them are animated.
export const VIEWS = {
  iso: { yaw: ISO_YAW, pitch: ISO_PITCH },
  top: { yaw: 0, pitch: MAX_PITCH },
  front: { yaw: 0, pitch: MIN_PITCH },
  side: { yaw: -Math.PI / 2, pitch: MIN_PITCH },
};

export class Chart {
  constructor(container, options = {}) {
    if (typeof container === 'string') container = document.querySelector(container);
    if (!container) throw new Error('plottwist: container not found');
    this.container = container;
    this.options = options;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

    this.camera = new Camera({ ...VIEWS[options.view ?? 'iso'], ...options.camera });
    this.view = {
      yaw: new Tween(this.camera.yaw),
      pitch: new Tween(this.camera.pitch),
      zoom: new Tween(this.camera.zoom),
    };
    this.renderer = new Renderer(container, {
      onResize: () => {
        this._fit = null; // snap to the new size rather than easing
        this.invalidate();
      },
    });
    this.timeline = new Timeline({
      frameDuration: options.frameDuration ?? 1400,
      loop: options.loop ?? true,
    });
    this.hovered = null;
    this._listeners = {};
    this._yawVelocity = 0;
    this._lastFramePosition = -1;

    this.setTheme(options.theme ?? 'midnight');

    // Don't spend frames on charts scrolled out of view.
    this.visible = true;
    if (typeof IntersectionObserver === 'function') {
      this._io = new IntersectionObserver(([entry]) => {
        this.visible = entry.isIntersecting;
        if (this.visible) this.invalidate();
      });
      this._io.observe(container);
    }
    this._createTooltip();
    this._bindInput();
  }

  // ---- public API -------------------------------------------------------

  on(event, fn) {
    (this._listeners[event] ??= new Set()).add(fn);
    return () => this._listeners[event].delete(fn);
  }

  setTheme(theme) {
    this.theme = resolveTheme(theme);
    this.renderer.fontFamily = this.theme.font;
    this.renderer.fontMono = this.theme.fontMono;
    this._styleTooltip?.();
    this._tooltipSignature = null;
    this.invalidate();
  }

  play() {
    this.timeline.play();
    this.invalidate();
    this.emit('play');
  }

  pause() {
    this.timeline.pause();
    this.emit('pause');
  }

  toggle() {
    this.timeline.playing ? this.pause() : this.play();
  }

  seek(position) {
    this.timeline.seek(position);
    this.invalidate();
  }

  get playing() {
    return this.timeline.playing;
  }

  // Animate to a named preset (see VIEWS) or an explicit { yaw, pitch, zoom }.
  setView(view, { duration = 900 } = {}) {
    const target = typeof view === 'string' ? VIEWS[view] : view;
    if (!target) throw new Error(`plottwist: unknown view "${view}"`);
    const now = performance.now();
    const opts = { duration, easing: ease.cubicInOut };
    if (target.yaw !== undefined) {
      // Turn the short way round rather than unwinding accumulated spins.
      const turns = Math.round((this.view.yaw.value - target.yaw) / (Math.PI * 2));
      this.view.yaw.to(target.yaw + turns * Math.PI * 2, now, opts);
    }
    if (target.pitch !== undefined) this.view.pitch.to(target.pitch, now, opts);
    if (target.zoom !== undefined) this.view.zoom.to(target.zoom, now, opts);
    this._yawVelocity = 0;
    this.invalidate();
  }

  resetView() {
    this.setView({ ...VIEWS[this.options.view ?? 'iso'], ...this.options.camera, zoom: 1 });
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this._io?.disconnect();
    this._unbind.forEach((fn) => fn());
    this.tooltip.remove();
    this.renderer.destroy();
  }

  // ---- loop ---------------------------------------------------------------

  emit(event, payload) {
    this._listeners[event]?.forEach((fn) => fn(payload));
  }

  // Request a full redraw on the next frame.
  invalidate() {
    this._dirty = true;
    this._schedule();
  }

  _schedule() {
    this._raf ??= requestAnimationFrame((now) => this._frame(now));
  }

  _frame(now) {
    this._raf = null;
    // Offscreen: stop the loop; the observer restarts it on re-entry. Tweens
    // are time-based, so they land in the right place when it resumes.
    if (!this.visible) {
      this._dirty = true;
      return;
    }
    let active = false;

    for (const t of Object.values(this.view)) active = t.tick(now) || active;
    if (!this._dragging && Math.abs(this._yawVelocity) > 1e-4) {
      this.view.yaw.set(this.view.yaw.value + this._yawVelocity);
      this._yawVelocity *= 0.93;
      active = true;
    }
    if (this.options.autoRotate && !this._dragging && !this.hovered) {
      this.view.yaw.set(this.view.yaw.value + 0.0025);
      active = true;
    }

    active = this.timeline.tick(now) || active;
    if (this.timeline.position !== this._lastFramePosition) {
      this._lastFramePosition = this.timeline.position;
      this.emit('frame', { position: this.timeline.position, playing: this.timeline.playing });
    }

    this.camera.yaw = this.view.yaw.value;
    this.camera.pitch = this.view.pitch.value;
    this.camera.zoom = this.view.zoom.value;
    this.camera.update();

    active = this.tick(now) || active;
    // The main canvas only redraws when something on it changed. Charts with
    // a continuously animated overlay (e.g. flowing arcs) redraw just that.
    if (active || this._dirty) {
      this._dirty = false;
      this.renderer.begin(this.theme.background);
      this.draw();
    }
    const overlay = this.drawOverlay?.(now) ?? false;
    if (active) this._dirty = true;
    if (active || overlay || this._dirty) this._schedule();
  }

  // Ease the camera's scale/origin toward a fit of `points`. Holds still while
  // the user drags so the scene doesn't breathe under their pointer.
  fitScene(points, pad) {
    const { camera: C, renderer: R } = this;
    const target = C.fitTarget(R.width, R.height, points, pad);
    if (!this._fit) this._fit = target;
    else if (!this._dragging) {
      let moving = false;
      for (const k of ['scale', 'cx', 'cy']) {
        const d = target[k] - this._fit[k];
        if (Math.abs(d) > 0.3) {
          this._fit[k] += d * 0.18;
          moving = true;
        } else this._fit[k] = target[k];
      }
      if (moving) this.invalidate();
    }
    Object.assign(C, this._fit, { zx: R.width / 2, zy: R.height / 2 });
  }

  // What's under a screen point: registered hit regions first, then the
  // chart's own fallback (e.g. a ground-plane lookup).
  pick(x, y) {
    return this.renderer.pick(x, y) ?? this.pickGround?.(x, y) ?? null;
  }

  tick() {
    return false;
  }

  draw() {}

  // Subclasses return { title, rows: [{ label, value, color }] } or null.
  describe() {
    return null;
  }

  // ---- interaction --------------------------------------------------------

  _bindInput() {
    const canvas = this.renderer.canvas;
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    if (this.options.ariaLabel) canvas.setAttribute('aria-label', this.options.ariaLabel);

    let start = null;
    let last = null;

    const local = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const onDown = (e) => {
      canvas.setPointerCapture(e.pointerId);
      start = last = { ...local(e), t: performance.now() };
      this._dragging = false;
      this._yawVelocity = 0;
    };

    const onMove = (e) => {
      const p = local(e);
      if (start) {
        if (!this._dragging && Math.hypot(p.x - start.x, p.y - start.y) > 4) {
          this._dragging = true;
          canvas.style.cursor = 'grabbing';
          this._setHover(null);
        }
        if (this._dragging) {
          const dx = p.x - last.x;
          const dy = p.y - last.y;
          this.view.yaw.set(this.view.yaw.value - dx * 0.008);
          this.view.pitch.set(
            Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.view.pitch.value + dy * 0.006)),
          );
          this._yawVelocity = -dx * 0.008;
          last = { ...p, t: performance.now() };
          this.invalidate();
        }
        return;
      }
      this._pointer = p;
      this._setHover(this.pick(p.x, p.y));
    };

    const onUp = (e) => {
      const wasDrag = this._dragging;
      // Only keep momentum if the pointer was still moving at release.
      if (wasDrag && performance.now() - last.t > 60) this._yawVelocity = 0;
      start = null;
      this._dragging = false;
      canvas.style.cursor = '';
      this.invalidate();
      if (!wasDrag) {
        const p = local(e);
        const datum = this.pick(p.x, p.y);
        if (datum) this.emit('click', datum);
      }
    };

    const onLeave = () => !start && this._setHover(null);

    // Trackpad pinch arrives as ctrl+wheel; plain wheel is left to page scroll.
    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const z = this.view.zoom.value * Math.exp(-e.deltaY * 0.01);
      this.view.zoom.set(Math.max(0.4, Math.min(4, z)));
      this.invalidate();
    };

    const onKey = (e) => {
      const step = Math.PI / 12;
      const now = performance.now();
      const opts = { duration: 350 };
      if (e.key === 'ArrowLeft') this.view.yaw.to(this.view.yaw.target + step, now, opts);
      else if (e.key === 'ArrowRight') this.view.yaw.to(this.view.yaw.target - step, now, opts);
      else if (e.key === 'ArrowUp')
        this.view.pitch.to(Math.min(MAX_PITCH, this.view.pitch.target + step / 2), now, opts);
      else if (e.key === 'ArrowDown')
        this.view.pitch.to(Math.max(MIN_PITCH, this.view.pitch.target - step / 2), now, opts);
      else if (e.key === ' ') this.toggle();
      else if (e.key === '0') this.resetView();
      else return;
      e.preventDefault();
      this.invalidate();
    };

    const onDbl = () => this.resetView();

    const listeners = [
      ['pointerdown', onDown],
      ['pointermove', onMove],
      ['pointerup', onUp],
      ['pointercancel', onUp],
      ['pointerleave', onLeave],
      ['wheel', onWheel, { passive: false }],
      ['keydown', onKey],
      ['dblclick', onDbl],
    ];
    for (const [type, fn, opts] of listeners) canvas.addEventListener(type, fn, opts);
    this._unbind = listeners.map(([type, fn]) => () => canvas.removeEventListener(type, fn));
  }

  _setHover(datum) {
    if (datum !== this.hovered) {
      this.hovered = datum;
      this.renderer.canvas.style.cursor = datum ? 'pointer' : '';
      this.emit('hover', datum);
      this.onHoverChange?.(datum);
      this.invalidate();
    }
    this._updateTooltip();
  }

  // ---- tooltip -------------------------------------------------------------

  _createTooltip() {
    const el = document.createElement('div');
    el.setAttribute('role', 'tooltip');
    el.style.cssText = `
      position:absolute;left:0;top:0;pointer-events:none;opacity:0;
      transition:opacity .12s ease;z-index:10;min-width:140px;
      padding:10px 12px;border-radius:12px;font-size:12px;line-height:1.5;
      white-space:nowrap;`;
    this.container.appendChild(el);
    this.tooltip = el;
    this._styleTooltip = () => {
      const t = this.theme;
      el.style.fontFamily = t.font;
      el.style.background = t.tooltip;
      el.style.color = t.text;
      el.style.border = `1px solid ${t.tooltipBorder}`;
      el.style.boxShadow =
        t.mode === 'dark' ? '0 8px 32px rgba(0,0,0,.5)' : '0 8px 28px rgba(40,30,90,.12)';
    };
    this._styleTooltip();
  }

  _updateTooltip() {
    const info = this.hovered && this.describe(this.hovered);
    const el = this.tooltip;
    if (!info || !this._pointer) {
      el.style.opacity = '0';
      this._tooltipSignature = null;
      return;
    }
    // Rebuild the DOM only when the content changes; otherwise just move it.
    const signature = JSON.stringify(info);
    if (signature !== this._tooltipSignature) {
      this._tooltipSignature = signature;
      this._renderTooltip(info);
      this._tooltipSize = [this.tooltip.offsetWidth, this.tooltip.offsetHeight];
    }
    this._positionTooltip();
  }

  _renderTooltip(info) {
    const el = this.tooltip;
    el.replaceChildren();
    const title = document.createElement('div');
    title.textContent = info.title;
    title.style.cssText = `font-weight:600;margin-bottom:4px;color:${this.theme.text}`;
    el.appendChild(title);
    const swatches = info.rows.some((r) => r.color);
    for (const row of info.rows) {
      const line = document.createElement('div');
      line.style.cssText = 'display:flex;align-items:center;gap:8px;';
      if (swatches) {
        const sw = document.createElement('span');
        sw.style.cssText = `width:8px;height:8px;border-radius:2px;background:${row.color ?? 'transparent'}`;
        line.appendChild(sw);
      }
      const label = document.createElement('span');
      label.textContent = row.label;
      label.style.cssText = `color:${row.active ? this.theme.text : this.theme.textMuted};flex:1;${
        row.active ? 'font-weight:600' : ''
      }`;
      const value = document.createElement('span');
      value.textContent = row.value;
      value.style.cssText = `font-weight:600;font-family:${this.theme.fontMono};font-variant-numeric:tabular-nums`;
      line.append(label, value);
      el.appendChild(line);
    }
  }

  // Keep the tooltip inside the container.
  _positionTooltip() {
    const el = this.tooltip;
    const { x, y } = this._pointer;
    const [w, h] = this._tooltipSize;
    const left = x + 14 + w > this.renderer.width ? x - 14 - w : x + 14;
    const top = Math.max(4, Math.min(this.renderer.height - h - 4, y - h - 10));
    el.style.transform = `translate(${left}px, ${top}px)`;
    el.style.opacity = '1';
  }
}
