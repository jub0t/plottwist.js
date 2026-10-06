// Compile-only check that the public types describe real usage.
// Run with: npm run test:types
import { IsoBarChart, IsoHexMap, IsoRegionMap, registerTheme, scales, type Frame } from 'plottwist';
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
});
regions.resolve('DE');
regions.on('click', (r) => r.feature.id);

registerTheme('brand', { extends: 'dark', series: ['#fff'] });
const blue: string[] = scales.blue;

export { hex, coord, blue };
