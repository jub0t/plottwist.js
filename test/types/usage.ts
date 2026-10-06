// Compile-only check that the public types describe real usage.
// Run with: npm run test:types
import { IsoBarChart, IsoHexMap, IsoRaceChart, IsoRegionMap, registerTheme, scales, topojsonFeatures, type Frame, type TopoJSONTopology } from 'plottwist';
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
