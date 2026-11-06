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
  const sr = project.sampleRate;
  /** The word's level on its own track, the loudest other track's level during it, and which track that is. */
  const own = new Float64Array(n);
  const other = new Float64Array(n);
  const otherLane: string[] = new Array(n).fill('');
  for (let i = 0; i < n; i++) {
    const w = words[i];
    const lane = byId.get(w.trackId);
    own[i] = lane ? laneLevel(lane, w.start, w.end, w.clipId) : -Infinity;
    let o = -Infinity;
    if (own[i] !== -Infinity)
      for (const l of lanes) {
        if (l === lane) continue;
        const v = laneLevel(l, w.start, w.end);
        if (v > o) {
          o = v;
          otherLane[i] = l.id;
        }
      }
    other[i] = o;
  }
  const bare = words.map((w) => bareWord(w.text));
  /** Laughter or other non-speech the speech-to-text wrote down as a word ("haha", "hehe"). */
  const speechWord = (i: number) => !!bare[i] && !LAUGH.test(bare[i]);
  /** 1: this word is the speaker's copy of an echo pair, 2: it is the bleed (see below). */
  const role = new Uint8Array(n);
  /** Whether a track has a spoken word of its own (not bleed) overlapping this span (words are sorted by start). */
  const speaksAt = (i: number, trackId: string): boolean => {
    const { start, end } = words[i];
    const pad = 0.1 * sr;
    const its = (j: number) => words[j].trackId === trackId && role[j] !== 2 && speechWord(j);
    for (let j = i - 1; j >= 0 && words[j].start >= start - 10 * sr; j--) if (its(j) && words[j].end > start - pad) return true;
    for (let j = i + 1; j < n && words[j].start < end + pad; j++) if (its(j)) return true;
    return false;
  };

  // Echoes: the same word on two tracks at the same time. Which track is the speaker is decided
  // per run of such pairs (a sentence), by most of its words: a laugh or a cough of the other
  // person over a few of them then doesn't swap who said it.
  if (filter.matchWords) {
    const win = MATCH_WINDOW_S * sr;
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      if (own[i] === -Infinity || !speechWord(i)) continue;
      const w = words[i];
      const mid = (w.start + w.end) / 2;
      // pair each word with the closest same word on a later-listed word of another track
      let best = -1;
      let bestD = Infinity;
      for (let j = i + 1; j < n && words[j].start <= w.end + win; j++) {
        const u = words[j];
        if (u.trackId === w.trackId || own[j] === -Infinity || !sameWord(bare[i], bare[j])) continue;
        const d = Math.abs((u.start + u.end) / 2 - mid);
        if (d <= win && d < bestD) {
          best = j;
          bestD = d;
        }
      }
      if (best >= 0) pairs.push([i, best]);
    }
    // runs per pair of tracks: pairs no further apart than ECHO_RUN_GAP_S
    const gap = ECHO_RUN_GAP_S * sr;
    const runs = new Map<string, Array<Array<[number, number]>>>();
    for (const [i, j] of pairs) {
      const [a, b] = words[i].trackId < words[j].trackId ? [i, j] : [j, i];
      const key = `${words[a].trackId}\n${words[b].trackId}`;
      const list = runs.get(key) ?? [];
      runs.set(key, list);
      const last = list[list.length - 1];
      if (last && words[a].start - words[last[last.length - 1][0]].end <= gap) last.push([a, b]);
      else list.push([[a, b]]);
    }
    for (const list of runs.values())
      for (const run of list) {
        // the louder side of most pairs is the speaker (median of the differences)
        const diffs = run.map(([a, b]) => own[a] - own[b]).sort((x, y) => x - y);
        const m = diffs.length % 2 ? diffs[(diffs.length - 1) >> 1] : (diffs[diffs.length / 2 - 1] + diffs[diffs.length / 2]) / 2;
        if (m === 0) continue;
        for (const [a, b] of run) {
          const [speaker, bleed] = m > 0 ? [a, b] : [b, a];
          role[speaker] = 1;
          role[bleed] = 2;
        }
      }
    // words heard a bit differently inside a run: between two bleed words of the same track
    const prev = new Int32Array(n).fill(-1);
    const next = new Int32Array(n).fill(-1);
    const last = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      prev[i] = last.get(words[i].trackId) ?? -1;
      if (role[i] === 2) last.set(words[i].trackId, i);
    }
    last.clear();
    for (let i = n - 1; i >= 0; i--) {
      next[i] = last.get(words[i].trackId) ?? -1;
      if (role[i] === 2) last.set(words[i].trackId, i);
    }
    for (let i = 0; i < n; i++) {
      // (a laugh in between is this person's own)
      if (role[i] || own[i] === -Infinity || !speechWord(i) || prev[i] < 0 || next[i] < 0) continue;
      const near = words[i].start - words[prev[i]].end <= gap && words[next[i]].start - words[i].end <= gap;
      // the speaker's track says something here too, so this is the same sentence heard through the mic
      if (near && otherLane[i] && speaksAt(i, otherLane[i])) role[i] = 2;
    }
  }

  const drop = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    // no level curve for this word (older transcript, synthesized words): keep it
    if (own[i] === -Infinity) continue;
    if (role[i] === 2) {
      drop[i] = 1;
      continue;
    }
    const w = words[i];
    // the threshold looks at the file's own level, before any gain
    const clipGain = byId.get(w.trackId)!.clips.find((x) => x.c.id === w.clipId)?.gain ?? 0;
    if (filter.minLevelDb < 0 && own[i] - clipGain < filter.minLevelDb) drop[i] = 1;
    // much louder elsewhere: only crosstalk if that track is speaking then. Laughing, coughing or
    // moving the mic doesn't take this speaker's words away, and nor does a word the echo check
    // already found to be the speaker's own.
    else if (filter.crosstalkDb > 0 && role[i] !== 1 && other[i] - own[i] >= filter.crosstalkDb && speaksAt(i, otherLane[i])) drop[i] = 1;
  }
  const out = words.filter((_, i) => !drop[i]);
  return { words: out, hidden: n - out.length };
}

/** Laughter written as words. */
const LAUGH = /^(h+[aeiou]+){2,}h*$/;

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
