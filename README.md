# plottwist.js

Isometric, animated, interactive charts for the web. Zero dependencies, Canvas 2D.

```js
import { IsoBarChart } from 'plottwist';

const chart = new IsoBarChart('#chart', {
  frames: [{ label: 2024, data: [...] }, { label: 2025, data: [...] }],
  x: 'region',
  y: 'platform',
  value: 'users',
});
chart.play();
```

## Development

```sh
npm run dev   # http://localhost:5173/examples/ with live reload
```

## Layout

- `src/core/camera.js`: orthographic orbit camera, projection, face culling, lighting
- `src/core/renderer.js`: HiDPI canvas, polygons and text, hit testing
- `src/core/animation.js`: easing, `Tween`, `Timeline` (fractional frame playback)
- `src/core/chart.js`: base class with render loop, orbit/zoom/keyboard, tooltip, events
- `src/charts/IsoBarChart.js`: 3D bar grid with temporal interpolation
