// chart.export(): renders a chart to an MP4, WebM, GIF or PNG Blob.
//
// Frames are produced offline: the chart's clock is replaced with a synthetic
// one that advances exactly 1/fps per frame, so a clip is frame-perfect no
// matter how slow the machine or encoder is, and identical between runs.
// Video is encoded with WebCodecs and muxed here (no dependencies); browsers
// without WebCodecs fall back to MediaRecorder, which records in real time.

import { muxMp4 } from './mp4.js';
import { muxWebm } from './webm.js';
import { GifEncoder } from './gif.js';
import { WebpEncoder } from './webp.js';
import { Tween } from '../core/animation.js';

const TAU = Math.PI * 2;
const MIME = { mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif', png: 'image/png', webp: 'image/webp' };

export async function exportChart(chart, options = {}) {
  const format = options.format ?? 'mp4';
  if (!MIME[format]) throw new Error(`plottwist: unknown export format "${format}"`);
  if (chart._exporting) throw new Error('plottwist: an export is already running on this chart');

  const session = new Session(chart, options, format);
  try {
    if (format === 'png') return await session.still();
    if (format === 'gif') return await session.gif();
    if (format === 'webp') return await session.webp();
    if (typeof VideoEncoder === 'function') {
      const blob = await session.webCodecs(format);
      if (blob) return blob;
    }
    return await session.mediaRecorder(format);
  } finally {
    session.restore();
  }
}

class Session {
  constructor(chart, o, format) {
    this.chart = chart;
    this.format = format;
    this.signal = o.signal;
    this.onProgress = o.onProgress;
    this.onFrame = o.onFrame;

    const R = chart.renderer;
    const ratio = o.pixelRatio ?? (o.width || o.height ? 1 : window.devicePixelRatio || 1);
    let width = o.width ?? R.width;
    let height = o.height ?? (o.width ? (o.width * R.height) / R.width : R.height);
    // Video encoders need even pixel dimensions.
    const even = (n) => Math.max(2, Math.round((n * ratio) / 2) * 2);
    this.pixelWidth = format === 'mp4' || format === 'webm' ? even(width) : Math.round(width * ratio);
    this.pixelHeight = format === 'mp4' || format === 'webm' ? even(height) : Math.round(height * ratio);
    this.cssWidth = this.pixelWidth / ratio;
    this.cssHeight = this.pixelHeight / ratio;
    this.ratio = ratio;

    // Videos and GIFs need an opaque background; PNGs stay transparent.
    const themeBg = chart.theme.background;
    const fallback = chart.theme.mode === 'light' ? '#ffffff' : '#0b0a14';
    this.background =
      o.background ?? (themeBg && themeBg !== 'transparent' ? themeBg : format === 'png' || format === 'webp' ? null : fallback);

    this.fps = o.fps ?? (format === 'gif' || format === 'webp' ? 20 : 30);
    this.quality = o.quality;
    const T = chart.timeline;
    const from = Math.max(0, Math.min(o.from ?? 0, Math.max(0, T.length - 1)));
    this.from = from;
    this.animated = T.length > 1 && o.play !== false;
    const pass = this.animated ? (T.length - 1 - from) * T.frameDuration : 0;
    this.orbit = o.orbit ?? 0;
    const duration =
      o.duration ?? (this.animated ? pass + (T.loop ? 0 : 1000) : this.orbit ? 6000 : 3000);
    this.frameCount = format === 'png' ? 1 : Math.max(1, Math.round((duration / 1000) * this.fps));

    // Everything export() touches, so restore() can put the chart back.
    this.saved = {
      yaw: chart.view.yaw.value,
      pitch: chart.view.pitch.value,
      zoom: chart.view.zoom.value,
      position: T.position,
      playing: T.playing,
      visible: chart.visible,
    };

    cancelAnimationFrame(chart._raf);
    chart._raf = null;
    chart._exporting = true;
    chart._yawVelocity = 0;
    chart._pointer = null;
    chart._setHover(null);
    chart.visible = true;
    for (const r of this.renderers()) {
      r.fixed = true;
      r.resize(this.cssWidth, this.cssHeight, ratio);
    }
    chart._fit = null; // fit the new size immediately rather than easing

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.pixelWidth;
    this.canvas.height = this.pixelHeight;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: format === 'gif' || format === 'webp' });

    this.t = performance.now();
    chart._clock = this.t;
    T.seek(from);
    T.playing = this.animated;
    T._last = null;
    this.startYaw = chart.view.yaw.value;
  }

  renderers() {
    return [this.chart.renderer, this.chart.overlay].filter(Boolean);
  }

  // Advance the synthetic clock to frame i, render, and composite the layers
  // (background, scene, overlay) into this.canvas.
  async render(i) {
    if (this.signal?.aborted) throw this.signal.reason ?? new DOMException('Export aborted', 'AbortError');
    const chart = this.chart;
    const t = this.t + (i * 1000) / this.fps;
    chart._clock = t;
    // Scripted clips: the hook can change data, drill, move the camera...
    if (this.onFrame) await this.onFrame({ frame: i, time: (i * 1000) / this.fps, chart });
    if (this.signal?.aborted) throw this.signal.reason ?? new DOMException('Export aborted', 'AbortError');
    if (this.orbit) chart.view.yaw.set(this.startYaw - (this.orbit * TAU * i) / this.frameCount);
    chart._dirty = true;
    chart._frame(t);

    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (this.background) {
      ctx.fillStyle = this.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    for (const r of this.renderers()) ctx.drawImage(r.canvas, 0, 0, canvas.width, canvas.height);
    this.onProgress?.((i + 1) / this.frameCount);
    return canvas;
  }

  // Let the chart settle (fit, data and intro tweens) before frame 0.
  warmUp() {
    const chart = this.chart;
    const playing = chart.timeline.playing;
    chart.timeline.playing = false;
    for (let i = 0; i < 90; i++) {
      this.t += 1000 / 60;
      chart._clock = this.t;
      chart._dirty = true;
      chart._frame(this.t);
    }
    chart.timeline.playing = playing;
    chart.timeline._last = null;
  }

  async still() {
    this.warmUp();
    const canvas = await this.render(0);
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('plottwist: PNG encoding failed'))), 'image/png'),
    );
  }

  async gif() {
    this.warmUp();
    const { pixelWidth: w, pixelHeight: h } = this;
    const enc = new GifEncoder(w, h, { delay: 1000 / this.fps });
    for (let i = 0; i < this.frameCount; i++) {
      await this.render(i);
      enc.addFrame(this.ctx.getImageData(0, 0, w, h).data);
      if (i % 4 === 3) await idle(); // keep the page responsive
    }
    return new Blob([enc.finish()], { type: MIME.gif });
  }

  // Animated WebP keeps the alpha channel: transparent unless a background
  // is given.
  async webp() {
    this.warmUp();
    const { pixelWidth: w, pixelHeight: h } = this;
    const enc = new WebpEncoder(w, h, { quality: this.quality ?? 0.9 });
    for (let i = 0; i < this.frameCount; i++) {
      const canvas = await this.render(i);
      await enc.addFrame(canvas, this.ctx.getImageData(0, 0, w, h).data, 1000 / this.fps);
    }
    return new Blob([enc.finish()], { type: MIME.webp });
  }

  // Returns null when no suitable codec is available, so the caller can fall
  // back to MediaRecorder.
  async webCodecs(format) {
    const config = await pickCodec(format, this.pixelWidth, this.pixelHeight, this.fps);
    if (!config) return null;

    const chunks = [];
    let meta = null;
    let failure = null;
    const encoder = new VideoEncoder({
      output: (chunk, md) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({ data, key: chunk.type === 'key', timestamp: chunk.timestamp, duration: chunk.duration });
        if (md?.decoderConfig && !meta) meta = md.decoderConfig;
      },
      error: (e) => (failure = e),
    });
    encoder.configure(config);

    this.warmUp();
    const frameUs = 1e6 / this.fps;
    const keyEvery = Math.max(1, Math.round(this.fps * 2));
    try {
      for (let i = 0; i < this.frameCount; i++) {
        if (failure) throw failure;
        const frame = new VideoFrame(await this.render(i), {
          timestamp: Math.round(i * frameUs),
          duration: Math.round(frameUs),
        });
        encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
        frame.close();
        // Back-pressure: don't queue up hundreds of raw frames.
        while (encoder.encodeQueueSize > 4) await idle();
      }
      await encoder.flush();
      if (failure) throw failure;
    } finally {
      if (encoder.state !== 'closed') encoder.close();
    }

    const track = {
      width: this.pixelWidth,
      height: this.pixelHeight,
      fps: this.fps,
      codec: config.codec,
      description: meta?.description && toBytes(meta.description),
    };
    const bytes = format === 'mp4' ? muxMp4(track, chunks) : muxWebm(track, chunks);
    return new Blob([bytes], { type: MIME[format] });
  }

  // Real-time fallback: frames are still stepped deterministically, but the
  // recorder samples them on the wall clock, so pacing depends on the machine.
  async mediaRecorder(format) {
    if (typeof MediaRecorder !== 'function' || !this.canvas.captureStream) {
      throw new Error('plottwist: video export needs WebCodecs or MediaRecorder');
    }
    const types =
      format === 'mp4'
        ? ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
        : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
    if (!mimeType) throw new Error(`plottwist: this browser cannot record ${format}`);

    this.warmUp();
    await this.render(0);
    const stream = this.canvas.captureStream(this.fps);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate(this) });
    const parts = [];
    recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
    const stopped = new Promise((r) => (recorder.onstop = r));
    recorder.start();
    const start = performance.now();
    try {
      for (let i = 1; i < this.frameCount; i++) {
        const due = start + (i * 1000) / this.fps;
        await new Promise((r) => setTimeout(r, Math.max(0, due - performance.now())));
        await this.render(i);
      }
      await new Promise((r) => setTimeout(r, 1000 / this.fps));
    } finally {
      recorder.stop();
      stream.getTracks().forEach((t) => t.stop());
    }
    await stopped;
    return new Blob(parts, { type: mimeType.split(';')[0] });
  }

  restore() {
    const { chart, saved } = this;
    chart._exporting = false;
    chart._clock = null;
    for (const r of this.renderers()) {
      r.fixed = false;
      r.resize();
    }
    chart._fit = null;
    chart.view.yaw.set(saved.yaw);
    chart.view.pitch.set(saved.pitch);
    chart.view.zoom.set(saved.zoom);
    chart.timeline.seek(saved.position);
    chart.timeline.playing = saved.playing;
    chart.timeline._last = null;
    chart.visible = saved.visible;
    // Tweens started on the synthetic clock may be stamped in the future;
    // snap them so nothing waits for the real clock to catch up.
    snapTweens(chart);
    chart.invalidate();
  }
}

