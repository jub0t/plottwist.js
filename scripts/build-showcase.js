// Renders the README showcase images with headless Chrome:
//   docs/showcase-dark.png   charts on a transparent background (GitHub dark)
//   docs/showcase-light.png  the same on a midnight card (GitHub light)
//
//   npm run showcase
//
// Uses the Chrome DevTools Protocol directly (no dependencies). Set
// CHROME_PATH if Chrome isn't in the default macOS location.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const chromePath =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Static file server for the repo.
const server = createServer(async (req, res) => {
  const file = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const profile = await mkdtemp(join(tmpdir(), 'plottwist-showcase-'));
const debugPort = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      target = list.find((t) => t.type === 'page');
    } catch {}
  }
  if (!target) throw new Error('Chrome did not start (set CHROME_PATH?)');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    pending.get(d.id)?.(d);
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      pending.set(++id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
    return r.result.result.value;
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1600, deviceScaleFactor: 2, mobile: false });
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/examples/showcase.html` });
  for (let i = 0; i < 50 && !(await evaluate('!!window.compose')); i++) await sleep(200);

  await mkdir(join(root, 'docs'), { recursive: true });
  for (const [variant, name] of [['transparent', 'showcase-dark.png'], ['card', 'showcase-light.png']]) {
    const url = await evaluate(`window.compose(${JSON.stringify(variant)})`);
    const png = Buffer.from(url.split(',')[1], 'base64');
    await writeFile(join(root, 'docs', name), png);
    console.log(`wrote docs/${name} (${(png.length / 1024).toFixed(0)} KB)`);
  }
  ws.close();
} finally {
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  await exited; // Chrome writes to its profile until it exits
  server.close();
  await rm(profile, { recursive: true, force: true });
}
