// Compile-only check that the public types describe real usage.
// Run with: npm run test:types
import { IsoBarChart, IsoHexMap, IsoRaceChart, IsoRegionMap, IsoSurface, IsoWaffleChart, IsoHelixChart, IsoTankChart, IsoGaltonChart, IsoBalanceChart, IsoIcebergChart, registerTheme, scales, topojsonFeatures, type Frame, type TopoJSONTopology } from 'plottwist';
import { worldCountries } from 'plottwist/geo/countries';

interface Row {
  region: string;
  platform: string;
  users: number;
}
const frames: Frame<Row>[] = [{ label: 2025, data: [{ region: 'EU', platform: 'Web', users: 3 }] }];

const bars = new IsoBarChart<Row>('#chart', {
  frames,
  x: 'region',
  y: 'platform',
  value: (d) => d.users,
  labels: 5,
  reference: { value: 40, label: 'Target' },
  axis: { ticks: 5 },
  theme: { extends: 'midnight', glow: 0.4 },
  colors: { Web: '#7c5cff' },
});
bars.on('hover', (part) => part?.cell.total.toFixed(1));
bars.on('frame', ({ position }) => position + 1);
bars.setView('front');
bars.setReference(null);
bars.seek(0.5);

// @ts-expect-error: 'nope' is not a field of Row
new IsoBarChart<Row>('#x', { x: 'nope' });

const map = new IsoHexMap<{ lon: number; lat: number; n: number }>('#map', {
  data: [{ lon: 2.35, lat: 48.86, n: 1 }],
  value: 'n',
  rounding: 0.5,
  projection: 'mercator',
  colorScale: 'emerald',
});
const hex = map.hexAt(2.35, 48.86);
const coord: [number, number] | null = map.invert(10, 10);
map.reconfigure({ columns: 120 });

const regions = new IsoRegionMap<{ country: string; gdp: number }>('#regions', {
  regions: worldCountries(),
  key: 'country',
  value: 'gdp',
  arcs: [{ from: 'USA', to: [2.35, 48.86] }],
  borderWidth: 1.5,
  edgeColor: 'none',
  detail: 0.8,
  bounds: [-25, 34, 45, 71],
});
regions.resolve('DE');
declare const usAtlas: TopoJSONTopology;
regions.drill(usAtlas, { object: 'states', key: 'state', data: [], bounds: [-125, 24, -66, 50] });
regions.on('drill', ({ depth }) => depth);
regions.drillUp();
const stores = new IsoRegionMap<{ lng: number; lat: number; sales: number }>('#stores', {
  regions: usAtlas,
  object: 'counties',
  lon: 'lng',
  lat: 'lat',
  value: 'sales',
  filter: (f) => String(f.id).startsWith('06'),
  regionName: (f, id) => String(f.properties?.name ?? id),
});
topojsonFeatures(usAtlas, 'states').features.length;
stores.depth;
regions.on('click', (r) => r.feature.id);

const race = new IsoRaceChart<{ name: string; users: number; genre: string }>('#race', {
  frames: [{ label: 2025, data: [{ name: 'Kite', users: 179, genre: 'Social' }] }],
  value: 'users',
  color: 'genre',
  top: 8,
});
race.standings[0]?.key;
race.on('hover', (bar) => bar?.rank);

registerTheme('brand', { extends: 'dark', series: ['#fff'] });
const blue: string[] = scales.blue;

export { hex, coord, blue };

// Export options are checked.
async function exportUsage(chart: IsoBarChart<{ region: string; platform: string; users: number }>) {
  const blob: Blob = await chart.export({ format: 'gif', width: 640, fps: 15, onProgress: (f: number) => f });
  await chart.export({ format: 'webm', orbit: 1, signal: new AbortController().signal });
  // @ts-expect-error unknown format
  await chart.export({ format: 'avi' });
  return blob;
}
export { exportUsage };

// Waffle: accessors are checked against the record type.
const mix = new IsoWaffleChart<{ source: string; twh: number }>('#w', { data: [{ source: 'Coal', twh: 3 }], key: 'source', value: 'twh', unit: 2 });
mix.on('hover', (c) => c?.key);
// @ts-expect-error not a field of the record
new IsoWaffleChart<{ source: string; twh: number }>('#w', { key: 'nope' });
export { mix };

const terrain = new IsoSurface<{ x: number; y: number; q: number }>('#s', { data: [], value: 'q', contours: [25, 50, 75], mesh: true });
// @ts-expect-error contours must be a count, list or false
new IsoSurface('#s', { contours: 'many' });
export { terrain };

terrain.reconfigure({ water: { value: 30, label: 'Sea' }, smooth: 3, bands: true, style: 'wireframe', float: 1, peaks: 2 });

const coil = new IsoHelixChart<{ week: Date; rides: number }>('#h', { data: [], date: 'week', value: 'rides', cycle: 'year' });
coil.on('hover', (p) => (p ? coil.previousCycle(p)?.value : null));
// @ts-expect-error unknown cycle
new IsoHelixChart('#h', { cycle: 'month' });
export { coil };

const reservoirs = new IsoTankChart<{ name: string; gl: number; cap: number }>('#t', { data: [], value: 'gl', capacity: 'cap', target: 80, alertColor: false });
reservoirs.on('hover', (t) => t?.level);
export { reservoirs };

const board = new IsoGaltonChart<{ minutes: number; mode: string }>('#g', { data: [], value: 'minutes', color: 'mode', bins: 12, domain: [0, 60] });
board.on('hover', (b) => (b ? board.counts[b.bin] : 0));
export { board };
terrain.reconfigure({ haze: 0.5, occlusion: 0.4, contourStyle: 'illuminated', contourLabels: true, shadows: true, shadowAngle: 20, colorScale: 'terrain' });

const scale = new IsoBalanceChart<{ side: string; dept: string; k: number }>('#b', { data: [], key: 'dept', value: 'k', sensitivity: 4 });
scale.on('hover', (h) => (h?.kind === 'item' ? h.key : h?.index));
export { scale };

const bergs = new IsoIcebergChart<{ area: string; seen: number; hidden: number }>('#i', { data: [], key: 'area', above: 'seen', below: 'hidden' });
bergs.on('hover', (b) => b?.values[1]);
export { bergs };
terrain.reconfigure({ preset: 'glossy', lighting: { specular: 0.6, shininess: 40, rim: 0.3, azimuth: -120 }, cut: { below: -5 }, opacity: 0.9 });
terrain.reconfigure({ style: 'voxel', voxel: { step: 5, resolution: 2 }, mesh: 'triangles', meshStep: 2, colorScale: 'aurora', floor: false });
