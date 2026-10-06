// Export tests: renders demo charts to every format in headless Chrome, checks
// that the browser decodes the result, and (when installed) that ffprobe
// agrees about codec, size and duration.
//
//   npm run test:export

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, serve } from '../../scripts/lib/chrome.js';

const CASES = [
  { name: 'race mp4', demo: 'race', options: { format: 'mp4', duration: 2000 }, expect: { codec: 'h264', width: 1280, height: 800, duration: 2 } },
  { name: 'race webm', demo: 'race', options: { format: 'webm', duration: 2000, width: 480 }, expect: { codec: 'vp9', width: 480, height: 300, duration: 2 } },
  { name: 'map orbit mp4', demo: 'map', options: { format: 'mp4', duration: 1500, orbit: 0.25, pixelRatio: 1 }, expect: { codec: 'h264', width: 640, height: 400, duration: 1.5 } },
  { name: 'bars gif', demo: 'bars', options: { format: 'gif', duration: 1500, fps: 10, pixelRatio: 1 }, expect: { frames: 15, width: 640, height: 400 } },
  { name: 'regions png', demo: 'regions', options: { format: 'png' }, expect: { frames: 1, width: 1280, height: 800 } },
];

let ffprobe = true;
try {
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
} catch {
  ffprobe = false;
}

const server = await serve();
const chrome = await launch({ width: 800, height: 600, scale: 2 });
const dir = await mkdtemp(join(tmpdir(), 'plottwist-export-'));
let failed = 0;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

try {
  await chrome.open(`${server.url}/test/export/page.html`, 'window.ready');
  for (const c of CASES) {
    const problems = [];
    let r;
    try {
      r = await chrome.evaluate(`exportCase(${JSON.stringify(c.demo)}, ${JSON.stringify(c.options)})`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${c.name}: ${e.message.split('\n')[0]}`);
      continue;
    }
    const { info, expect: x } = { info: r.info, expect: c.expect };
    if (info.width !== x.width || info.height !== x.height) problems.push(`size ${info.width}x${info.height}, expected ${x.width}x${x.height}`);
    if (x.frames !== undefined && info.frames !== x.frames) problems.push(`${info.frames} frames, expected ${x.frames}`);
    if (x.duration !== undefined && !near(info.duration, x.duration, 0.1)) problems.push(`browser duration ${info.duration}s`);
    if (info.lit !== undefined && info.lit < 0.01) problems.push('mid-clip frame is blank');

    if (ffprobe && x.codec) {
      const file = join(dir, `${c.name.replace(/\W+/g, '-')}.${c.options.format}`);
      await writeFile(file, Buffer.from(await chrome.readString('window.lastData', r.chars), 'base64'));
      const probe = JSON.parse(
        execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-count_frames', '-of', 'json', file]).toString(),
      );
      const s = probe.streams[0];
      if (s.codec_name !== x.codec) problems.push(`ffprobe codec ${s.codec_name}`);
      if (!near(Number(probe.format.duration), x.duration, 0.1)) problems.push(`ffprobe duration ${probe.format.duration}`);
      const frames = Number(s.nb_read_frames);
      if (frames !== Math.round(x.duration * (c.options.fps ?? 30))) problems.push(`ffprobe counted ${frames} frames`);
      // A full decode must be free of errors.
      const errors = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      if (errors.trim()) problems.push(`ffmpeg: ${errors.trim().split('\n')[0]}`);
    }

    const summary = `${(r.size / 1024).toFixed(0)} KB in ${(r.ms / 1000).toFixed(1)}s`;
    if (problems.length) {
      failed++;
      console.log(`  FAIL  ${c.name} (${summary}): ${problems.join('; ')}`);
    } else console.log(`  ok    ${c.name} (${summary})`);
  }
  const aborted = await chrome.evaluate('abortCase()');
  if (aborted === 'ok') console.log('  ok    abort');
  else {
    failed++;
    console.log(`  FAIL  abort: ${aborted}`);
  }
} finally {
  await chrome.close();
  server.close();
  await rm(dir, { recursive: true, force: true });
}

if (!ffprobe) console.log('\n(ffprobe not found: container checks skipped)');
if (failed) process.exit(1);
