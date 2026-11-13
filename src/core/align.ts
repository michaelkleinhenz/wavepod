// Aligning recordings by their content: a guest's local recording (double-ender) onto the call
// track, or two field recorders (one per speaker, each mic hearing the other a little) onto each
// other. Works in three steps:
//
//   1. Coarse: the loudness contours (speech and pauses) of both tracks are cross-correlated over
//      their whole length, so the recorders can have been started minutes apart.
//   2. Fine: short windows spread over the recording are matched at the waveform (2 kHz,
//      high-passed), each to a fraction of a millisecond.
//   3. Drift: two recorders never run at exactly the same speed (their clocks differ by a few
//      dozen ppm, i.e. tens of milliseconds per hour). A line through the window offsets gives
//      the drift; the moving files are then resampled so the tracks stay in sync to the end.
import * as fs from 'node:fs';
import { readClip } from './clipSound';
import type { Clip, Project } from '../shared/types';
import type { AlignResult } from './alignEdit';

export * from './alignEdit';
import { ReaderCache } from './mixer';
import { WavReader, WavWriter } from './wav';
import { fft } from './fft';

/** Rate the waveforms are matched at; speech correlates well at this resolution. */
const ANALYSIS_RATE = 2000;
/** Rate of the loudness contour for the coarse search. */
const CONTOUR_RATE = 100;
/** The coarse search's FFT is kept below this many contour points (long episodes get coarser). */
const MAX_CONTOUR_POINTS = 1_500_000;
/** Length of each fine window (seconds). */
const WINDOW_SECONDS = 30;
/** How far (seconds) a fine window may land from the coarse match (covers drift and coarse error). */
const FINE_SEARCH_SECONDS = 2;
/** At most this many fine windows. */
const MAX_WINDOWS = 40;
/** A window agrees with the fit when it is this close (seconds). */
const AGREE_SECONDS = 0.002;
/** Drift is corrected once it adds up to this much (seconds) over the matched stretch. */
const MIN_DRIFT_SECONDS = 0.002;
/** Larger clock differences than this aren't drift but a wrong match (ratio, 0.2 %). */
const MAX_DRIFT = 0.002;

/**
 * Offset (in samples of `ref`) where `probe` matches `ref` best: probe[i] ≈ ref[i + lag], for lags
 * 0..maxLag. Returns the lag (with a sub-sample `fine` estimate) and a confidence 0..1
 * (normalised correlation).
 */
export function bestLag(ref: Float32Array, probe: Float32Array, maxLag = ref.length - 1, phat = false): { lag: number; fine: number; confidence: number; sharpness: number } {
  const c = correlate(ref, probe, phat);
  const size = c.length;
  let best = -Infinity;
  let lag = 0;
  for (let k = 0; k <= Math.min(maxLag, ref.length - 1); k++) {
    if (c[k] > best) {
      best = c[k];
      lag = k;
    }
  }
  // parabola through the peak and its neighbours
  let fine = lag;
  if (lag > 0 && lag < size - 1) {
    const a = c[lag - 1];
    const b = c[lag];
    const d = c[lag + 1];
    const den = a - 2 * b + d;
    if (den < 0) fine = lag + Math.max(-0.5, Math.min(0.5, (0.5 * (a - d)) / den));
  }
  // how far the peak stands out from the next best one (a few samples away from it)
  const guard = Math.max(3, Math.round(probe.length / 4000));
  let second = 0;
  for (let k = 0; k <= Math.min(maxLag, ref.length - 1); k++) if (Math.abs(k - lag) > guard && c[k] > second) second = c[k];
  const sharpness = best > 0 ? 1 - second / best : 0;
  let ep = 0;
  for (const v of probe) ep += v * v;
  let er = 0;
  for (let i = lag; i < Math.min(ref.length, lag + probe.length); i++) er += ref[i] * ref[i];
  return { lag, fine, confidence: ep > 0 && er > 0 && best > 0 ? best / Math.sqrt(ep * er) : 0, sharpness };
}

