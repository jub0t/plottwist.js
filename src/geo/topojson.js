// TopoJSON -> GeoJSON for polygon layers, so administrative boundary data
// (states, provinces, counties, districts...) can be passed to IsoRegionMap
// as it's usually published.
//
//   import { topojsonFeatures } from 'plottwist';
//   const states = topojsonFeatures(usAtlas, 'states');
//
// Handles quantized (transform) and plain topologies, Polygon, MultiPolygon
// and nested GeometryCollection; ids and properties are kept. Points and
// lines are skipped.

export function topojsonFeatures(topology, object) {
  if (topology?.type !== 'Topology') throw new Error('plottwist: not a TopoJSON Topology');
  const name = object ?? Object.keys(topology.objects)[0];
  const root = topology.objects[name];
  if (!root) {
    throw new Error(`plottwist: TopoJSON has no object "${name}" (has ${Object.keys(topology.objects).join(', ')})`);
  }

  const arcs = decodeArcs(topology);
  const ring = (indexes) => {
    const out = [];
    indexes.forEach((i, k) => {
      const pts = i >= 0 ? arcs[i] : [...arcs[~i]].reverse();
      // Consecutive arcs share their joining point.
      for (let j = k ? 1 : 0; j < pts.length; j++) out.push(pts[j]);
    });
    return out;
  };

  const features = [];
  const visit = (g) => {
    if (g.type === 'GeometryCollection') return g.geometries.forEach(visit);
    let geometry = null;
    if (g.type === 'Polygon') geometry = { type: 'Polygon', coordinates: g.arcs.map(ring) };
    else if (g.type === 'MultiPolygon') geometry = { type: 'MultiPolygon', coordinates: g.arcs.map((p) => p.map(ring)) };
    if (!geometry) return;
    const feature = { type: 'Feature', properties: g.properties ?? {}, geometry };
    if (g.id !== undefined) feature.id = g.id;
    features.push(feature);
  };
  visit(root);
  return { type: 'FeatureCollection', features };
}

function decodeArcs({ arcs, transform }) {
  if (!transform) return arcs;
  const [sx, sy] = transform.scale;
  const [tx, ty] = transform.translate;
  return arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty];
    });
  });
}
