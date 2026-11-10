// Sound design on clips: reverse, varispeed (tape style, so pitch follows speed) and looping a clip
// to fill a span (ambiences, room tone). A plain clip reads its file 1:1 from `offset`; a clip with
// `sound` maps each timeline frame through these settings instead (see ClipSound in shared/types).
// The clip's `offset` and volume line stay in virtual frames that run 1:1 with the timeline, so
// trims, splits, copies and the volume line need no special cases.
import type { Clip, ClipSound, EnvelopePoint } from '../shared/types';

export const MIN_RATE = 0.25;
export const MAX_RATE = 4;
/** Crossfade at every loop seam, so a cycle that does not end where it starts doesn't click. */
export const LOOP_SEAM_SECONDS = 0.03;
/** Shortest loop cycle (source frames), so a slip of the mouse can't make millions of seams. */
const MIN_CYCLE = 64;

/** The part of the file reading a clip needs (WavReader fits). */
export interface ClipSource {
  info: { channels: number; frames: number; sampleRate?: number };
  read(start: number, count: number, out?: Float32Array[]): Float32Array[];
}

export function clipRate(c: Clip): number {
  return c.sound?.rate ?? 1;
}

/** True when the clip plays its file backwards, faster or slower, or looped. */
export function isSoundDesigned(c: Clip): boolean {
  return !!c.sound;
}

/** Varispeed as semitones (rate 2 = +12). */
export function rateToSemitones(rate: number): number {
  return 12 * Math.log2(rate);
}

export function semitonesToRate(st: number): number {
  return 2 ** (st / 12);
}

export function clampRate(rate: number): number {
  return Number.isFinite(rate) && rate > 0 ? Math.min(MAX_RATE, Math.max(MIN_RATE, rate)) : 1;
}

