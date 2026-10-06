// Renders the README showcase image with headless Chrome:
//   docs/showcase.png   every demo chart on a transparent background
//
//   npm run showcase

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, root, serve } from './lib/chrome.js';

const server = await serve();
const chrome = await launch({ width: 1200, height: 2600, scale: 2 });
try {
  await chrome.open(`${server.url}/examples/showcase.html`, 'window.compose');
  const url = await chrome.evaluate('window.compose()');
  const png = Buffer.from(url.split(',')[1], 'base64');
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'showcase.png'), png);
  console.log(`wrote docs/showcase.png (${(png.length / 1024).toFixed(0)} KB)`);
} finally {
  await chrome.close();
  server.close();
}
