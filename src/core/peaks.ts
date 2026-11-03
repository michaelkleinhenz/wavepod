// Multi-resolution waveform peaks ("mipmaps"), as Reaper keeps them in .reapeaks files.
//
// Level 0 holds one min/max pair per PEAK_BASE samples, each further level aggregates
// PEAK_FACTOR buckets of the one below. Drawing picks the level whose buckets are just
// finer than a pixel, so every pixel column reads at most PEAK_FACTOR buckets however far
// out the view is zoomed. Zoomed in past level 0, the renderer reads raw samples instead.
import type { PeakLevel, WaveformPeaks } from '../shared/types';

/** Samples per bucket of the finest level. */
export const PEAK_BASE = 64;
export const PEAK_FACTOR = 4;
/** 64, 256, 1024, 4096, 16384, 65536 samples per bucket. */
export const PEAK_LEVELS = 6;
/** Levels this fine or finer are not sent whole to the renderer but read in tiles. */
export const TILED_MAX_SPP = PEAK_BASE;
/** Buckets per peak tile. */
export const PEAK_TILE = 4096;
/** Frames per raw sample tile. */
export const SAMPLE_TILE = 16384;

// v3: peaks follow the played channels (envelope of L and R) instead of averaging all
const MAGIC = 0x334b5057; // "WPK3"

/** Growable int8 buffer of interleaved min,max pairs. */
export class PairBuffer {
  private buf: Int8Array;
  length = 0;

  constructor(capacity = 1024) {
    this.buf = new Int8Array(Math.max(2, capacity * 2));
  }

  /** Number of pairs. */
  get count(): number {
    return this.length >> 1;
  }

  push(min: number, max: number): void {
    if (this.length + 2 > this.buf.length) {
      const next = new Int8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = min;
    this.buf[this.length++] = max;
  }

  /** View of the pairs written so far (valid until the next push). */
  view(): Int8Array {
    return this.buf.subarray(0, this.length);
  }
}

interface LevelState {
  spp: number;
  data: PairBuffer;
  min: number;
  max: number;
  n: number;
}

/**
 * Builds all levels from finished level-0 buckets. Used while recording (fed by
 * MipmapBuilder) and in the renderer for the live waveform (fed by streamed buckets).
 */
export class PeakPyramid {
  private levels: LevelState[] = [];

  constructor(readonly base = PEAK_BASE, levels = PEAK_LEVELS, readonly factor = PEAK_FACTOR, capacity = 1024) {
    for (let i = 0, spp = base; i < levels; i++, spp *= factor) {
      this.levels.push({ spp, data: new PairBuffer(Math.max(16, capacity >> (2 * i))), min: 127, max: -127, n: 0 });
    }
  }

  /** Finished level-0 buckets. */
  get count(): number {
    return this.levels[0].data.count;
  }

  /** Appends a level-0 bucket (quantised -127..127) and cascades it up. */
  push(min: number, max: number): void {
    this.levels[0].data.push(min, max);
    for (let i = 1; i < this.levels.length; i++) {
      const l = this.levels[i];
      if (min < l.min) l.min = min;
      if (max > l.max) l.max = max;
      if (++l.n < this.factor) return;
      l.data.push(l.min, l.max);
      min = l.min;
      max = l.max;
      l.min = 127;
      l.max = -127;
      l.n = 0;
    }
  }

  /** Level-0 pairs from bucket `from` on. */
  baseFrom(from: number): Int8Array {
    return this.levels[0].data.view().subarray(from * 2);
  }

  /**
   * Every level. With `partial`, buckets that are still being aggregated are appended
   * (copying those levels), so the coarse levels reach the end of the audio. Without it
   * the levels are views and lack less than one bucket at their end.
   */
  levelsSnapshot(partial = true): PeakLevel[] {
    return this.levels.map((l, i) => {
      const done = l.data.view();
      if (!partial || i === 0) return { samplesPerPeak: l.spp, data: done };
      // the pending bucket also covers the not yet cascaded parts of the finer levels
      let mn = 127;
      let mx = -127;
      let pending = false;
      for (let j = i; j > 0; j--) {
        const f = this.levels[j];
        if (f.n === 0) continue;
        pending = true;
        mn = Math.min(mn, f.min);
        mx = Math.max(mx, f.max);
      }
      if (!pending) return { samplesPerPeak: l.spp, data: done };
      const out = new Int8Array(done.length + 2);
      out.set(done);
      out[done.length] = mn;
      out[done.length + 1] = mx;
      return { samplesPerPeak: l.spp, data: out };
    });
  }
}

/**
 * Accumulates mipmapped min/max peaks from audio. Feed planar chunks. The peaks are the
 * envelope of the channels that play (the first two, as the mixer plays L and R), so a
 * multichannel or half-silent stereo file is drawn at the level it is heard, not averaged
 * down.
 */
export class MipmapBuilder {
  readonly pyramid: PeakPyramid;
  private min = Infinity;
  private max = -Infinity;
  private n = 0;
  private total = 0;

  constructor(base = PEAK_BASE, levels = PEAK_LEVELS, factor = PEAK_FACTOR, expectedFrames = 0) {
    this.pyramid = new PeakPyramid(base, levels, factor, Math.ceil(expectedFrames / base) || 1024);
  }

