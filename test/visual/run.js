// Visual regression tests: renders every case in test/visual/cases.html with
// headless Chrome and compares it with test/visual/baseline/<case>.png.
//
//   npm run test:visual            compare against baselines
//   npm run test:visual -- --update   accept the current renders as baselines
//   npm run test:visual -- bars map   only these cases
//
// On a mismatch it writes test/visual/__diff__/<case>.png (changed pixels in
// red) and <case>.actual.png. Baselines are rendered on macOS; other
// platforms rasterise text slightly differently, so run them where they were
// made (or regenerate them there).

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launch, root, serve } from '../../scripts/lib/chrome.js';

const MAX_CHANGED = 0.002; // fraction of pixels allowed to differ
const args = process.argv.slice(2);
const update = args.includes('--update');
const only = args.filter((a) => !a.startsWith('--'));
const baseDir = join(root, 'test/visual/baseline');
const diffDir = join(root, 'test/visual/__diff__');

const server = await serve();
const chrome = await launch({ width: 700, height: 500, scale: 1 });
let failed = 0;
try {
  await chrome.open(`${server.url}/test/visual/cases.html`, 'window.caseNames');
  const names = (await chrome.evaluate('window.caseNames')).filter((n) => !only.length || only.includes(n));
  await mkdir(baseDir, { recursive: true });
  await rm(diffDir, { recursive: true, force: true });

  for (const name of names) {
    const url = await chrome.evaluate(`window.render(${JSON.stringify(name)})`);
    const png = Buffer.from(url.split(',')[1], 'base64');
    const basePath = join(baseDir, `${name}.png`);

    const existed = existsSync(basePath);
    if (update || !existed) {
      await writeFile(basePath, png);
      console.log(`  ${existed ? 'updated' : 'new'}  ${name}`);
      continue;
    }
    const baseline = `data:image/png;base64,${(await readFile(basePath)).toString('base64')}`;
    const r = await chrome.evaluate(`window.compare(${JSON.stringify(name)}, ${JSON.stringify(baseline)})`);
    if (r.ratio <= MAX_CHANGED) {
      console.log(`  ok    ${name}${r.changed ? ` (${r.changed} px within tolerance)` : ''}`);
      continue;
    }
    failed++;
    await mkdir(diffDir, { recursive: true });
    await writeFile(join(diffDir, `${name}.actual.png`), png);
    if (r.diff) await writeFile(join(diffDir, `${name}.png`), Buffer.from(r.diff.split(',')[1], 'base64'));
    console.log(`  FAIL  ${name}: ${r.reason ?? `${(r.ratio * 100).toFixed(2)}% of pixels changed`}`);
  }
} finally {
  await chrome.close();
  server.close();
}

if (failed) {
  console.log(`\n${failed} visual case(s) changed; see test/visual/__diff__/. If intended: npm run test:visual -- --update`);
  process.exit(1);
}
