// Keeping crosstalk out of transcripts. Each track is transcribed on its own, and speech-to-text
// is good enough to also write down the other speakers that bleed quietly into a microphone.
// Every transcript therefore keeps a coarse level curve of its file, and a word is left out
// when another track is much louder at the same moment (it's that speaker, heard through this
// mic) or when it is quieter than a set level.
import type { FileTranscript, Frames, Project, TimelineWord, TranscriptLevels } from '../shared/types';
import { bareWord } from './transcript';

/** One level value per this many seconds. */
export const LEVEL_STEP_S = 0.02;
/** Levels are stored as whole dB below full scale, 0..LEVEL_FLOOR_DB. */
const LEVEL_FLOOR_DB = 120;

/** Default: drop a word when another track is this many dB louder at the same time. */
export const CROSSTALK_DEFAULT_DB = 15;
/** Choices for the crosstalk margin; 0 turns it off. */
export const CROSSTALK_CHOICES = [0, 6, 10, 15, 20, 25];
/** Choices for the quietest level a word may have (dBFS); 0 turns it off. */
export const MIN_LEVEL_CHOICES = [0, -40, -45, -50, -55, -60];

export interface WordFilter {
  /** Leave a word out when another track is this many dB louder during it (0 = off). */
  crosstalkDb: number;
  /** Leave a word out when its own level stays below this (dBFS, 0 = off). */
  minLevelDb: number;
  /** Leave a word out when another track has the same word at the same time, louder (an echo of that speaker). */
  matchWords?: boolean;
}

/** How far apart (seconds) the same word on two tracks may be timed and still count as one. */
const MATCH_WINDOW_S = 0.5;
/** A word between two echoes counts as one too if the gaps to them are at most this long (seconds). */
const ECHO_RUN_GAP_S = 1.5;

/**
 * The level curve of a mono signal (e.g. the 16 kHz speech audio sent for transcription):
 * RMS per LEVEL_STEP_S, as one byte per step (dB below full scale), base64 encoded.
 * `step` counts in frames of the original file (`fileRate`), like the word times do.
 */
export function levelCurve(pcm: Int16Array | Float32Array, pcmRate: number, fileRate: number): TranscriptLevels {
  const meter = new LevelMeter(pcmRate, fileRate);
  meter.push(pcm, pcm.length, pcm instanceof Int16Array ? 1 / 32768 : 1);
  return meter.finish();
}

/** Builds a level curve block by block, so a long file never has to be in memory at once. */
export class LevelMeter {
  private readonly win: number;
  private bytes: number[] = [];
  private sum = 0;
  private count = 0;

  /** `rate`: rate of the samples pushed; `fileRate`: rate the curve's `step` counts in. */
  constructor(
    private readonly rate: number,
    private readonly fileRate = rate,
  ) {
    this.win = Math.max(1, Math.round(LEVEL_STEP_S * rate));
  }

  push(x: ArrayLike<number>, n = x.length, scale = 1): void {
    for (let i = 0; i < n; i++) {
      const v = x[i] * scale;
      this.sum += v * v;
      if (++this.count === this.win) this.flush();
    }
  }

  private flush(): void {
    const rms = Math.sqrt(this.sum / Math.max(1, this.count));
    const db = rms > 0 ? -20 * Math.log10(rms) : LEVEL_FLOOR_DB;
    this.bytes.push(Math.max(0, Math.min(LEVEL_FLOOR_DB, Math.round(db))));
    this.sum = 0;
    this.count = 0;
  }

  finish(): TranscriptLevels {
    if (this.count) this.flush();
    return { step: (this.win * this.fileRate) / this.rate, db: toBase64(Uint8Array.from(this.bytes)) };
  }
}

const decoded = new WeakMap<TranscriptLevels, Uint8Array>();

function curve(l: TranscriptLevels): Uint8Array {
  let c = decoded.get(l);
  if (!c) {
    c = fromBase64(l.db);
    decoded.set(l, c);
  }
  return c;
}

/** The loudest level (dBFS) of a file between two of its frames, or -Infinity if it has none there. */
export function peakLevel(l: TranscriptLevels, from: number, to: number): number {
  const c = curve(l);
  if (!c.length || !(l.step > 0)) return -Infinity;
  const a = Math.max(0, Math.floor(from / l.step));
  const b = Math.min(c.length, Math.max(a + 1, Math.ceil(to / l.step)));
  let best = LEVEL_FLOOR_DB + 1;
  for (let i = a; i < b; i++) if (c[i] < best) best = c[i];
  return best > LEVEL_FLOOR_DB ? -Infinity : -best;
}

/**
 * Leaves out the words that are crosstalk or too quiet:
 * - level: during the word another speech track (with its clip and track gain) peaks
 *   `crosstalkDb` or more above this track;
 * - echo (`matchWords`): another track has the same word at about the same time and is louder
 *   there. Bleed is transcribed as a quieter copy of what the speaker said, so this catches it
 *   even when the mics are close and the bleed is only a few dB down. A word the speech-to-text
 *   heard a bit differently is caught when it sits between two such echoes and the other
 *   track is louder during it.
 * Words of files without a level curve are always kept.
 */
