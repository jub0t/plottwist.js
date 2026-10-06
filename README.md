# plottwist.js

Isometric, animated, interactive charts for the web. Zero runtime dependencies, Canvas 2D.

<img alt="plottwist charts: hex and region maps, 3D bars, stacked blocks, ribbons, a bar chart race, a calendar heatmap, a terrain surface in voxel and wireframe styles, a seasonal helix, a Galton board, a cube waffle, liquid tanks, a balance scale and icebergs" src="https://raw.githubusercontent.com/jub0t/plottwist.js/main/docs/preview.png" />

<p>
  <img width="49%" alt="A 3D bar chart race of app users from 2010 to 2025" src="https://raw.githubusercontent.com/jub0t/plottwist.js/main/docs/race.webp" />
  <img width="49%" alt="A region map drilling from the world into US states, then California counties" src="https://raw.githubusercontent.com/jub0t/plottwist.js/main/docs/drilldown.webp" />
</p>

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

## Install

```sh
npm install plottwist
```

Or without a build step:

```html
<script src="https://cdn.jsdelivr.net/npm/plottwist/dist/plottwist.iife.min.js"></script>
<script>
  new plottwist.IsoBarChart('#chart', { data });
</script>
```

TypeScript types are included; charts are generic over your record type, so accessors like
`x: 'region'` are checked against your data.

## Charts

- `IsoBarChart`: grouped or stacked (`stack`) 3D bars on a categorical grid
- `IsoHeatmap`: extruded tiles on a sequential scale, e.g. a contribution calendar
- `IsoRibbonChart`: one extruded ribbon per series, x along the floor
- `IsoHexMap`: rounded hexagons over the world (or `bounds`), data binned by exact coordinates; arcs and callouts
- `IsoRegionMap`: regions at any level (countries, states, provinces, counties, districts, territories)
  extruded by value, a 3D choropleth. See below.
- `IsoSurface`: a lit terrain over a grid of values, drawn with cartographic relief conventions:
  aerial-perspective haze, valley occlusion, illuminated (Tanaka) contours with index lines, and
  optional cast `shadows` and a natural `'terrain'` palette. Styles include topo bands, wireframe, a
  `water` level that floods the lows, a `float`ing model over its own map, and labelled `peaks`
- `IsoWaffleChart`: a stack of cubes per category, one per `unit`; between frames, cubes fly from
  shrinking stacks to growing ones
- `IsoTankChart`: values as liquid in glass tanks with `capacity` and `target`; changes pour in,
  overshoot and slosh, and tanks below target change colour
- `IsoHelixChart`: a time series coiled one turn per year (or week, or day), so the same point in
  every cycle lines up vertically; hovering compares with the cycle below
- `IsoGaltonChart`: a histogram that builds itself, one ball per record falling through pegs into
  its bin
- `IsoBalanceChart`: two sides on a balance scale, items stacked on each pan; the beam leans toward
  the heavier side by the relative difference and rocks when the data changes
- `IsoIcebergChart`: what's seen and what's hidden, as icebergs split at the waterline with heights
  to scale; bergs rise, sink and bob as the share changes

Grid charts get a value axis on back walls that follow the camera (`axis: false` to hide), a dashed
level line from the hovered mark to the axis, value labels (`labels: true | N`) and a reference
plane (`reference: { value, label }`) that bars rise through.

All charts support `frames` + `play()/pause()/seek()`, view presets (`setView('iso' | 'top' | 'front')`),
orbit/zoom, hover tooltips and `on('hover' | 'click' | 'frame')`.

## Region maps at any level

`IsoRegionMap` draws whatever regions you give it, as GeoJSON or TopoJSON:

```js
import { IsoRegionMap } from 'plottwist';
import { worldCountries } from 'plottwist/geo/countries'; // or 'plottwist/geo/countries-50m' (crisper)

// Countries, joined on ISO codes or names ('DE', 'DEU', '276' and 'Germany' all match).
const map = new IsoRegionMap(el, { regions: worldCountries(), data, key: 'country', value: 'gdp' });

// Your own boundaries: provinces, counties, districts, sales territories...
new IsoRegionMap(el, {
  regions: usAtlas,              // TopoJSON works directly
  object: 'counties',            // which layer
  filter: (f) => f.id.startsWith('06'),
  regionName: (f) => f.properties.NAME_2,
  lon: 'lng', lat: 'lat',        // no region key? records land in the region containing them
  data: stores,
});

// Drill between levels; drillUp() goes back.
map.on('click', (region) => map.drill(statesOf(region), { key: 'state', data: stateData }));
```

`bounds` crops (and clips) to a box, `detail` trades shape detail for speed, and `borderWidth`,
`borderColor`, `edgeWidth` and `edgeColor` style the strokes. `topojsonFeatures(topology, object)`
converts TopoJSON for other uses.

## Video, GIF and PNG export

```js
const mp4 = await chart.export({ format: 'mp4' });            // one pass through the frames
const gif = await chart.export({ format: 'gif', width: 640 }); // smaller, loops anywhere
const webp = await chart.export({ format: 'webp' });          // animated, transparent background
const spin = await map.export({ format: 'webm', orbit: 1, duration: 8000 });
const png = await chart.export({ format: 'png' });            // transparent still
```

Script a clip with `onFrame`, which runs before each frame on the clip's clock (the drill-down above
is made this way, see `examples/clips.html`):

```js
await map.export({
  format: 'webp',
  duration: 9000,
  onFrame: ({ time, chart }) => {
    if (time >= 2200 && chart.depth === 0) chart.drill(usStates, { key: 'state', data: stateData });
  },
});
```

Export steps the chart on its own clock, so every clip is frame-exact regardless of machine speed.
Video is encoded with WebCodecs and muxed in the library (falling back to `MediaRecorder` where
WebCodecs is missing); the encoders load only on first use.

## Theming

Canvases are transparent: the page owns the background. Presets are `midnight` (default) and `dark`.

```js
registerTheme('brand', { extends: 'midnight', series: ['#7c5cff', '#ff4f9a'], glow: 0.6, gridStyle: 'dots' });
new IsoBarChart(el, { data, theme: 'brand', grid: 'none', colors: { Online: '#7c5cff' } });
```

## Development

```sh
npm run dev   # http://localhost:5173/examples/ with live reload
npm test                     # unit tests
npm run test:types           # type definitions against example usage
npm run test:visual          # pixel comparison with test/visual/baseline (-- --update to accept)
npm run test:export          # export every format and check it decodes (uses ffprobe if installed)
npm run build                # dist/ bundles
npm run showcase             # re-render the README image (docs/preview.png)
npm run clips                # re-render the README clips (docs/*.webp, transparent)
node scripts/build-land.js   # regenerate src/geo/land.js from Natural Earth
node scripts/build-countries.js  # regenerate src/geo/countries-data.js
```

Land data: [Natural Earth](https://www.naturalearthdata.com/) (public domain) via
[world-atlas](https://github.com/topojson/world-atlas) (ISC).
