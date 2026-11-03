// Double-ender alignment: finds where a guest's local recording lines up with the remote track
// that was recorded during the call, by cross-correlating their (decimated) audio.
import type { Clip, Project, Track } from '../shared/types';
import { ReaderCache } from './mixer';

/** Seconds of the clip compared with the reference. */
export const ALIGN_COMPARE_SECONDS = 90;
/** How far (seconds) from its current position the clip may move. */
export const ALIGN_SEARCH_SECONDS = 60;
/** Rate the audio is compared at; speech correlates well at this resolution. */
const ANALYSIS_RATE = 2000;

/** In-place radix-2 FFT (re, im of length 2^k). */
function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) (re[i] /= n), (im[i] /= n);
}

/**
 * Offset (in samples of `ref`) where `probe` matches `ref` best: probe[i] ≈ ref[i + lag].
 * Returns the lag and a confidence 0..1 (normalised correlation).
 */
export function bestLag(ref: Float32Array, probe: Float32Array): { lag: number; confidence: number } {
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
  for (let i = 0; i < size; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const im = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = r;
    ai[i] = im;
  }
  fft(ar, ai, true);
  let best = 0;
  let lag = 0;
  const maxLag = ref.length - 1;
  for (let k = 0; k <= maxLag; k++) {
    if (ar[k] > best) {
      best = ar[k];
      lag = k;
    }
  }
  let ep = 0;
  for (const v of probe) ep += v * v;
  let er = 0;
  for (let i = lag; i < Math.min(ref.length, lag + probe.length); i++) er += ref[i] * ref[i];
  return { lag, confidence: ep > 0 && er > 0 ? best / Math.sqrt(ep * er) : 0 };
}

/** Mono, high-passed (speech is what lines up, not rumble), averaged down to about ANALYSIS_RATE. */
function decimate(src: Float32Array[], frames: number, factor: number): Float32Array {
  const out = new Float32Array(Math.floor(frames / factor));
  let prev = 0;
  for (let j = 0; j < out.length; j++) {
    let s = 0;
    for (let k = 0; k < factor; k++) {
      const i = j * factor + k;
      s += src.length > 1 ? (src[0][i] + src[1][i]) / 2 : src[0][i];
    }
    const v = s / factor;
    out[j] = v - prev; // first difference: a cheap high-pass
    prev = v;
  }
  return out;
}

/** Reads a track's clips (gain and fades ignored: only timing matters) for [start, start + frames). */
function readTrack(readers: ReaderCache, track: Track, start: number, frames: number): Float32Array[] {
  const out = [new Float32Array(frames), new Float32Array(frames)];
  for (const c of track.clips) {
    const a = Math.max(start, c.start);
    const b = Math.min(start + frames, c.start + c.length);
    if (b <= a) continue;
    const reader = readers.get(c.file);
    if (!reader) continue;
    const data = reader.read(c.offset + (a - c.start), b - a);
    for (let i = 0; i < b - a; i++) {
      out[0][a - start + i] += data[0][i];
      out[1][a - start + i] += (data[1] ?? data[0])[i];
    }
  }
  return out;
}

export interface AlignResult {
  /** New timeline start for the clip. */
  start: number;
  /** How far it moves (frames, + = later). */
  shift: number;
  confidence: number;
}

/** Where `clipId` should start so it lines up with what `refTrackId` recorded. */
export function alignClip(project: Project, dir: string, clipId: string, refTrackId: string): AlignResult {
  const track = project.tracks.find((t) => t.clips.some((c) => c.id === clipId));
  const clip = track?.clips.find((c) => c.id === clipId) as Clip | undefined;
  const ref = project.tracks.find((t) => t.id === refTrackId);
  if (!clip || !ref) throw new Error('Pick a clip and a reference track.');
  if (ref.id === track!.id) throw new Error('The reference must be a different track.');
  const sr = project.sampleRate;
  const factor = Math.max(1, Math.round(sr / ANALYSIS_RATE));
  const compare = Math.min(clip.length, Math.round(ALIGN_COMPARE_SECONDS * sr));
  const search = Math.round(ALIGN_SEARCH_SECONDS * sr);
  const refStart = Math.max(0, clip.start - search);
  const refFrames = clip.start + search + compare - refStart;
  const readers = new ReaderCache(dir);
  try {
    const reader = readers.get(clip.file);
    if (!reader) throw new Error(`Can't read ${clip.file}`);
    const probe = decimate(reader.read(clip.offset, compare), compare, factor);
    const refAudio = decimate(readTrack(readers, ref, refStart, refFrames), refFrames, factor);
    const { lag, confidence } = bestLag(refAudio, probe);
    const start = Math.max(0, refStart + lag * factor);
    return { start, shift: start - clip.start, confidence };
  } finally {
    readers.closeAll();
  }
}
