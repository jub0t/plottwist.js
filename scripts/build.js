// Builds browser bundles into dist/ with esbuild (a dev dependency; the
// library itself has no runtime dependencies):
//
//   dist/plottwist.js             ES module bundle
//   dist/plottwist.min.js         ES module, minified
//   dist/plottwist.iife.min.js    <script> build, global `plottwist`
//   dist/countries.min.js         ES module: worldCountries()
//   dist/countries.iife.min.js    <script> build, global `plottwistCountries`
//
// npm consumers import the unbundled ES modules in src/ directly; these are
// for CDNs and plain <script> tags.

import { build } from 'esbuild';
import { readFile, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { root } from './lib/chrome.js';

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const banner = `/*! plottwist ${pkg.version} | ${pkg.license} | Land and country data: Natural Earth (public domain) */`;
const dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true });

const targets = [
  { entry: 'src/index.js', out: 'plottwist.js', format: 'esm', minify: false },
  { entry: 'src/index.js', out: 'plottwist.min.js', format: 'esm', minify: true },
  { entry: 'src/index.js', out: 'plottwist.iife.min.js', format: 'iife', minify: true, globalName: 'plottwist' },
  { entry: 'src/geo/countries.js', out: 'countries.min.js', format: 'esm', minify: true },
  { entry: 'src/geo/countries.js', out: 'countries.iife.min.js', format: 'iife', minify: true, globalName: 'plottwistCountries' },
];

for (const t of targets) {
  await build({
    entryPoints: [join(root, t.entry)],
    outfile: join(dist, t.out),
    bundle: true,
    format: t.format,
    globalName: t.globalName,
    minify: t.minify,
    sourcemap: t.minify,
    target: 'es2022',
    banner: { js: banner },
    legalComments: 'none',
    keepNames: true, // readable class names in stack traces and devtools
  });
  const code = await readFile(join(dist, t.out));
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`${t.out.padEnd(24)} ${kb(code.length).padStart(9)}  ${kb(gzipSync(code).length).padStart(8)} gzip`);
}