/** Cross-correlation by FFT: result[k] = Σ ref[i + k] · probe[i]; negative k at size + k. */
function correlate(ref: Float32Array, probe: Float32Array, phat = false): Float64Array {
  let size = 1;
  while (size < ref.length + probe.length) size <<= 1;
  const ar = new Float64Array(size);
  const ai = new Float64Array(size);
  const br = new Float64Array(size);
  const bi = new Float64Array(size);
  ar.set(ref);
  br.set(probe);
  fft(ar, ai);
  fft(br, bi);
  // ref ⋆ probe = IFFT(A · conj(B))
  let mean = 0;
  for (let i = 0; i < size; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const im = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = r;
    ai[i] = im;
    if (phat) mean += Math.hypot(r, im);
  }
  if (phat) {
    // phase transform: every frequency counts the same, so the loud direct voice can't drown the
    // quiet bleed the match relies on (GCC-PHAT); the small floor keeps silent bands from adding noise
    const floor = (mean / size) * 0.01 + 1e-30;
    for (let i = 0; i < size; i++) {
      const m = Math.hypot(ar[i], ai[i]) + floor;
      ar[i] /= m;
      ai[i] /= m;
    }
  }
  fft(ar, ai, true);
  return ar;
}

/**
 * The analysis signal of some clips over timeline frames [from, from + n * factor): mono, averaged
 * down by `factor` and high-passed (speech lines up, rumble doesn't). Read in blocks, so hours of
 * audio fit in memory.
 */
function analysisSignal(readers: ReaderCache, clips: Clip[], from: number, n: number, factor: number): Float32Array {
  const out = new Float32Array(n);
  const blockOut = 1 << 16;
  let prev = 0;
  for (let j0 = 0; j0 < n; j0 += blockOut) {
    const m = Math.min(blockOut, n - j0);
    const start = from + j0 * factor;
    const frames = m * factor;
    const mono = new Float32Array(frames);
    for (const c of clips) {
      const a = Math.max(start, c.start);
      const b = Math.min(start + frames, c.start + c.length);
      if (b <= a) continue;
      const reader = readers.get(c.file);
      if (!reader) continue;
      const data = readClip(reader, c, a - c.start, b - a);
      const l = data[0];
      const r = data[1];
      for (let i = 0; i < b - a; i++) mono[a - start + i] += r ? (l[i] + r[i]) / 2 : l[i];
    }
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let k = 0; k < factor; k++) s += mono[j * factor + k];
      const v = s / factor;
      out[j0 + j] = v - prev; // first difference: a cheap high-pass
      prev = v;
    }
  }
  return out;
}

/**
 * Loudness contour (log energy per `hop` samples) with the slow level changes taken out, so what is
 * left is the pattern of syllables and pauses, which both mics share even when one of them hears a
 * speaker only faintly. Stretches without audio are flat.
 */
function contour(sig: Float32Array, hop: number, rate: number): Float32Array {
  const n = Math.floor(sig.length / hop);
  const ms = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < hop; k++) {
      const v = sig[i * hop + k];
      s += v * v;
    }
    ms[i] = s / hop;
  }
  const audible = [...ms].filter((v) => v > 0).sort((a, b) => a - b);
  const out = new Float32Array(n);
  if (!audible.length) return out;
  // noise floor: quieter than this is all "pause"
  const floor = Math.max(1e-12, audible[Math.floor(audible.length * 0.1)]);
  const e = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    e[i] = Math.log(ms[i] + floor);
    if (ms[i] > 0) mean += e[i];
  }
  mean /= audible.length;
  for (let i = 0; i < n; i++) if (ms[i] === 0) e[i] = mean;
  // take out the local mean over about two seconds
  const win = Math.max(1, Math.round(rate / hop));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + e[i];
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - win);
    const b = Math.min(n, i + win + 1);
    const v = ms[i] === 0 ? 0 : e[i] - (prefix[b] - prefix[a]) / (b - a);
    out[i] = v;
    sq += v * v;
  }
  // limit outliers (a cough, a door) so they can't dominate
  const sd = Math.sqrt(sq / Math.max(1, audible.length)) || 1;
  for (let i = 0; i < n; i++) out[i] = Math.max(-3, Math.min(3, out[i] / sd));
  return out;
}

