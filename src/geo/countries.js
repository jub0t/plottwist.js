// World countries as a GeoJSON FeatureCollection, decoded lazily from the
// compact module built by scripts/build-countries.js. Import this only when
// you need it; the rest of the library doesn't depend on it.
//
//   import { worldCountries } from 'plottwist/geo/countries';
//   new IsoRegionMap(el, { regions: worldCountries(), ... });
//
// Feature ids are ISO 3166 alpha-3 codes; properties carry name, iso2, iso3
// and isoNumeric, so data can join on any of them.

import { ARCS, COUNTRIES, TRANSFORM } from './countries-data.js';

let cache = null;

export function worldCountries() {
  if (cache) return cache;
  const { scale, translate } = TRANSFORM;
  const arcs = ARCS.split(';').map((arc) => {
    let x = 0;
    let y = 0;
    return arc.split(',').map((pt) => {
      const [dx, dy] = pt.split(' ');
      x += parseInt(dx, 36);
      y += parseInt(dy, 36);
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  });
  // A ring is a chain of arcs; ~i walks arc i backwards. Consecutive arcs
  // share their joining point, so drop each arc's first point after the first.
  const ring = (indexes) => {
    const out = [];
    indexes.forEach((i, k) => {
      const pts = i >= 0 ? arcs[i] : [...arcs[~i]].reverse();
      out.push(...(k ? pts.slice(1) : pts));
    });
    return out;
  };
  cache = {
    type: 'FeatureCollection',
    features: COUNTRIES.map(([name, iso2, iso3, isoNumeric, polys]) => ({
      type: 'Feature',
      id: iso3 || name,
      properties: { name, iso2, iso3, isoNumeric },
      geometry: { type: 'MultiPolygon', coordinates: polys.map((p) => p.map(ring)) },
    })),
  };
  return cache;
}
