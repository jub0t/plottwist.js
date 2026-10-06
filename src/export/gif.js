// Streaming animated-GIF encoder.
//
// Each frame only stores the pixels that visibly changed: unchanged pixels
// become transparent (the previous frame shows through), and the frame is
// cropped to the changed rectangle. The palette is built per frame by median
// cut over just those changed pixels, so a chart whose colours shift over time
// still gets an accurate palette, and static areas cost almost nothing.

const TRANSPARENT = 255; // palette index reserved for "unchanged"
const COLORS = 255;
const THRESHOLD = 8; // summed channel difference below which a pixel counts as unchanged

export class GifEncoder {
  constructor(width, height, { delay = 50, loop = 0 } = {}) {
    this.width = width;
    this.height = height;
    this.delay = Math.max(2, Math.round(delay / 10)); // centiseconds
    this.out = new ByteWriter();
    this.shown = new Uint8ClampedArray(width * height * 3); // what a viewer currently sees
    this.first = true;
    this.pendingDelay = 0;

    const o = this.out;
    o.str('GIF89a');
    o.u16(width);
    o.u16(height);
    o.u8(0x70); // no global colour table, 8-bit colour resolution
    o.u8(0);
    o.u8(0);
    // NETSCAPE2.0 application extension: loop forever (or `loop` times).
    o.bytes([0x21, 0xff, 0x0b]);
    o.str('NETSCAPE2.0');
    o.bytes([0x03, 0x01]);
    o.u16(loop);
    o.u8(0);
  }

  addFrame(rgba) {
    const { width: w, height: h, shown } = this;

    // Changed bounding box.
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (this.first || differs(rgba, i * 4, shown, i * 3)) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) {
      // Nothing changed: extend the previous frame's delay instead.
      this.pendingDelay += this.delay;
      if (this.pendingDelay < 0xffff) return;
      x0 = y0 = x1 = y1 = 0; // delay overflow: emit a 1px no-op frame
    }
    this._flushDelay();

    const fw = x1 - x0 + 1;
    const fh = y1 - y0 + 1;

    // Histogram (5 bits per channel) of the changed pixels, with colour sums
    // so palette entries are true averages rather than bin centres.
    const count = new Uint32Array(32768);
    const sum = new Float64Array(32768 * 3);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        const p = i * 4;
        if (!this.first && !differs(rgba, p, shown, i * 3)) continue;
        const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
        const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        count[k]++;
        sum[k * 3] += r;
        sum[k * 3 + 1] += g;
        sum[k * 3 + 2] += b;
      }
    }
    const palette = medianCut(count, sum, COLORS);
    const lookup = new Int16Array(32768).fill(-1);

    const indices = new Uint8Array(fw * fh);
    let transparent = false;
    for (let y = y0, n = 0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++, n++) {
        const i = y * w + x;
        const p = i * 4;
        if (!this.first && !differs(rgba, p, shown, i * 3)) {
          indices[n] = TRANSPARENT;
          transparent = true;
          continue;
        }
        const k = ((rgba[p] >> 3) << 10) | ((rgba[p + 1] >> 3) << 5) | (rgba[p + 2] >> 3);
        let c = lookup[k];
        if (c < 0) c = lookup[k] = nearest(palette, sum[k * 3] / count[k], sum[k * 3 + 1] / count[k], sum[k * 3 + 2] / count[k]);
        indices[n] = c;
        const q = i * 3;
        shown[q] = palette[c * 3];
        shown[q + 1] = palette[c * 3 + 1];
        shown[q + 2] = palette[c * 3 + 2];
      }
    }

    const o = this.out;
    // Graphic control extension: keep previous frame (disposal 1), delay,
    // optional transparent index. The delay is patched in by _flushDelay.
    o.bytes([0x21, 0xf9, 0x04, (1 << 2) | (transparent ? 1 : 0)]);
    this.delayAt = o.length;
    o.u16(this.delay);
    o.u8(TRANSPARENT);
    o.u8(0);
    // Image descriptor with a full 256-entry local colour table.
    o.u8(0x2c);
    o.u16(x0);
    o.u16(y0);
    o.u16(fw);
    o.u16(fh);
    o.u8(0x87);
    for (let c = 0; c < 256; c++) {
      if (c < palette.length / 3) o.bytes([palette[c * 3], palette[c * 3 + 1], palette[c * 3 + 2]]);
      else o.bytes([0, 0, 0]);
    }
    lzw(indices, 8, o);
    this.first = false;
    this.pendingDelay = this.delay;
  }

  // Write the accumulated delay of the last frame (it grows while identical
  // frames are skipped).
  _flushDelay() {
    if (this.delayAt !== undefined) this.out.setU16(this.delayAt, Math.min(0xffff, this.pendingDelay));
  }

  finish() {
    this._flushDelay();
    this.out.u8(0x3b);
    return this.out.result();
  }
}

function differs(rgba, p, shown, q) {
  return (
    Math.abs(rgba[p] - shown[q]) + Math.abs(rgba[p + 1] - shown[q + 1]) + Math.abs(rgba[p + 2] - shown[q + 2]) >
    THRESHOLD
  );
}

