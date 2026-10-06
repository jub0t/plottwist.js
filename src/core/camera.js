// Orthographic camera for isometric-style projection.
//
// World space: x/y lie on the ground plane, z points up.
// The camera orbits the z axis by `yaw` and looks down at `pitch` radians
// above the horizon. True isometric is yaw = 45°, pitch = atan(1/√2) ≈ 35.26°.

export const ISO_YAW = Math.PI / 4;
export const ISO_PITCH = Math.atan(1 / Math.SQRT2);

// Light direction in camera space: (right, toward viewer, up). Kept relative to
// the camera so faces read consistently no matter how the scene is rotated.
const LIGHT = normalize([-0.45, 0.55, 0.75]);

export class Camera {
  constructor({ yaw = ISO_YAW, pitch = ISO_PITCH, zoom = 1 } = {}) {
    this.yaw = yaw;
    this.pitch = pitch;
    this.zoom = zoom;
    this.scale = 40; // pixels per world unit, set from fitTarget()
    this.cx = 0; // screen-space origin
    this.cy = 0;
    this.zx = 0; // zoom centre
    this.zy = 0;
    this.update();
  }

  update() {
    this._cy = Math.cos(this.yaw);
    this._sy = Math.sin(this.yaw);
    this._cp = Math.cos(this.pitch);
    this._sp = Math.sin(this.pitch);
  }

  // World point -> { x, y } in CSS pixels, plus `depth` (larger = nearer).
  project(x, y, z) {
    const u = x * this._cy - y * this._sy;
    const v = x * this._sy + y * this._cy;
    const sx = this.cx + u * this.scale;
    const sy = this.cy + (v * this._sp - z * this._cp) * this.scale;
    // Zoom scales about the viewport centre (zx, zy).
    return {
      x: this.zx + (sx - this.zx) * this.zoom,
      y: this.zy + (sy - this.zy) * this.zoom,
      depth: v * this._cp + z * this._sp,
    };
  }

  // Screen point -> world point on the ground plane (z = 0), or null when the
  // camera looks along the ground and the ray never meets it.
  unproject(px, py) {
    if (this._sp < 1e-3) return null;
    const sx = (px - this.zx) / this.zoom + this.zx;
    const sy = (py - this.zy) / this.zoom + this.zy;
    const u = (sx - this.cx) / this.scale;
    const v = (sy - this.cy) / this.scale / this._sp;
    return [u * this._cy + v * this._sy, -u * this._sy + v * this._cy];
  }

  // Ground-plane depth, used to order objects that stand on the floor.
  groundDepth(x, y) {
    return x * this._sy + y * this._cy;
  }

  // Rotate a world-space normal into camera space: [right, toward, up].
  toCamera(nx, ny, nz) {
    const u = nx * this._cy - ny * this._sy;
    const v = nx * this._sy + ny * this._cy;
    return [u, v * this._cp + nz * this._sp, nz * this._cp - v * this._sp];
  }

  // Is a face with this world normal pointing toward the viewer?
  faces(nx, ny, nz) {
    return this.toCamera(nx, ny, nz)[1] > 1e-6;
  }

  // Lambert term in [0, 1] for a face with this world normal.
  light(nx, ny, nz) {
    const c = this.toCamera(nx, ny, nz);
    return Math.max(0, c[0] * LIGHT[0] + c[1] * LIGHT[1] + c[2] * LIGHT[2]);
  }

  // Screen-space bounds of world points at unit scale, origin at 0.
  bounds(points) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y, z] of points) {
      const u = x * this._cy - y * this._sy;
      const v = x * this._sy + y * this._cy;
      const sy = v * this._sp - z * this._cp;
      minX = Math.min(minX, u);
      maxX = Math.max(maxX, u);
      minY = Math.min(minY, sy);
      maxY = Math.max(maxY, sy);
    }
    return { minX, maxX, minY, maxY };
  }

  // Scale and origin that fit `points` inside a width x height viewport.
  fitTarget(width, height, points, pad = { top: 40, right: 40, bottom: 40, left: 40 }) {
    const b = this.bounds(points);
    const w = width - pad.left - pad.right;
    const h = height - pad.top - pad.bottom;
    const scale = Math.max(1, Math.min(w / (b.maxX - b.minX || 1), h / (b.maxY - b.minY || 1)));
    return {
      scale,
      cx: pad.left + w / 2 - (scale * (b.minX + b.maxX)) / 2,
      cy: pad.top + h / 2 - (scale * (b.minY + b.maxY)) / 2,
    };
  }
}

function normalize(v) {
  const l = Math.hypot(...v);
  return v.map((c) => c / l);
}
