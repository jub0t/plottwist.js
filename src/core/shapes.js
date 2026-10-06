// Shared 3D primitives drawn through the camera + renderer, styled by theme
// tokens (ambient/diffuse lighting, face gradients, edge highlights, bloom).

import { shade } from './color.js';

export function faceBrightness(camera, theme, normal, glow = 1) {
  return (theme.ambient + theme.diffuse * camera.light(...normal)) * glow;
}

export function faceShade(camera, theme, normal, rgb, glow = 1) {
  return shade(rgb, faceBrightness(camera, theme, normal, glow));
}

// Axis-aligned box. Draws only the faces turned toward the viewer and
// returns their screen polygons for hit testing.
//   glow:  brightness multiplier (hover lift)
//   bloom: 0..1 halo strength around the top face
export function drawBox(camera, renderer, theme, { x0, x1, y0, y1, z0, z1 }, rgb, { glow = 1, bloom = 0 } = {}) {
  const P = (x, y, z) => camera.project(x, y, z);
  const ctx = renderer.ctx;
  const hits = [];
  const g = theme.gradient;
  const topPts = [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)];

  // Bloom: a soft glow drawn behind the box, sized to its top face.
  if (bloom > 0) {
    const cx = (topPts[0].x + topPts[2].x) / 2;
    const cy = (topPts[0].y + topPts[2].y) / 2;
    const w = Math.max(Math.abs(topPts[0].x - topPts[2].x), Math.abs(topPts[1].x - topPts[3].x));
    const size = w * (2.2 + 1.2 * bloom);
    renderer.glow(rgb, cx, cy, size, size * 0.8, 0.55 * bloom);
  }

  const sides = [
    [[1, 0, 0], () => [P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)]],
    [[-1, 0, 0], () => [P(x0, y1, z0), P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1)]],
    [[0, 1, 0], () => [P(x1, y1, z0), P(x0, y1, z0), P(x0, y1, z1), P(x1, y1, z1)]],
    [[0, -1, 0], () => [P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)]],
  ];
  for (const [n, points] of sides) {
    if (!camera.faces(...n)) continue;
    const pts = points();
    const k = faceBrightness(camera, theme, n, glow);
    let fill = shade(rgb, k);
    // Gradients are only worth building on faces big enough to show them.
    if (g > 0 && Math.abs(pts[0].y - pts[3].y) > 10) {
      // Darker at the base, brighter toward the lit top edge.
      const grad = ctx.createLinearGradient(0, pts[0].y, 0, pts[3].y);
      grad.addColorStop(0, shade(rgb, k * (1 - 0.45 * g)));
      grad.addColorStop(1, shade(rgb, k * (1 + 0.12 * g)));
      fill = grad;
    }
    // Stroke in the fill hides anti-aliasing seams between faces.
    renderer.polygon(pts, fill, fill, 0.75);
    hits.push(pts);
  }

  const top = [0, 0, 1];
  if (camera.faces(...top)) {
    const k = faceBrightness(camera, theme, top, glow) * (1 + 0.1 * g);
    const fill = shade(rgb, k);
    renderer.polygon(topPts, fill, fill, 0.75);
    // Edge highlights only read on faces of a decent size.
    if (theme.edge > 0 && Math.abs(topPts[0].x - topPts[2].x) + Math.abs(topPts[1].x - topPts[3].x) > 24) {
      renderer.polygon(topPts, null, shade(rgb, 1.45, theme.edge), 1);
    }
    hits.push(topPts);
  }
  return hits;
}
