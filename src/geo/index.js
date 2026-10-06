// Geographic helpers: map projections (forward + inverse) and a land mask.
//
// Projections work in radians-free "projected units": forward(lon, lat) takes
// degrees and returns [x, y] with y pointing north; invert(x, y) returns
// [lon, lat] in degrees. Any object with that shape can be passed as a custom
// projection.

import { LAND_COLS, LAND_RES, LAND_ROWS, LAND_RLE } from './land.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

// Equal Earth (Šavrič, Patterson & Jenny, 2018): equal-area, pleasant shapes.
const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;
const M = Math.sqrt(3) / 2;

const equalEarth = {
  forward(lon, lat) {
    const l = lon * RAD;
    const t = Math.asin(M * Math.sin(lat * RAD));
    const t2 = t * t;
    const t6 = t2 * t2 * t2;
    return [
      (l * Math.cos(t)) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))),
      t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)),
    ];
  },
  invert(x, y) {
    // Newton's method for the parametric latitude.
    let t = y;
    for (let i = 0; i < 12; i++) {
      const t2 = t * t;
      const t6 = t2 * t2 * t2;
      const f = t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)) - y;
      const fp = A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2);
      const dt = f / fp;
      t -= dt;
      if (Math.abs(dt) < 1e-10) break;
    }
    const t2 = t * t;
    const t6 = t2 * t2 * t2;
    const fp = A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2);
    return [((M * x * fp) / Math.cos(t)) * DEG, Math.asin(Math.sin(t) / M) * DEG];
  },
};

const MERCATOR_LIMIT = 85.0511;

export const projections = {
  equalEarth,
  mercator: {
    forward(lon, lat) {
      const p = Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, lat)) * RAD;
      return [lon * RAD, Math.log(Math.tan(Math.PI / 4 + p / 2))];
    },
    invert(x, y) {
      return [x * DEG, (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * DEG];
    },
  },
  equirectangular: {
    forward: (lon, lat) => [lon * RAD, lat * RAD],
    invert: (x, y) => [x * DEG, y * DEG],
  },
};

export function resolveProjection(p = 'equalEarth') {
  if (typeof p === 'string') {
    if (!projections[p]) throw new Error(`plottwist: unknown projection "${p}"`);
    return projections[p];
  }
  return p;
}

// ---- land mask ------------------------------------------------------------------

let mask = null;

// Decode the run-length mask once, lazily: one byte per LAND_RES° cell.
export function landMask() {
  if (mask) return mask;
  mask = new Uint8Array(LAND_COLS * LAND_ROWS);
  LAND_RLE.split(';').forEach((row, r) => {
    let c = r * LAND_COLS;
    let land = 0;
    for (const run of row.split(',')) {
      const n = parseInt(run, 36);
      if (land) mask.fill(1, c, c + n);
      c += n;
      land ^= 1;
    }
  });
  return mask;
}

// Is there land at this coordinate? (Resolution LAND_RES degrees.)
export function isLand(lon, lat) {
  const c = Math.floor((((lon + 180) % 360) + 360) % 360 / LAND_RES);
  const r = Math.floor((90 - lat) / LAND_RES);
  if (r < 0 || r >= LAND_ROWS) return false;
  return landMask()[r * LAND_COLS + Math.min(LAND_COLS - 1, c)] === 1;
}

// Visit every mask cell centre inside [west, south, east, north]:
// fn(lon, lat, isLand).
export function forEachCell([west, south, east, north], fn) {
  const m = landMask();
  for (let r = 0; r < LAND_ROWS; r++) {
    const lat = 90 - (r + 0.5) * LAND_RES;
    if (lat < south || lat > north) continue;
    for (let c = 0; c < LAND_COLS; c++) {
      const lon = -180 + (c + 0.5) * LAND_RES;
      if (lon < west || lon > east) continue;
      fn(lon, lat, m[r * LAND_COLS + c] === 1);
    }
  }
}

export { LAND_RES };
