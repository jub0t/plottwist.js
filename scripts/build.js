// Builds browser bundles into dist/ with esbuild (a dev dependency; the
// library itself has no runtime dependencies):
//
//   dist/plottwist.js             ES module bundle
//   dist/plottwist.min.js         ES module, minified
//   dist/chunks/export-*.js       the export() encoders, loaded on first use
//   dist/plottwist.iife.min.js    <script> build, global `plottwist` (all in one file)
//   dist/countries.min.js         ES module: worldCountries()
//   dist/countries.iife.min.js    <script> build, global `plottwistCountries`
//
// npm consumers import the unbundled ES modules in src/ directly; these are
// for CDNs and plain <script> tags. No source maps: the readable bundle is
// right there.

import { build } from 'esbuild';
import { readFile, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join, relative } from 'node:path';
import { root } from './lib/chrome.js';

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const banner = `/*! plottwist ${pkg.version} | ${pkg.license} | Land and country data: Natural Earth (public domain) */`;
const dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true });

const targets = [
  { entry: 'src/index.js', name: 'plottwist', format: 'esm', minify: false, split: true },
  { entry: 'src/index.js', name: 'plottwist.min', format: 'esm', minify: true, split: true },
  { entry: 'src/index.js', name: 'plottwist.iife.min', format: 'iife', minify: true, globalName: 'plottwist' },
  { entry: 'src/geo/countries.js', name: 'countries.min', format: 'esm', minify: true },
  { entry: 'src/geo/countries.js', name: 'countries.iife.min', format: 'iife', minify: true, globalName: 'plottwistCountries' },
];

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
for (const t of targets) {
  const result = await build({
    entryPoints: { [t.name]: join(root, t.entry) },
    outdir: dist,
    // ES module builds split dynamic imports (the export encoders) into
    // chunks the browser fetches only when needed.
    splitting: !!t.split,
    chunkNames: `chunks/[name]${t.minify ? '.min' : ''}-[hash]`,
    bundle: true,
    format: t.format,
    globalName: t.globalName,
    minify: t.minify,
    target: 'es2022',
    banner: { js: banner },
    legalComments: 'none',
    keepNames: true, // readable class names in stack traces and devtools
    metafile: true,
  });
  for (const out of Object.keys(result.metafile.outputs)) {
    const code = await readFile(join(root, out));
    const name = relative(dist, join(root, out));
    console.log(`${name.padEnd(36)} ${kb(code.length).padStart(9)}  ${kb(gzipSync(code).length).padStart(8)} gzip`);
  }
}