/** One straight stretch of a clip: clip-relative timeline frames [t0, t1) play source `src + (t - t0) * step`. */
export interface ClipPiece {
  t0: number;
  t1: number;
  src: number;
  /** Source frames per timeline frame; negative when reversed. */
  step: number;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/**
 * The straight stretches of a clip in clip-relative timeline frames [from, to) (fractional bounds
 * where a loop wraps). A plain clip is a single piece.
 */
export function clipPieces(c: Clip, from = 0, to = c.length): ClipPiece[] {
  if (to <= from) return [];
  const s = c.sound;
  if (!s) return [{ t0: from, t1: to, src: c.offset + from, step: 1 }];
  const rate = s.rate ?? 1;
  const step = s.reverse ? -rate : rate;
  const u = (t: number) => (c.offset + t - s.base) * rate;
  if (!s.loop) {
    const src = s.reverse ? s.start + s.length - 1 - u(from) : s.start + u(from);
    return [{ t0: from, t1: to, src, step }];
  }
  const len = Math.max(MIN_CYCLE, s.length);
  const cycleT = len / rate;
  const pieces: ClipPiece[] = [];
  let t = from;
  // guard: a tiny cycle over a huge span would make endless pieces
  for (let n = 0; t < to && n < 100000; n++) {
    const ul = mod(u(t), len);
    const end = Math.min(to, t + (len - ul) / rate);
    pieces.push({ t0: t, t1: end, src: s.reverse ? s.start + len - 1 - ul : s.start + ul, step });
    t = end > t ? end : t + cycleT;
  }
  return pieces;
}

/** Loop seams (clip-relative timeline frames where a new cycle starts) inside (from, to]. */
export function loopSeams(c: Clip, from = 0, to = c.length): number[] {
  if (!c.sound?.loop) return [];
  return clipPieces(c, from, to)
    .slice(1)
    .map((p) => p.t0);
}

let readScratch: Float32Array[] = [];

/** Adds `n` frames of source read along `src + i * step` (cubic interpolation) into dest[ch][at + i], times w(i). */
function addLinear(reader: ClipSource, src: number, step: number, n: number, dest: Float32Array[], at: number, w?: (i: number) => number): void {
  if (n <= 0) return;
  const chans = Math.min(dest.length, reader.info.channels);
  const last = src + (n - 1) * step;
  const lo = Math.floor(Math.min(src, last)) - 1;
  const count = Math.floor(Math.max(src, last)) + 3 - lo;
  if (readScratch.length < reader.info.channels || (readScratch[0]?.length ?? 0) < count) {
    const size = Math.max(count, readScratch[0]?.length ?? 0);
    readScratch = Array.from({ length: Math.max(2, reader.info.channels) }, () => new Float32Array(size));
  }
  const data = reader.read(lo, count, readScratch);
  const whole = Number.isInteger(src) && Number.isInteger(step);
  for (let ch = 0; ch < chans; ch++) {
    const d = data[ch];
    const o = dest[ch];
    for (let i = 0; i < n; i++) {
      const x = src + i * step - lo;
      let v: number;
      if (whole) v = d[x];
      else {
        const j = Math.floor(x);
        const f = x - j;
        // 4-point Hermite
        const y0 = d[j - 1];
        const y1 = d[j];
        const y2 = d[j + 1];
        const y3 = d[j + 2];
        const c1 = 0.5 * (y2 - y0);
        const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
        const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
        v = ((c3 * f + c2) * f + c1) * f + y1;
      }
      o[at + i] += w ? v * w(i) : v;
    }
  }
}

/**
 * Reads clip-relative timeline frames [from, from + n) of a clip as it plays (reverse, varispeed,
 * loop with seam crossfades; no gain or fades). Returns planar arrays with the file's channel count,
 * reusing `out` when it is large enough.
 */
export function readClip(reader: ClipSource, c: Clip, from: number, n: number, out?: Float32Array[]): Float32Array[] {
  if (!c.sound) return reader.read(c.offset + from, n, out);
  const chans = reader.info.channels;
  const dest = out && out.length >= chans && out[0].length >= n ? out : Array.from({ length: Math.max(chans, 1) }, () => new Float32Array(n));
  for (const d of dest) d.fill(0, 0, n);
  const to = from + n;
  const pieces = clipPieces(c, from, to);
  for (const p of pieces) {
    const a = Math.max(from, Math.ceil(p.t0));
    const b = Math.min(to, Math.ceil(p.t1));
    if (b > a) addLinear(reader, p.src + (a - p.t0) * p.step, p.step, b - a, dest, a - from);
  }
  if (c.sound.loop) seamCrossfades(reader, c, from, n, dest);
  return dest;
}

/**
 * Smooths each loop wrap. Over the last ~30 ms of a cycle it crossfades into the next cycle's
 * run-up (the audio just before the span, or just after it when reversed), so the next cycle
 * starts already at full level. Where the file has no such run-up (a loop of the whole file),
 * it dips briefly instead (a millisecond out and in), which is enough to stop the click.
 */
function seamCrossfades(reader: ClipSource, c: Clip, from: number, n: number, dest: Float32Array[]): void {
  const s = c.sound!;
  const rate = s.rate ?? 1;
  const sr = reader.info.sampleRate ?? 48000;
  const len = Math.max(MIN_CYCLE, s.length);
  const cycleT = len / rate;
  // timeline frames of run-up the file has before the cycle (after it when reversed)
  const runUp = (s.reverse ? reader.info.frames - (s.start + len) : s.start) / rate;
  const w = Math.min(cycleT / 4, LOOP_SEAM_SECONDS * sr, Math.max(0, runUp));
  const dip = Math.min(cycleT / 8, Math.round(0.0015 * sr));
  const crossfade = w >= 8;
  const reach = crossfade ? w : dip;
  if (reach < 2) return;
  const to = from + n;
  const chans = Math.min(dest.length, reader.info.channels);
  const scale = (a: number, b: number, g: (t: number) => number) => {
    for (let t = Math.max(from, a); t < Math.min(to, b); t++) {
      const k = g(t);
      for (let ch = 0; ch < chans; ch++) dest[ch][t - from] *= k;
    }
  };
  const pieces = clipPieces(c, Math.max(0, from - reach), Math.min(c.length, to + reach));
  for (const next of pieces.slice(1)) {
    const seam = next.t0;
    if (seam <= 0 || seam >= c.length) continue;
    if (!crossfade) {
      scale(Math.ceil(seam - dip), Math.ceil(seam), (t) => (seam - t) / dip);
      scale(Math.ceil(seam), Math.ceil(seam + dip), (t) => (t - seam) / dip);
      continue;
    }
    const a = Math.max(from, Math.ceil(seam - w));
    const b = Math.min(to, Math.ceil(seam));
    if (b <= a) continue;
    const phase = (t: number) => ((t - (seam - w)) / w) * (Math.PI / 2);
    scale(a, b, (t) => Math.cos(phase(t)));
    // the next cycle, run on backwards in time from its start
    addLinear(reader, next.src + (a - seam) * next.step, next.step, b - a, dest, a - from, (i) => Math.sin(phase(a + i)));
  }
}

// ------------------------------------------------------------------ edits (pure, return a new clip)

/** The sound settings of a clip, made up for a plain one (nothing changes how it sounds yet). */
function soundOf(c: Clip): ClipSound {
  return c.sound ? { ...c.sound } : { start: c.offset, length: c.length, base: c.offset };
}

/**
 * Re-anchors a non-looping clip's span to what it plays right now (base = offset, span = exactly
 * the source under the clip), which keeps the sound identical.
 */
function anchored(c: Clip, s: ClipSound): ClipSound {
  if (s.loop) return s;
  const rate = s.rate ?? 1;
  const d = (c.offset - s.base) * rate;
  const length = c.length * rate;
  const start = s.reverse ? s.start + s.length - d - length : s.start + d;
  return { ...s, start, length, base: c.offset };
}

/** Drops `sound` once it does nothing any more, turning the clip back into a plain one. */
function simplified(c: Clip): Clip {
  const s = c.sound;
  if (!s || s.reverse || s.loop || (s.rate !== undefined && s.rate !== 1)) return c;
  // forward at rate 1: source = virtual + (start - base); shift offset and volume line by that
  const shift = Math.round(s.start - s.base);
  const plain: Clip = { ...c, offset: c.offset + shift };
  delete plain.sound;
  if (c.envelope) plain.envelope = c.envelope.map((p) => ({ ...p, pos: p.pos + shift }));
  return plain;
}

function withSound(c: Clip, s: ClipSound): Clip {
  const out: Clip = { ...c, sound: s };
  if (!s.reverse) delete s.reverse;
  if (!s.loop) delete s.loop;
  if (s.rate === undefined || s.rate === 1) delete s.rate;
  return simplified(out);
}

function clampFades(c: Clip): Clip {
  const half = Math.floor(c.length / 2);
  return c.fadeIn + c.fadeOut > c.length ? { ...c, fadeIn: Math.min(c.fadeIn, half), fadeOut: Math.min(c.fadeOut, c.length - Math.min(c.fadeIn, half)) } : c;
}

/** Plays the clip backwards (or forwards again); the clip keeps its place and length. */
export function setClipReverse(c: Clip, on: boolean): Clip {
  if (!!c.sound?.reverse === on) return c;
  const s = anchored(c, soundOf(c));
  s.reverse = on;
  return withSound(c, s);
}

/**
 * Varispeed: plays the clip `rate` times as fast, pitch following (2 = an octave up, twice as fast).
 * A normal clip keeps the audio it plays and gets shorter or longer; a looping one keeps its length.
 */
export function setClipRate(c: Clip, rate: number): Clip {
  const r = clampRate(rate);
  const old = clipRate(c);
  if (Math.abs(r - old) < 1e-9) return c;
  const s = soundOf(c);
  if (s.loop) {
    // keep where in the cycle the clip starts
    const u0 = (c.offset - s.base) * old;
    return withSound(c, { ...s, rate: r, base: c.offset - u0 / r });
  }
  const a = anchored(c, s);
  const k = old / r;
  const length = Math.max(1, Math.round(c.length * k));
  const scaled: Clip = {
    ...c,
    length,
    fadeIn: Math.round(c.fadeIn * k),
    fadeOut: Math.round(c.fadeOut * k),
    ...(c.envelope ? { envelope: c.envelope.map((p): EnvelopePoint => ({ ...p, pos: c.offset + (p.pos - c.offset) * k })) } : {}),
  };
  return clampFades(withSound(scaled, { ...a, rate: r, length: c.length * old }));
}

/**
 * Loop on: what the clip plays now becomes one cycle, and dragging the right edge (or Loop to fill)
 * repeats it. Loop off: the clip ends with the cycle it is in at its start.
 */
export function setClipLoop(c: Clip, on: boolean): Clip {
  if (!!c.sound?.loop === on) return c;
  const s = soundOf(c);
  const rate = s.rate ?? 1;
  if (on) {
    const a = anchored(c, s);
    if (a.length < MIN_CYCLE) return c;
    return withSound(c, { ...a, loop: true });
  }
  const len = Math.max(MIN_CYCLE, s.length);
  const m = mod((c.offset - s.base) * rate, len);
  const length = Math.max(1, Math.min(c.length, Math.floor((len - m) / rate)));
  return clampFades(withSound({ ...c, length }, { ...s, loop: false, base: c.offset - m / rate }));
}

/** Loops the clip and stretches it to end at `end` (timeline frame). Nothing happens when `end` is not after its start. */
export function loopClipTo(c: Clip, end: number): Clip {
  if (end <= c.start + 1) return c;
  const looped = setClipLoop(c, true);
  if (!looped.sound?.loop) return c;
  return clampFades({ ...looped, length: Math.round(end - c.start) });
}

/** Undoes reverse, varispeed and loop: the clip plays its file again as recorded, from where it starts now. */
export function resetClipSound(c: Clip): Clip {
  let out = setClipLoop(c, false);
  out = setClipRate(out, 1);
  return setClipReverse(out, false);
}

/** The earliest offset the left edge may be dragged to (a loop can grow to the timeline start). */
export function minClipOffset(c: Clip): number {
  const s = c.sound;
  if (!s) return 0;
  if (s.loop || s.reverse) return -Infinity;
  // forward: source frame 0 at virtual base - start / rate
  return s.base - s.start / (s.rate ?? 1);
}

/** Short tag for the clip label, e.g. "◀ 1.50× ⟳". */
export function soundTag(c: Clip): string {
  const s = c.sound;
  if (!s) return '';
  const parts: string[] = [];
  if (s.reverse) parts.push('◀ rev');
  if (s.rate !== undefined && s.rate !== 1) {
    const st = rateToSemitones(s.rate);
    parts.push(`${s.rate.toFixed(2)}× (${st > 0 ? '+' : ''}${st.toFixed(1)} st)`);
  }
  if (s.loop) parts.push('⟳ loop');
  return parts.join('  ');
}

/**
 * Parses a typed speed: "1.5", "1.5x", "150%" or semitones like "+3 st" / "-12st".
 * Returns null when it doesn't read as one.
 */
export function parseRateInput(text: string): number | null {
  const t = text.trim().toLowerCase().replace(',', '.').replace('−', '-');
  let m = /^([+-]?\d+(?:\.\d+)?)\s*(st|semi|semitones?|halbt(?:on|öne)?)$/.exec(t);
  if (m) return clampRate(semitonesToRate(Number(m[1])));
  m = /^(\d+(?:\.\d+)?)\s*%$/.exec(t);
  if (m) return Number(m[1]) > 0 ? clampRate(Number(m[1]) / 100) : null;
  m = /^(\d*\.?\d+)\s*[x×]?$/.exec(t);
  if (m) return Number(m[1]) > 0 ? clampRate(Number(m[1])) : null;
  return null;
}