// Candidate codecs, best first. H.264 levels are chosen by frame size.
async function pickCodec(format, width, height, fps) {
  const px = width * height;
  const avc = px <= 921600 ? ['avc1.64001f', 'avc1.4d001f', 'avc1.42001f'] : px <= 2228224 ? ['avc1.640028', 'avc1.4d0028', 'avc1.420028'] : ['avc1.640033', 'avc1.4d0033'];
  const codecs = format === 'mp4' ? avc : ['vp09.00.40.08', 'vp8'];
  const bitrateValue = bitrate({ pixelWidth: width, pixelHeight: height, fps });
  for (const codec of codecs) {
    const config = { codec, width, height, framerate: fps, bitrate: bitrateValue, latencyMode: 'quality' };
    if (codec.startsWith('avc1')) config.avc = { format: 'avc' };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config);
      if (supported) return config;
    } catch {}
  }
  return null;
}

// Charts are flat colour with fine edges and text: give them generous bits.
function bitrate({ pixelWidth, pixelHeight, fps }) {
  return Math.round(Math.min(40e6, Math.max(2e6, pixelWidth * pixelHeight * fps * 0.15)));
}

function snapTweens(chart) {
  const seen = new Set();
  const visit = (v, depth) => {
    if (!v || typeof v !== 'object' || seen.has(v) || depth > 3) return;
    seen.add(v);
    if (v instanceof Tween) {
      if (v.value !== v.target) v.set(v.target);
      return;
    }
    if (v instanceof Map) for (const x of v.values()) visit(x, depth + 1);
    else if (Array.isArray(v)) for (const x of v) visit(x, depth + 1);
    else if (Object.getPrototypeOf(v) === Object.prototype || depth === 0) {
      for (const k of Object.keys(v)) if (k !== 'container' && k !== 'options') visit(v[k], depth + 1);
    }
  };
  visit(chart, 0);
}

function toBytes(src) {
  if (src instanceof Uint8Array) return src;
  if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength).slice();
  return new Uint8Array(src).slice();
}

const idle = () => new Promise((r) => setTimeout(r, 0));
