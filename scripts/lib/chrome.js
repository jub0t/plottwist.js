// Minimal headless-Chrome driver over the DevTools Protocol, plus a static
// file server for the repo. Shared by the showcase build and visual tests;
// no dependencies. Set CHROME_PATH if Chrome isn't in the default location.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '../..');

const CHROME_PATHS = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
};
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serve the repo on a random port. Returns { url, close }.
export async function serve() {
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
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

// Launch Chrome and open one page. Returns { open, evaluate, close }.
export async function launch({ width = 1200, height = 900, scale = 2 } = {}) {
  const chromePath = process.env.CHROME_PATH ?? CHROME_PATHS[process.platform];
  const profile = await mkdtemp(join(tmpdir(), 'plottwist-chrome-'));
  const port = 9300 + Math.floor(Math.random() * 600);
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--hide-scrollbars',
      '--no-first-run',
      '--no-sandbox',
      // Consistent rasterisation for pixel comparisons.
      '--force-color-profile=srgb',
      '--font-render-hinting=none',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const exited = new Promise((r) => chrome.once('exit', r));
  const close = async () => {
    chrome.kill();
    await exited; // Chrome writes to its profile until it exits
    await rm(profile, { recursive: true, force: true });
  };

  try {
    let target;
    for (let i = 0; i < 75 && !target; i++) {
      await sleep(200);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        target = list.find((t) => t.type === 'page');
      } catch {}
    }
    if (!target) throw new Error(`Chrome did not start at ${chromePath} (set CHROME_PATH)`);

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
      if (r.result.exceptionDetails) {
        throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
      }
      return r.result.result.value;
    };
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await send('Page.enable');

    // Navigate and wait until `ready` (a JS expression) is truthy.
    const open = async (url, ready) => {
      await send('Page.navigate', { url });
      for (let i = 0; i < 100; i++) {
        if (await evaluate(`!!(${ready})`).catch(() => false)) return;
        await sleep(100);
      }
      throw new Error(`timed out waiting for ${ready} on ${url}`);
    };

    return {
      open,
      evaluate,
      close: async () => {
        ws.close();
        await close();
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