interface Point {
  at: number;
  offset: number;
  weight: number;
}

/** A line offset = a + k · (t − t0) through the points that agree with it (robust to stray windows). */
function fitLine(points: Point[], tol: number, allowSlope: boolean): { a: number; k: number; t0: number; used: Point[] } {
  const line = (p: Point, q: Point) => {
    const k = allowSlope && q.at !== p.at ? (q.offset - p.offset) / (q.at - p.at) : 0;
    return { k, a: p.offset, t0: p.at };
  };
  let bestUsed: Point[] = [];
  let bestScore = -1;
  for (let i = 0; i < points.length; i++) {
    for (let j = allowSlope ? i : points.length - 1; j < points.length; j++) {
      const { a, k, t0 } = line(points[i], points[allowSlope ? j : i]);
      if (Math.abs(k) > MAX_DRIFT) continue;
      const used = points.filter((p) => Math.abs(a + k * (p.at - t0) - p.offset) <= tol);
      const score = used.reduce((s, p) => s + p.weight, 0);
      if (score > bestScore) {
        bestScore = score;
        bestUsed = used;
      }
    }
  }
  // least squares through the agreeing points, weighted by match quality
  const used = bestUsed.length ? bestUsed : points;
  const w = used.reduce((s, p) => s + p.weight, 0) || 1;
  const t0 = used.reduce((s, p) => s + p.at * p.weight, 0) / w;
  const a = used.reduce((s, p) => s + p.offset * p.weight, 0) / w;
  let num = 0;
  let den = 0;
  for (const p of used) {
    num += p.weight * (p.at - t0) * (p.offset - a);
    den += p.weight * (p.at - t0) ** 2;
  }
  const k = allowSlope && den > 0 ? num / den : 0;
  return { a, k, t0, used };
}

/**
 * How `clipIds` (all on one track, e.g. every clip of a field recorder's track) have to move to
 * line up with what `refTrackId` recorded. Reads both tracks in full; runs in a worker.
 */
export function alignClips(project: Project, dir: string, clipIds: string[], refTrackId: string): AlignResult {
  const ref = project.tracks.find((t) => t.id === refTrackId);
  const moving = project.tracks.flatMap((t) => t.clips.filter((c) => clipIds.includes(c.id)).map((c) => ({ c, t })));
  if (!moving.length || !ref) throw new Error('Pick the clips to move and a track to align them to.');
  if (moving.some((m) => m.t.id === ref.id)) throw new Error('The reference must be a different track.');
  if (!ref.clips.length) throw new Error(`${ref.name} has no audio to align to.`);
  return alignClipSets(project, dir, moving.map((m) => m.c), ref.clips, ref.name);
}

/**
 * Like alignClips, against particular clips instead of a whole track: a remote guest's uploaded
 * recording onto the call audio of the same take, which sits on the same track (as another take).
 * `refClips` need not be on the timeline.
 */
export function alignToClips(project: Project, dir: string, clipIds: string[], refClips: Clip[]): AlignResult {
  const clips = project.tracks.flatMap((t) => t.clips.filter((c) => clipIds.includes(c.id)));
  if (!clips.length || !refClips.length) throw new Error('Nothing to align.');
  return alignClipSets(project, dir, clips, refClips, 'the call audio');
}

