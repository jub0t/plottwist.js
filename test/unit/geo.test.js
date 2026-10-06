import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isLand, landMask, projections, resolveProjection } from '../../src/geo/index.js';
import { LAND_COLS, LAND_ROWS } from '../../src/geo/land.js';
import { worldCountries } from '../../src/geo/countries.js';

test('every projection inverts its forward mapping', () => {
  for (const [name, p] of Object.entries(projections)) {
    let worst = 0;
    for (let lon = -179; lon <= 179; lon += 7.3) {
      for (let lat = -80; lat <= 80; lat += 6.1) {
        const [x, y] = p.forward(lon, lat);
        const [a, b] = p.invert(x, y);
        worst = Math.max(worst, Math.abs(a - lon), Math.abs(b - lat));
      }
    }
    assert.ok(worst < 1e-9, `${name} round-trip error ${worst}`);
  }
});

test('projections put the origin at 0,0 and keep north up', () => {
  for (const p of Object.values(projections)) {
    const [x, y] = p.forward(0, 0);
    assert.ok(Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12);
    assert.ok(p.forward(0, 45)[1] > 0);
    assert.ok(p.forward(90, 0)[0] > 0);
  }
  assert.equal(resolveProjection('mercator'), projections.mercator);
  assert.throws(() => resolveProjection('nope'), /unknown projection/);
});

test('land mask knows land from sea', () => {
  const land = [[2.35, 48.85], [151.2, -33.87], [139.7, 35.7], [10, 23], [-100, 40], [-60, -10]];
  const sea = [[-30, 30], [-150, 0], [70, -20], [160, 40], [0, 0]];
  for (const [lon, lat] of land) assert.ok(isLand(lon, lat), `${lon},${lat} should be land`);
  for (const [lon, lat] of sea) assert.ok(!isLand(lon, lat), `${lon},${lat} should be sea`);
  assert.equal(landMask().length, LAND_COLS * LAND_ROWS);
  // Earth is about 29% land on an equirectangular grid (Antarctica included).
  const share = landMask().reduce((a, b) => a + b, 0) / landMask().length;
  assert.ok(share > 0.25 && share < 0.33, `land share ${share}`);
});

test('world countries decode to valid GeoJSON with ISO codes', () => {
  const fc = worldCountries();
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 177);
  const ids = fc.features.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const f of fc.features) {
    assert.equal(f.geometry.type, 'MultiPolygon');
    for (const poly of f.geometry.coordinates) {
      for (const ring of poly) {
        assert.ok(ring.length >= 4, `${f.id} ring too short`);
        assert.deepEqual(ring[0], ring.at(-1), `${f.id} ring not closed`);
        for (const [lon, lat] of ring) assert.ok(Math.abs(lon) <= 180 && Math.abs(lat) <= 90);
      }
    }
  }
  const fra = fc.features.find((f) => f.id === 'FRA');
  assert.deepEqual(fra.properties, { name: 'France', iso2: 'FR', iso3: 'FRA', isoNumeric: '250' });
  assert.equal(worldCountries(), fc, 'decoded once and cached');
});
