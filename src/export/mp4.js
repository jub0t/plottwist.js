// Minimal MP4 (ISO BMFF) muxer for one H.264 video track, as produced by
// WebCodecs with avc: { format: 'avc' }. Writes a "fast start" file: ftyp,
// then moov (all sample tables), then one mdat holding every sample, so it
// plays while it downloads.

const TIMESCALE = 90000;
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

// track: { width, height, fps, description (avcC bytes) }
// chunks: [{ data: Uint8Array, key: boolean, timestamp: µs, duration: µs }]
export function muxMp4(track, chunks) {
  if (!track.description) throw new Error('plottwist: the H.264 encoder gave no decoder configuration');
  const frameTicks = Math.round(TIMESCALE / track.fps);
  const ticks = (us) => Math.round((us * TIMESCALE) / 1e6);

  const deltas = chunks.map((c, i) =>
    i + 1 < chunks.length ? ticks(chunks[i + 1].timestamp) - ticks(c.timestamp) : c.duration ? ticks(c.duration) : frameTicks,
  );
  const duration = deltas.reduce((a, b) => a + b, 0);
  const movieDuration = Math.round((duration * 1000) / TIMESCALE);

  const moov = (mdatOffset) =>
    box('moov', [
      mvhd(movieDuration),
      box('trak', [
        tkhd(movieDuration, track.width, track.height),
        box('mdia', [
          mdhd(duration),
          hdlr(),
          box('minf', [
            fullBox('vmhd', 0, 1, [u16(0), u16(0), u16(0), u16(0)]),
            box('dinf', [fullBox('dref', 0, 0, [u32(1), fullBox('url ', 0, 1, [])])]),
            box('stbl', [
              fullBox('stsd', 0, 0, [u32(1), avc1(track)]),
              stts(deltas),
              stss(chunks),
              fullBox('stsc', 0, 0, [u32(1), u32(1), u32(chunks.length), u32(1)]),
              fullBox('stsz', 0, 0, [u32(0), u32(chunks.length), ...chunks.map((c) => u32(c.data.length))]),
              fullBox('stco', 0, 0, [u32(1), u32(mdatOffset)]),
            ]),
          ]),
        ]),
      ]),
    ]);

  const ftyp = box('ftyp', [str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41')]);
  const moovSize = moov(0).length; // offsets don't change the size
  const mdatSize = 8 + chunks.reduce((n, c) => n + c.data.length, 0);
  const header = concat([ftyp, moov(ftyp.length + moovSize + 8), u32(mdatSize), str('mdat')]);

  const out = new Uint8Array(header.length + mdatSize - 8);
  out.set(header, 0);
  let at = header.length;
  for (const c of chunks) {
    out.set(c.data, at);
    at += c.data.length;
  }
  return out;
}

function mvhd(duration) {
  return fullBox('mvhd', 0, 0, [
    u32(0), u32(0), u32(1000), u32(duration),
    u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
    ...MATRIX.map(u32),
    ...Array.from({ length: 6 }, () => u32(0)),
    u32(2),
  ]);
}

function tkhd(duration, width, height) {
  return fullBox('tkhd', 0, 3, [
    u32(0), u32(0), u32(1), u32(0), u32(duration),
    u32(0), u32(0), u16(0), u16(0), u16(0), u16(0),
    ...MATRIX.map(u32),
    u32(width * 0x10000), u32(height * 0x10000),
  ]);
}

function mdhd(duration) {
  return fullBox('mdhd', 0, 0, [u32(0), u32(0), u32(TIMESCALE), u32(duration), u16(0x55c4), u16(0)]);
}

function hdlr() {
  return fullBox('hdlr', 0, 0, [u32(0), str('vide'), u32(0), u32(0), u32(0), str('VideoHandler\0')]);
}

function avc1({ width, height, description }) {
  const name = new Uint8Array(32);
  return box('avc1', [
    new Uint8Array(6), u16(1), // reserved, data_reference_index
    u16(0), u16(0), u32(0), u32(0), u32(0),
    u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), u32(0),
    u16(1), name, u16(0x0018), u16(0xffff),
    box('avcC', [description]),
  ]);
}

// Run-length (count, delta) pairs.
function stts(deltas) {
  const runs = [];
  for (const d of deltas) {
    const last = runs[runs.length - 1];
    if (last && last[1] === d) last[0]++;
    else runs.push([1, d]);
  }
  return fullBox('stts', 0, 0, [u32(runs.length), ...runs.flatMap(([n, d]) => [u32(n), u32(d)])]);
}

function stss(chunks) {
  const keys = [];
  chunks.forEach((c, i) => c.key && keys.push(i + 1));
  return fullBox('stss', 0, 0, [u32(keys.length), ...keys.map(u32)]);
}

// ---- bytes -------------------------------------------------------------------

function box(type, parts) {
  const body = concat(parts);
  return concat([u32(body.length + 8), str(type), body]);
}

function fullBox(type, version, flags, parts) {
  return box(type, [new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...parts]);
}

function u16(v) {
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
}

function u32(v) {
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

function str(s) {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