// Median cut over the occupied histogram bins. Returns a flat RGB array.
function medianCut(count, sum, maxColors) {
  const bins = [];
  for (let k = 0; k < count.length; k++) if (count[k]) bins.push(k);
  if (!bins.length) return new Uint8Array(3);
  const ch = (k, c) => sum[k * 3 + c] / count[k];

  const makeBox = (list) => {
    let lo = [255, 255, 255], hi = [0, 0, 0], n = 0;
    for (const k of list) {
      n += count[k];
      for (let c = 0; c < 3; c++) {
        const v = ch(k, c);
        if (v < lo[c]) lo[c] = v;
        if (v > hi[c]) hi[c] = v;
      }
    }
    const ranges = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const axis = ranges.indexOf(Math.max(...ranges));
    // Weight by pixel count so busy regions get more colours.
    return { list, n, axis, score: ranges[axis] * Math.sqrt(n) };
  };

  const boxes = [makeBox(bins)];
  while (boxes.length < maxColors) {
    let best = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].list.length > 1 && (best < 0 || boxes[i].score > boxes[best].score)) best = i;
    }
    if (best < 0 || boxes[best].score === 0) break;
    const { list, n, axis } = boxes[best];
    list.sort((a, b) => ch(a, axis) - ch(b, axis));
    let acc = 0, cut = 1;
    for (let i = 0; i < list.length - 1; i++) {
      acc += count[list[i]];
      if (acc >= n / 2) {
        cut = i + 1;
        break;
      }
      cut = i + 1;
    }
    boxes.splice(best, 1, makeBox(list.slice(0, cut)), makeBox(list.slice(cut)));
  }

  const palette = new Uint8Array(boxes.length * 3);
  boxes.forEach((box, i) => {
    let r = 0, g = 0, b = 0;
    for (const k of box.list) {
      r += sum[k * 3];
      g += sum[k * 3 + 1];
      b += sum[k * 3 + 2];
    }
    palette[i * 3] = Math.round(r / box.n);
    palette[i * 3 + 1] = Math.round(g / box.n);
    palette[i * 3 + 2] = Math.round(b / box.n);
  });
  return palette;
}

function nearest(palette, r, g, b) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length / 3; i++) {
    const dr = palette[i * 3] - r, dg = palette[i * 3 + 1] - g, db = palette[i * 3 + 2] - b;
    const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

let dict = null;

// GIF LZW: variable-width codes (up to 12 bits), packed LSB-first into
// sub-blocks of at most 255 bytes.
function lzw(indices, minCodeSize, out) {
  out.u8(minCodeSize);
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let nextCode = eoiCode + 1;
  let codeSize = minCodeSize + 1;
  // Dictionary keyed by (prefix code << 8 | byte); a generation stamp makes
  // clearing O(1). Allocated once and shared by every frame.
  dict ??= { codes: new Int16Array(4096 * 256), stamps: new Uint16Array(4096 * 256), gen: 0 };
  const { codes, stamps } = dict;
  const nextGen = () => {
    if (++dict.gen === 0x10000) {
      stamps.fill(0);
      dict.gen = 1;
    }
    return dict.gen;
  };
  let gen = nextGen();

  const block = new Uint8Array(255);
  let blockLen = 0;
  let cur = 0;
  let curBits = 0;
  const emit = (code) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      block[blockLen++] = cur & 0xff;
      if (blockLen === 255) {
        out.u8(255);
        out.bytes(block);
        blockLen = 0;
      }
      cur >>>= 8;
      curBits -= 8;
    }
  };

  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    if (stamps[key] === gen) {
      prefix = codes[key];
      continue;
    }
    emit(prefix);
    if (nextCode === 4096) {
      emit(clearCode);
      nextCode = eoiCode + 1;
      codeSize = minCodeSize + 1;
      gen = nextGen();
    } else {
      if (nextCode >= 1 << codeSize) codeSize++;
      codes[key] = nextCode++;
      stamps[key] = gen;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoiCode);
  if (curBits > 0) {
    block[blockLen++] = cur & 0xff;
    if (blockLen === 255) {
      out.u8(255);
      out.bytes(block);
      blockLen = 0;
    }
  }
  if (blockLen) {
    out.u8(blockLen);
    out.bytes(block.subarray(0, blockLen));
  }
  out.u8(0);
}

// Growable byte buffer.
export class ByteWriter {
  constructor(size = 1 << 16) {
    this.buf = new Uint8Array(size);
    this.length = 0;
  }
  reserve(n) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  u8(v) {
    this.reserve(1);
    this.buf[this.length++] = v;
  }
  u16(v) {
    this.reserve(2);
    this.buf[this.length++] = v & 0xff;
    this.buf[this.length++] = (v >> 8) & 0xff;
  }
  setU16(at, v) {
    this.buf[at] = v & 0xff;
    this.buf[at + 1] = (v >> 8) & 0xff;
  }
  bytes(arr) {
    this.reserve(arr.length);
    this.buf.set(arr, this.length);
    this.length += arr.length;
  }
  str(s) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }
  result() {
    return this.buf.slice(0, this.length);
  }
}
