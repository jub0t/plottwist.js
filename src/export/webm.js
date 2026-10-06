// Minimal WebM (Matroska) muxer for one VP8/VP9 video track from WebCodecs.
// Clusters start at every key frame, and a Cues index at the end makes the
// file seekable.

import { concat } from './mp4.js';

const ID = {
  EBML: 0x1a45dfa3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42f7, EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3, DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, MuxingApp: 0x4d80, WritingApp: 0x5741,
  Duration: 0x4489, Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5,
  FlagLacing: 0x9c, CodecID: 0x86, TrackType: 0x83, DefaultDuration: 0x23e383, Video: 0xe0,
  PixelWidth: 0xb0, PixelHeight: 0xba, Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
};

// track: { width, height, fps, codec }; chunks as for muxMp4. Timecodes in ms.
export function muxWebm(track, chunks) {
  const ms = (us) => Math.round(us / 1000);
  const last = chunks[chunks.length - 1];
  const durationMs = last ? ms(last.timestamp + (last.duration ?? 1e6 / track.fps)) : 0;

  const header = el(ID.EBML, [
    uint(ID.EBMLVersion, 1), uint(ID.EBMLReadVersion, 1), uint(ID.EBMLMaxIDLength, 4),
    uint(ID.EBMLMaxSizeLength, 8), text(ID.DocType, 'webm'), uint(ID.DocTypeVersion, 4),
    uint(ID.DocTypeReadVersion, 2),
  ]);

  const info = el(ID.Info, [
    uint(ID.TimecodeScale, 1e6), text(ID.MuxingApp, 'plottwist'), text(ID.WritingApp, 'plottwist'),
    float(ID.Duration, durationMs),
  ]);
  const tracks = el(ID.Tracks, [
    el(ID.TrackEntry, [
      uint(ID.TrackNumber, 1), uint(ID.TrackUID, 1), uint(ID.FlagLacing, 0),
      text(ID.CodecID, track.codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8'),
      uint(ID.TrackType, 1), uint(ID.DefaultDuration, Math.round(1e9 / track.fps)),
      el(ID.Video, [uint(ID.PixelWidth, track.width), uint(ID.PixelHeight, track.height)]),
    ]),
  ]);

  // Group chunks into clusters: a new one at each key frame, or before the
  // 16-bit relative timecode would overflow.
  const clusters = [];
  let current = null;
  for (const c of chunks) {
    const t = ms(c.timestamp);
    if (!current || c.key || t - current.time > 30000) {
      current = { time: t, blocks: [] };
      clusters.push(current);
    }
    const rel = t - current.time;
    current.blocks.push(
      el(ID.SimpleBlock, [new Uint8Array([0x81, (rel >> 8) & 0xff, rel & 0xff, c.key ? 0x80 : 0]), c.data]),
    );
  }

  const body = [info, tracks];
  let offset = info.length + tracks.length; // relative to the segment's data
  const cues = [];
  for (const cl of clusters) {
    const bytes = el(ID.Cluster, [uint(ID.Timecode, cl.time), ...cl.blocks]);
    cues.push(
      el(ID.CuePoint, [
        uint(ID.CueTime, cl.time),
        el(ID.CueTrackPositions, [uint(ID.CueTrack, 1), uint(ID.CueClusterPosition, offset)]),
      ]),
    );
    body.push(bytes);
    offset += bytes.length;
  }
  body.push(el(ID.Cues, cues));

  return concat([header, el(ID.Segment, body)]);
}

// ---- EBML -----------------------------------------------------------------------

function idBytes(id) {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return new Uint8Array(out);
}

// Variable-length size with the shortest encoding (all-ones is reserved).
function vsize(n) {
  let len = 1;
  while (n >= 2 ** (7 * len) - 1) len++;
  const out = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 1 << (8 - len);
  return out;
}

function el(id, parts) {
  const body = parts instanceof Uint8Array ? parts : concat(parts);
  return concat([idBytes(id), vsize(body.length), body]);
}

function uint(id, value) {
  const out = [];
  let v = value;
  do {
    out.unshift(v % 256);
    v = Math.floor(v / 256);
  } while (v > 0);
  return el(id, new Uint8Array(out));
}

function float(id, value) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value);
  return el(id, b);
}

function text(id, s) {
  return el(id, Uint8Array.from(s, (c) => c.charCodeAt(0)));
}
