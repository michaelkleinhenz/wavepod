// Cleanup: finds long pauses and hesitation sounds ("äh", "ähm", "uh") and takes them out
// in one undo step — pauses by shortening them, hesitations by cutting them (or muting them
// on their own track when someone else is talking at the same moment).
import type { CleanupItem, CleanupOptions, Frames, Project, TimelineWord } from '../shared/types';
import { rippleDelete } from './project';
import { addMuteRegion } from './muteRegions';

export const CLEANUP_DEFAULTS: CleanupOptions = { pauses: true, maxPause: 1.5, keepPause: 0.7, fillers: true, retakes: true };
/** Level analysis step for pause finding. */
export const LEVEL_HOP_SECONDS = 0.01;

/** RMS level in dBFS per hop of a mono signal. */
export function levelsDb(samples: Float32Array, hop: number): Float32Array {
  const n = Math.ceil(samples.length / hop);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const a = i * hop;
    const b = Math.min(samples.length, a + hop);
    for (let j = a; j < b; j++) sum += samples[j] * samples[j];
    out[i] = 10 * Math.log10(sum / Math.max(1, b - a) + 1e-12);
  }
  return out;
}

/**
 * The level below which the mix counts as a pause: a bit above the noise floor (the quiet end
 * of the level distribution), but never above −35 dBFS or below −65 dBFS.
 */
export function silenceThreshold(levels: Float32Array): number {
  const vals = Array.from(levels).filter((v) => v > -110).sort((a, b) => a - b);
  if (!vals.length) return -60;
  const floor = vals[Math.floor(vals.length * 0.1)];
  const loud = vals[Math.floor(vals.length * 0.9)];
  const t = Math.min(floor + 12, loud - 20);
  return Math.max(-65, Math.min(-35, t));
}

/**
 * Pauses longer than `maxPause` seconds in a level curve, each with the part to cut so that
 * `keepPause` seconds stay (taken from the middle, so breaths at both ends remain).
 */
export function findPauses(levels: Float32Array, hopFrames: number, sampleRate: number, maxPause: number, keepPause: number, threshold = silenceThreshold(levels)): Array<{ start: Frames; end: Frames; pauseStart: Frames; pauseEnd: Frames }> {
  const out: Array<{ start: Frames; end: Frames; pauseStart: Frames; pauseEnd: Frames }> = [];
  const minLen = Math.max(maxPause, keepPause) * sampleRate;
  const keep = Math.max(0, keepPause) * sampleRate;
  let runStart = -1;
  const close = (endIdx: number) => {
    if (runStart < 0) return;
    const pauseStart = runStart * hopFrames;
    const pauseEnd = endIdx * hopFrames;
    const len = pauseEnd - pauseStart;
    if (len > minLen) {
      const cut = len - keep;
      const start = Math.round(pauseStart + keep / 2);
      out.push({ start, end: start + Math.round(cut), pauseStart, pauseEnd });
    }
    runStart = -1;
  };
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] < threshold) {
      if (runStart < 0) runStart = i;
    } else close(i);
  }
  // a pause running to the end of the episode is the end, not a pause
  return out;
}

/**
 * Moves a hesitation's rough speech-to-text times onto the quietest points around it, so the cut
 * lands between words: the start may move up to `reach` earlier (or 30 ms later), the end up
 * to `reach` later (or 30 ms earlier). `levels` is the track's level per `hop` frames from `origin`.
 */
export function refineCut(levels: Float32Array, hop: number, origin: Frames, start: Frames, end: Frames, sampleRate: number, reach = 0.12): [Frames, Frames] {
  const idx = (f: Frames) => Math.max(0, Math.min(levels.length - 1, Math.round((f - origin) / hop)));
  const quietest = (a: number, b: number, prefer: number) => {
    let best = prefer;
    for (let i = Math.max(0, a); i <= Math.min(levels.length - 1, b); i++) {
      // ties go to the point nearer the word, so the cut stays tight
      if (levels[i] < levels[best] - 0.5 || (Math.abs(levels[i] - levels[best]) <= 0.5 && Math.abs(i - prefer) < Math.abs(best - prefer))) best = i;
    }
    return best;
  };
  const r = Math.round((reach * sampleRate) / hop);
  const inside = Math.round((0.03 * sampleRate) / hop);
  const s = idx(start);
  const e = idx(end);
  const ns = quietest(s - r, Math.min(s + inside, e), s);
  const ne = quietest(Math.max(e - inside, ns + 1), e + r, e);
  const a = origin + ns * hop;
  const b = origin + ne * hop;
  return b > a ? [a, b] : [start, end];
}

/** True if another track has a word during [start, end): then a cut would take that out too. */
export function othersSpeak(words: TimelineWord[], trackId: string, start: Frames, end: Frames): boolean {
  return words.some((w) => w.trackId !== trackId && !w.muted && w.start < end && w.end > start);
}

/** Hesitation words of the transcript as cleanup items (times not yet refined). */
export function fillerItems(words: TimelineWord[]): CleanupItem[] {
  return words
    .filter((w) => w.filler && !w.muted)
    .map((w, i) => ({
      id: `filler-${i}-${w.start}`,
      kind: 'filler' as const,
      start: w.start,
      end: w.end,
      trackId: w.trackId,
      text: w.text,
      action: othersSpeak(words, w.trackId, w.start, w.end) ? ('mute' as const) : ('cut' as const),
    }));
}

/** Pause cuts that don't cut into a word anybody says (speech-to-text may hear a whisper the meter missed). */
export function pauseItems(pauses: Array<{ start: Frames; end: Frames; pauseStart: Frames; pauseEnd: Frames }>, words: TimelineWord[]): CleanupItem[] {
  return pauses
    .filter((p) => !words.some((w) => w.start < p.end && w.end > p.start))
    .map((p) => ({ id: `pause-${p.pauseStart}`, kind: 'pause' as const, start: p.start, end: p.end, pauseLength: p.pauseEnd - p.pauseStart, action: 'cut' as const }));
}

/**
 * Applies the chosen items in one go. Works from the end of the episode backwards, so every
 * cut leaves the positions of the items before it as they were.
 */
export function applyCleanup(project: Project, items: CleanupItem[]): Project {
  const sorted = [...items].filter((i) => i.end > i.start).sort((a, b) => b.start - a.start);
  let p = project;
  let cutFloor = Infinity;
  for (const item of sorted) {
    if (item.action === 'mute') {
      if (item.trackId) p = addMuteRegion(p, item.trackId, item.start, item.end);
      continue;
    }
    // overlapping cuts: only the part before the cut already made
    const end = Math.min(item.end, cutFloor);
    if (end <= item.start) continue;
    p = rippleDelete(p, item.start, end);
    cutFloor = item.start;
  }
  return p;
}

/** How much shorter the episode gets (frames). */
export function cleanupSaving(items: CleanupItem[]): Frames {
  const cuts = items.filter((i) => i.action === 'cut').map((i) => [i.start, i.end] as const).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let reach = -Infinity;
  for (const [a, b] of cuts) {
    const from = Math.max(a, reach);
    if (b > from) total += b - from;
    reach = Math.max(reach, b);
  }
  return total;
}
