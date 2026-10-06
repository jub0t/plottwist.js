// Animation primitives. Everything is driven by the chart's single rAF loop:
// each primitive exposes tick(now) and returns true while it is still moving.

export const ease = {
  linear: (t) => t,
  cubicOut: (t) => 1 - (1 - t) ** 3,
  cubicInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  backOut: (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2,
};

// A scalar that eases from its current value to a target.
export class Tween {
  constructor(value = 0) {
    this.value = value;
    this.target = value;
  }

  to(target, now, { duration = 700, delay = 0, easing = ease.cubicOut } = {}) {
    this.from = this.value;
    this.target = target;
    this.start = now + delay;
    this.duration = duration;
    this.easing = easing;
  }

  // Jump straight to a value, cancelling any running transition.
  set(value) {
    this.value = this.target = value;
  }

  tick(now) {
    if (this.value === this.target) return false;
    const t = (now - this.start) / this.duration;
    if (t < 0) return true;
    if (t >= 1) {
      this.value = this.target;
      return true; // render the final frame
    }
    this.value = this.from + (this.target - this.from) * this.easing(t);
    return true;
  }
}

// Plays through a sequence of frames, exposing a fractional position so charts
// can interpolate smoothly *between* frames rather than snapping.
export class Timeline {
  constructor({ length = 0, frameDuration = 1400, loop = true } = {}) {
    this.length = length;
    this.frameDuration = frameDuration;
    this.loop = loop;
    this.position = 0;
    this.playing = false;
    this._last = null;
  }

  play() {
    if (this.length < 2) return;
    if (!this.loop && this.position >= this.length - 1) this.position = 0;
    this.playing = true;
    this._last = null;
  }

  pause() {
    this.playing = false;
  }

  seek(position) {
    this.position = Math.max(0, Math.min(this.length - 1, position));
  }

  tick(now) {
    if (!this.playing) return false;
    if (this._last !== null) {
      const end = this.length - 1;
      let p = this.position + (now - this._last) / this.frameDuration;
      if (p >= end) {
        if (this.loop) p %= end;
        else {
          p = end;
          this.playing = false;
        }
      }
      this.position = p;
    }
    this._last = now;
    return true;
  }
}