function alignClipSets(project: Project, dir: string, clips: Clip[], refClips: Clip[], refName: string): AlignResult {
  const ref = { name: refName, clips: refClips };
  const sr = project.sampleRate;
  const factor = Math.max(1, Math.round(sr / ANALYSIS_RATE));
  const rate = sr / factor;
  const span = (cs: Clip[]) => [Math.min(...cs.map((c) => c.start)), Math.max(...cs.map((c) => c.start + c.length))];
  const [mFrom, mTo] = span(clips);
  const [rFrom, rTo] = span(ref.clips);
  const readers = new ReaderCache(dir);
  try {
    const mSig = analysisSignal(readers, clips, mFrom, Math.floor((mTo - mFrom) / factor), factor);
    const rSig = analysisSignal(readers, ref.clips, rFrom, Math.floor((rTo - rFrom) / factor), factor);

    // 1. coarse: loudness contours over the whole length
    const hop = Math.max(Math.round(rate / CONTOUR_RATE), Math.ceil((mSig.length + rSig.length) / MAX_CONTOUR_POINTS));
    const mEnv = contour(mSig, hop, rate);
    const rEnv = contour(rSig, hop, rate);
    if (mEnv.length < 2 || rEnv.length < 2) throw new Error('The clips are too short to align.');
    const c = correlate(rEnv, mEnv);
    const size = c.length;
    const hopRate = rate / hop;
    // the two have to share some audio: half the shorter one, at most 30 s
    const minOverlap = Math.max(1, Math.min(Math.round(30 * hopRate), Math.floor(Math.min(mEnv.length, rEnv.length) / 2)));
    let coarseLag = 0;
    let best = -Infinity;
    for (let lag = -(mEnv.length - minOverlap); lag <= rEnv.length - minOverlap; lag++) {
      const v = c[(lag + size) % size];
      if (v > best) {
        best = v;
        coarseLag = lag;
      }
    }
    // moving timeline frame t ↔ reference frame t + coarse
    const coarse = rFrom - mFrom + coarseLag * hop * factor;

    // 2. fine: windows over the shared stretch, each matched at the waveform
    const a = Math.max(mFrom, rFrom - coarse);
    const b = Math.min(mTo, rTo - coarse);
    if (b - a < sr) throw new Error(`The clips and ${ref.name} don't share enough audio to align.`);
    const margin = Math.round(FINE_SEARCH_SECONDS * rate);
    const winLen = Math.min(Math.round(WINDOW_SECONDS * rate), Math.floor((b - a) / factor));
    const usable = (b - a) / factor - winLen;
    const count = Math.max(1, Math.min(MAX_WINDOWS, Math.floor((b - a) / sr / 30) + 1, usable > 0 ? MAX_WINDOWS : 1));
    const points: Point[] = [];
    let measured = 0;
    for (let w = 0; w < count; w++) {
      const startFrame = a + Math.round(count === 1 ? Math.max(0, usable) / 2 : (usable * w) / (count - 1)) * factor;
      const mi = Math.round((startFrame - mFrom) / factor);
      const probe = mSig.subarray(mi, mi + winLen);
      // skip pauses: nothing to match there
      let e = 0;
      for (const v of probe) e += v * v;
      if (e === 0) continue;
      const mStart = mFrom + mi * factor;
      const refFirst = Math.max(0, Math.round((mStart + coarse - rFrom) / factor) - margin);
      const refLast = Math.min(rSig.length, refFirst + winLen + 2 * margin);
      if (refLast - refFirst < winLen) continue;
      measured++;
      const m = bestLag(rSig.subarray(refFirst, refLast), probe, refLast - refFirst - winLen, true);
      if (m.sharpness <= 0) continue;
      const refFrame = rFrom + (refFirst + m.fine) * factor;
      points.push({ at: mStart + (winLen * factor) / 2, offset: refFrame - mStart, weight: m.sharpness });
    }

    const overlapSeconds = (b - a) / sr;
    if (!points.length) return { shift: coarse, anchor: (a + b) / 2, drift: 0, confidence: 0, windows: 0, measured, overlapSeconds };
    // windows in a pause or under noise have no clear peak
    const good = points.filter((p) => p.weight >= 0.1);
    if (!good.length) return { shift: coarse, anchor: (a + b) / 2, drift: 0, confidence: 0, windows: 0, measured, overlapSeconds };
    const tol = AGREE_SECONDS * sr;

    // 3. drift: a sloped line through the windows, kept only if it matters and is well supported
    let fit = fitLine(good, tol, false);
    const sloped = good.length >= 3 ? fitLine(good, tol, true) : null;
    if (sloped && sloped.used.length >= 3 && sloped.used.length >= fit.used.length) {
      const ats = sloped.used.map((p) => p.at);
      const stretch = Math.max(...ats) - Math.min(...ats);
      if (Math.abs(sloped.k) * stretch >= MIN_DRIFT_SECONDS * sr && Math.abs(sloped.k) <= MAX_DRIFT) fit = sloped;
    }
    // several windows: the share that agrees; one or two: how clearly the match stood out
    const confidence = measured >= 3 ? fit.used.length / measured : fit.used.reduce((s, p) => s + p.weight, 0) / fit.used.length;
    // offset = shift needed at t; with stretch 1 + drift around the anchor, slope k = drift
    return { shift: fit.a, anchor: fit.t0, drift: fit.k, confidence, windows: fit.used.length, measured, overlapSeconds };
  } finally {
    readers.closeAll();
  }
}

