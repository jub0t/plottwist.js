# plottwist.js

Isometric, animated, interactive charts for the web. Zero runtime dependencies, Canvas 2D.

```js
import { IsoBarChart, IsoHexMap } from 'plottwist';

const bars = new IsoBarChart('#chart', {
  frames: [{ label: 2024, data: [...] }, { label: 2025, data: [...] }],
  x: 'region',
  y: 'platform',
  value: 'users',
});
bars.play();

const map = new IsoHexMap('#map', {
  data: [{ lon: 2.35, lat: 48.86, value: 120 }, ...],
  rounding: 0.45, // 0 = sharp hexes, 1 = nearly round
  columns: 110,   // hexes across the map
  callouts: 5,
});
map.project(-74, 40.7); // screen position of a coordinate
map.hexAt(-74, 40.7);   // the hex containing it
```

## Charts

- `IsoBarChart`: grouped or stacked (`stack`) 3D bars on a categorical grid
- `IsoHeatmap`: extruded tiles on a sequential scale, e.g. a contribution calendar
- `IsoRibbonChart`: one extruded ribbon per series, x along the floor
- `IsoHexMap`: rounded hexagons over the world (or `bounds`), data binned by exact coordinates; arcs and callouts

All charts support `frames` + `play()/pause()/seek()`, view presets (`setView('iso' | 'top' | 'front')`),
orbit/zoom, hover tooltips and `on('hover' | 'click' | 'frame')`.

## Theming

Canvases are transparent: the page owns the background. Presets are `midnight` (default) and `dark`.

```js
registerTheme('brand', { extends: 'midnight', series: ['#7c5cff', '#ff4f9a'], glow: 0.6, gridStyle: 'dots' });
new IsoBarChart(el, { data, theme: 'brand', grid: 'none', colors: { Online: '#7c5cff' } });
```

## Development

```sh
npm run dev   # http://localhost:5173/examples/ with live reload
node scripts/build-land.js   # regenerate src/geo/land.js from Natural Earth
```

Land data: [Natural Earth](https://www.naturalearthdata.com/) (public domain) via
[world-atlas](https://github.com/topojson/world-atlas) (ISC).
