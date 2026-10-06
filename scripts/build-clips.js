// Renders the README clips with headless Chrome (see examples/clips.html):
//   docs/race.gif        the bar chart race
//   docs/drilldown.gif   region map: world -> United States -> California
//
//   npm run clips            all clips
//   npm run clips -- race    just these

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, root, serve } from './lib/chrome.js';

const only = process.argv.slice(2);
const server = await serve();
const chrome = await launch({ width: 800, height: 600, scale: 1 });
try {
  await chrome.open(`${server.url}/examples/clips.html`, 'window.clipNames');
  const names = (await chrome.evaluate('window.clipNames')).filter((n) => !only.length || only.includes(n));
  for (const name of names) {
    const r = await chrome.evaluate(`window.clip(${JSON.stringify(name)})`);
    const ext = r.type.split('/')[1];
    const data = Buffer.from(await chrome.readString('window.lastData', r.chars), 'base64');
    await writeFile(join(root, 'docs', `${name}.${ext}`), data);
    console.log(`wrote docs/${name}.${ext} (${(data.length / 1024).toFixed(0)} KB)`);
  }
} finally {
  await chrome.close();
  server.close();
}