  get samplesPerPeak(): number {
    return this.pyramid.base;
  }

  /** Finished level-0 buckets. */
  get bucketCount(): number {
    return this.pyramid.count;
  }

  /** Level-0 buckets from `from` on, as interleaved min,max values (-127..127). */
  bucketsFrom(from: number): number[] {
    return Array.from(this.pyramid.baseFrom(from));
  }

  push(channels: Float32Array[], frames = channels[0]?.length ?? 0): void {
    const spp = this.pyramid.base;
    const l = channels[0];
    const r = channels.length > 1 ? channels[1] : null;
    if (!l) return;
    for (let i = 0; i < frames; i++) {
      const a = l[i];
      const b = r ? r[i] : a;
      if ((a < b ? a : b) < this.min) this.min = a < b ? a : b;
      if ((a < b ? b : a) > this.max) this.max = a < b ? b : a;
      if (++this.n === spp) this.emit();
    }
    this.total += frames;
  }

  private emit(): void {
    this.pyramid.push(quantize(this.min), quantize(this.max));
    this.min = Infinity;
    this.max = -Infinity;
    this.n = 0;
  }

  finish(): WaveformPeaks {
    if (this.n > 0) this.emit();
    return { length: this.total, levels: this.pyramid.levelsSnapshot(true).map((l) => ({ ...l, data: l.data.slice() })) };
  }
}

export function quantize(v: number): number {
  return Math.max(-127, Math.min(127, Math.round(v * 127))) || 0; // no -0
}

// ---------------------------------------------------------------- file format
//
// "WPK2" (u32), length in frames (f64), level count (u32), then per level
// samplesPerPeak (u32) and bucket count (u32), then each level's int8 pairs in order.

export interface PeakFileLayout {
  length: number;
  levels: Array<{ samplesPerPeak: number; buckets: number; offset: number }>;
}

export function headerSize(levels: number): number {
  return 16 + levels * 8;
}

export function encodePeaks(p: WaveformPeaks): Buffer {
  const head = Buffer.alloc(headerSize(p.levels.length));
  head.writeUInt32LE(MAGIC, 0);
  head.writeDoubleLE(p.length, 4);
  head.writeUInt32LE(p.levels.length, 12);
  p.levels.forEach((l, i) => {
    head.writeUInt32LE(l.samplesPerPeak, 16 + i * 8);
    head.writeUInt32LE(l.data.length / 2, 20 + i * 8);
  });
  return Buffer.concat([head, ...p.levels.map((l) => Buffer.from(l.data.buffer, l.data.byteOffset, l.data.byteLength))]);
}

/** Parses the header of a peak file; null for another or an older format. */
export function parsePeakHeader(buf: Buffer, fileSize = buf.length): PeakFileLayout | null {
  if (buf.length < 16 || buf.readUInt32LE(0) !== MAGIC) return null;
  const n = buf.readUInt32LE(12);
  if (n < 1 || n > 32 || buf.length < headerSize(n)) return null;
  let offset = headerSize(n);
  const levels: PeakFileLayout['levels'] = [];
  for (let i = 0; i < n; i++) {
    const samplesPerPeak = buf.readUInt32LE(16 + i * 8);
    const buckets = buf.readUInt32LE(20 + i * 8);
    if (samplesPerPeak < 1) return null;
    levels.push({ samplesPerPeak, buckets, offset });
    offset += buckets * 2;
  }
  if (offset > fileSize) return null;
  return { length: buf.readDoubleLE(4), levels };
}

export function decodePeaks(buf: Buffer): WaveformPeaks | null {
  const layout = parsePeakHeader(buf);
  if (!layout) return null;
  return {
    length: layout.length,
    levels: layout.levels.map((l) => ({
      samplesPerPeak: l.samplesPerPeak,
      data: Int8Array.from(new Int8Array(buf.buffer, buf.byteOffset + l.offset, l.buckets * 2)),
    })),
  };
}

/**
 * One drawable value per frame, like the peaks: of the played channels (L and R) the one
 * further from zero, so single samples line up with the peak bars around them.
 */
export function mixToMono(channels: Float32Array[], frames: number): Float32Array {
  const out = new Float32Array(frames);
  const l = channels[0];
  if (!l) return out;
  const r = channels.length > 1 ? channels[1] : null;
  for (let i = 0; i < frames; i++) {
    const a = l[i];
    const b = r ? r[i] : a;
    out[i] = Math.abs(b) > Math.abs(a) ? b : a;
  }
  return out;
}

// ---------------------------------------------------------------- level choice

export type WaveSourceKind = { kind: 'samples' } | { kind: 'peaks'; samplesPerPeak: number };

/**
 * What to draw at `framesPerPx`: raw samples below the finest peak level, otherwise the
 * coarsest level whose buckets are still at most one pixel wide (so a pixel never reads
 * more than PEAK_FACTOR buckets).
 */
export function chooseWaveSource(framesPerPx: number, levels: number[]): WaveSourceKind {
  const sorted = [...levels].sort((a, b) => a - b);
  if (!sorted.length || framesPerPx < sorted[0]) return { kind: 'samples' };
  let best = sorted[0];
  for (const spp of sorted) if (spp <= framesPerPx) best = spp;
  return { kind: 'peaks', samplesPerPeak: best };
}