// ------------------------------------------------------------------ drift: resampling a file

const SINC_HALF = 12;
const SINC_PHASES = 512;
let sincTable: Float32Array | null = null;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 30; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

/** Kaiser-windowed sinc, SINC_PHASES + 1 rows of 2·SINC_HALF taps. */
function kernel(): Float32Array {
  if (sincTable) return sincTable;
  const taps = 2 * SINC_HALF;
  const cutoff = 0.97;
  const beta = 8;
  const t = new Float32Array((SINC_PHASES + 1) * taps);
  for (let p = 0; p <= SINC_PHASES; p++) {
    const f = p / SINC_PHASES;
    for (let n = 0; n < taps; n++) {
      const x = n - (SINC_HALF - 1) - f; // tap n reads sample i + n - (SINC_HALF - 1)
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      const r = x / SINC_HALF;
      const win = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / besselI0(beta);
      t[p * taps + n] = cutoff * sinc * win;
    }
  }
  sincTable = t;
  return t;
}

/**
 * Writes a copy of the WAV `src` stretched by `stretch` (1.0001 = 100 ppm longer), with a
 * windowed-sinc resampler, so a recorder whose clock ran fast or slow plays in step with the others.
 * Pitch changes by the same tiny amount, far below what anyone hears.
 */
export function stretchWav(src: string, dest: string, stretch: number, onProgress?: (fraction: number) => void): void {
  const reader = new WavReader(src);
  const { channels, sampleRate, bitDepth, frames } = reader.info;
  const tmp = `${dest}.part`;
  const writer = new WavWriter(tmp, channels, sampleRate, bitDepth, 1 << 20, 0, { rf64: true });
  const taps = 2 * SINC_HALF;
  const k = kernel();
  try {
    const total = Math.round(frames * stretch);
    const block = 1 << 16;
    const out = Array.from({ length: channels }, () => new Float32Array(block));
    for (let q0 = 0; q0 < total; q0 += block) {
      const n = Math.min(block, total - q0);
      const first = Math.floor(q0 / stretch) - SINC_HALF;
      const last = Math.floor((q0 + n - 1) / stretch) + SINC_HALF + 1;
      const data = reader.read(first, last - first + 1);
      for (let ch = 0; ch < channels; ch++) {
        const d = data[ch];
        const o = out[ch];
        for (let i = 0; i < n; i++) {
          const x = (q0 + i) / stretch;
          const ix = Math.floor(x);
          const pf = (x - ix) * SINC_PHASES;
          const p = Math.floor(pf);
          const frac = pf - p;
          const row0 = p * taps;
          const row1 = row0 + taps;
          const base = ix - (SINC_HALF - 1) - first;
          let acc = 0;
          for (let t = 0; t < taps; t++) {
            const w = k[row0 + t] + (k[row1 + t] - k[row0 + t]) * frac;
            acc += d[base + t] * w;
          }
          o[i] = acc;
        }
      }
      writer.write(out, n);
      onProgress?.((q0 + n) / total);
    }
    writer.close();
    fs.renameSync(tmp, dest);
  } catch (e) {
    try {
      writer.close();
    } catch {
      // already closed
    }
    fs.rmSync(tmp, { force: true });
    throw e;
  } finally {
    reader.close();
  }
}

