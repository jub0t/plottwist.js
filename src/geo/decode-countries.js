// Decodes the compact country modules built by scripts/build-countries.js
// into a GeoJSON FeatureCollection. Ids are ISO 3166 alpha-3 codes (or the
// name where there is none); properties carry name, iso2, iso3, isoNumeric.

export function decodeCountries({ TRANSFORM, ARCS, COUNTRIES }) {
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
  return {
    type: 'FeatureCollection',
    features: COUNTRIES.map(([name, iso2, iso3, isoNumeric, polys]) => ({
      type: 'Feature',
      id: iso3 || name,
      properties: { name, iso2, iso3, isoNumeric },
      geometry: { type: 'MultiPolygon', coordinates: polys.map((p) => p.map(ring)) },
    })),
  };
}
