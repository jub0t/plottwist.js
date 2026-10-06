// Animated WebP with a full alpha channel, so clips sit on any background.
//
// The browser encodes each frame (canvas.toBlob('image/webp')); this file
// assembles the frames into an animation (RIFF: VP8X, ANIM, then one ANMF
// per frame). Each frame stores only the rectangle that changed since the
// previous one, and identical frames extend the previous frame's duration.

const ALPHA_EPS = 2; // per-channel difference treated as unchanged

export class WebpEncoder {
  constructor(width, height, { quality = 0.9, loop = 0 } = {}) {
    this.width = width;
    this.height = height;
    this.quality = quality;
    this.loop = loop;
    this.frames = [];
    this.prev = null;
    this.crop = document.createElement('canvas');
    this.cropCtx = this.crop.getContext('2d');
  }

  // canvas: the full frame; rgba: its ImageData pixels; duration in ms.
  async addFrame(canvas, rgba, duration) {
    const { width: w, height: h } = this;
    let box = { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
    if (this.prev) {
      box = changedBox(this.prev, rgba, w, h);
      if (!box) {
        this.frames[this.frames.length - 1].duration += duration;
        return;
      }
      // Frame offsets are stored halved, so they must be even.
      box.x0 -= box.x0 % 2;
      box.y0 -= box.y0 % 2;
    }
    this.prev = rgba;
    const fw = box.x1 - box.x0 + 1;
    const fh = box.y1 - box.y0 + 1;
    this.crop.width = fw;
    this.crop.height = fh;
    this.cropCtx.clearRect(0, 0, fw, fh);
    this.cropCtx.drawImage(canvas, box.x0, box.y0, fw, fh, 0, 0, fw, fh);
    const blob = await new Promise((r) => this.crop.toBlob(r, 'image/webp', this.quality));
    if (!blob || blob.type !== 'image/webp') throw new Error('plottwist: this browser cannot encode WebP');
    const chunks = parseChunks(new Uint8Array(await blob.arrayBuffer()));
    // A still WebP is VP8 (opaque), VP8X + ALPH + VP8, or VP8L; keep the
    // image data chunks.
    const data = chunks.filter((c) => c.id === 'ALPH' || c.id === 'VP8 ' || c.id === 'VP8L');
    this.frames.push({ x: box.x0, y: box.y0, w: fw, h: fh, duration, data });
  }

  finish() {
    const out = [];
    const vp8x = new Uint8Array(10);
    vp8x[0] = 0x02 | 0x10; // animation, alpha
    put24(vp8x, 4, this.width - 1);
    put24(vp8x, 7, this.height - 1);
    out.push(chunk('VP8X', vp8x));
    const anim = new Uint8Array(6); // transparent background, loop count
    anim[4] = this.loop & 0xff;
    anim[5] = (this.loop >> 8) & 0xff;
    out.push(chunk('ANIM', anim));
    for (const f of this.frames) {
      const head = new Uint8Array(16);
      put24(head, 0, f.x / 2);
      put24(head, 3, f.y / 2);
      put24(head, 6, f.w - 1);
      put24(head, 9, f.h - 1);
      put24(head, 12, Math.max(1, Math.round(f.duration)));
      head[15] = 0x02; // no blending: the rectangle replaces what was there
      out.push(chunk('ANMF', concat([head, ...f.data.map((c) => chunk(c.id, c.body))])));
    }
    const body = concat(out);
    const riff = new Uint8Array(12 + body.length);
    riff.set(ascii('RIFF'), 0);
    new DataView(riff.buffer).setUint32(4, 4 + body.length, true);
    riff.set(ascii('WEBP'), 8);
    riff.set(body, 12);
    return riff;
  }
}

function changedBox(a, b, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4;
      if (
        Math.abs(a[i] - b[i]) > ALPHA_EPS ||
        Math.abs(a[i + 1] - b[i + 1]) > ALPHA_EPS ||
        Math.abs(a[i + 2] - b[i + 2]) > ALPHA_EPS ||
        Math.abs(a[i + 3] - b[i + 3]) > ALPHA_EPS
      ) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

// RIFF chunks of a WebP file: [{ id, body }].
function parseChunks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    out.push({ id, body: bytes.subarray(at + 8, at + 8 + size) });
    at += 8 + size + (size & 1);
  }
  return out;
}

function chunk(id, body) {
  const pad = body.length & 1;
  const out = new Uint8Array(8 + body.length + pad);
  out.set(ascii(id), 0);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

function put24(arr, at, v) {
  arr[at] = v & 0xff;
  arr[at + 1] = (v >> 8) & 0xff;
  arr[at + 2] = (v >> 16) & 0xff;
}

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