export function filterQuietWords(
  project: Project,
  transcripts: ReadonlyMap<string, FileTranscript> | Record<string, FileTranscript>,
  words: TimelineWord[],
  filter: WordFilter | null | undefined,
): { words: TimelineWord[]; hidden: number } {
  if (!filter || (!(filter.crosstalkDb > 0) && !(filter.minLevelDb < 0) && !filter.matchWords)) return { words, hidden: 0 };
  const get = (file: string) => (transcripts instanceof Map ? transcripts.get(file) : (transcripts as Record<string, FileTranscript>)[file]);
  const speech = project.tracks.filter((t) => t.kind !== 'soundboard');
  // per track: its clips in time order, with what's needed to read their level
  const lanes = speech.map((t) => ({
    id: t.id,
    clips: t.clips
      .map((c) => {
        const tr = get(c.file);
        return tr?.levels && !c.sound ? { c, levels: tr.levels, scale: project.sampleRate / (tr.sampleRate || project.sampleRate), gain: (c.gain ?? 0) + (t.gain ?? 0) } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => a.c.start - b.c.start),
  }));
  const byId = new Map(lanes.map((l) => [l.id, l]));
  /** Loudest level of one track over a timeline span. */
  const laneLevel = (lane: (typeof lanes)[number], start: Frames, end: Frames, onlyClip?: string): number => {
    let best = -Infinity;
    for (const x of lane.clips) {
      if (x.c.start >= end) break;
      if (x.c.start + x.c.length <= start || (onlyClip && x.c.id !== onlyClip)) continue;
      const a = Math.max(start, x.c.start) - x.c.start + x.c.offset;
      const b = Math.min(end, x.c.start + x.c.length) - x.c.start + x.c.offset;
      const v = peakLevel(x.levels, a / x.scale, b / x.scale) + x.gain;
      if (v > best) best = v;
    }
    return best;
  };
  const n = words.length;
  /** The word's level on its own track, and the loudest other track's level during it. */
  const own = new Float64Array(n);
  const other = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = words[i];
    const lane = byId.get(w.trackId);
    own[i] = lane ? laneLevel(lane, w.start, w.end, w.clipId) : -Infinity;
    let o = -Infinity;
    if (own[i] !== -Infinity) for (const l of lanes) if (l !== lane) o = Math.max(o, laneLevel(l, w.start, w.end));
    other[i] = o;
  }
  const drop = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    // no level curve for this word (older transcript, synthesized words): keep it
    if (own[i] === -Infinity) continue;
    const w = words[i];
    // the threshold looks at the file's own level, before any gain
    const clipGain = byId.get(w.trackId)!.clips.find((x) => x.c.id === w.clipId)?.gain ?? 0;
    if (filter.minLevelDb < 0 && own[i] - clipGain < filter.minLevelDb) drop[i] = 1;
    else if (filter.crosstalkDb > 0 && other[i] - own[i] >= filter.crosstalkDb) drop[i] = 1;
  }
  if (filter.matchWords) {
    const sr = project.sampleRate;
    const win = MATCH_WINDOW_S * sr;
    const bare = words.map((w) => bareWord(w.text));
    const echo = new Uint8Array(n);
    // words are sorted by start, so the candidates of a word are close to it in the list
    for (let i = 0; i < n; i++) {
      if (own[i] === -Infinity || !bare[i]) continue;
      const w = words[i];
      const mid = (w.start + w.end) / 2;
      for (let j = i - 1; j >= 0 && words[j].start >= w.start - win - sr * 2; j--) if (isEcho(i, j)) echo[i] = 1;
      for (let j = i + 1; !echo[i] && j < n && words[j].start <= w.end + win; j++) if (isEcho(i, j)) echo[i] = 1;
      function isEcho(a: number, b: number): boolean {
        const u = words[b];
        if (u.trackId === w.trackId || own[b] <= own[a] || Math.abs((u.start + u.end) / 2 - mid) > win) return false;
        return sameWord(bare[a], bare[b]);
      }
    }
    // words heard a bit differently in a run of echoes: between two echoes, other track louder
    const lastEcho = new Map<string, number>();
    const prevEcho = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      prevEcho[i] = lastEcho.get(words[i].trackId) ?? -1;
      if (echo[i]) lastEcho.set(words[i].trackId, i);
    }
    const nextEcho = new Int32Array(n).fill(-1);
    lastEcho.clear();
    for (let i = n - 1; i >= 0; i--) {
      nextEcho[i] = lastEcho.get(words[i].trackId) ?? -1;
      if (echo[i]) lastEcho.set(words[i].trackId, i);
    }
    const gap = ECHO_RUN_GAP_S * sr;
    for (let i = 0; i < n; i++) {
      if (echo[i]) drop[i] = 1;
      else if (own[i] !== -Infinity && other[i] > own[i] && prevEcho[i] >= 0 && nextEcho[i] >= 0) {
        if (words[i].start - words[prevEcho[i]].end <= gap && words[nextEcho[i]].start - words[i].end <= gap) drop[i] = 1;
      }
    }
  }
  const out = words.filter((_, i) => !drop[i]);
  return { words: out, hidden: n - out.length };
}

/** The same word, allowing one letter off in longer words ("okay"/"okey", "genau"/"genauu"). */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
  // at most one edit
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  let s = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    s += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    s += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return s;
}

const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

function fromBase64(s: string): Uint8Array {
  const at = (c: string | undefined) => (c === undefined ? 0 : (B64_INDEX.get(c) ?? 0));
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (at(clean[i]) << 18) | (at(clean[i + 1]) << 12) | (at(clean[i + 2]) << 6) | at(clean[i + 3]);
    if (o < out.length) out[o++] = n >> 16;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}
