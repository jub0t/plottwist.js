// Zero-dependency dev server: serves the repo as static files and live-reloads
// open pages whenever anything under src/ or examples/ changes.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT) || 5173;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const reloadScript =
  '<script>new EventSource("/__reload").onmessage = () => location.reload();</script>';
const clients = new Set();

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__reload') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/') {
    res.writeHead(302, { location: '/examples/' });
    return res.end();
  }

  let file = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) return send(res, 403, 'Forbidden');
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    let body = await readFile(file);
    const type = types[extname(file)] ?? 'application/octet-stream';
    if (type.startsWith('text/html')) body = body.toString().replace('</body>', `${reloadScript}</body>`);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    send(res, 404, 'Not found');
  }
}).listen(port, () => console.log(`plottwist dev server → http://localhost:${port}/examples/`));

let timer;
for (const dir of ['src', 'examples']) {
  watch(join(root, dir), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => clients.forEach((c) => c.write('data: reload\n\n')), 50);
  });
}

function send(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(text);
}
