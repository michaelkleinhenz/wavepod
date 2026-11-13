// Auto-direct: a first pass of camera switches from who is speaking. Each camera names the
// speakers it shows (Camera.speakers); while one person talks, their close-up is shown, during
// crosstalk or long pauses the wide shot (the camera showing the most people). The result is
// ordinary director switches, to refine by watching through.
import type { Camera, DirectorCut, Frames, Project, TimelineWord } from '../shared/types';

export interface AutoDirectOptions {
  /** Shortest shot (seconds). */
  minShot: number;
  /** A speaker must talk this long (seconds) before the picture goes to them. */
  minTurn: number;
  /** After this long on one close-up (seconds), the wide shot comes in for a moment; 0 = never. */
  maxCloseUp: number;
  /** How long that wide shot stays (seconds). */
  cutaway: number;
  /** Pause (seconds) after which the wide shot comes. */
  pauseWide: number;
}

export const AUTO_DIRECT_DEFAULTS: AutoDirectOptions = { minShot: 2, minTurn: 0.8, maxCloseUp: 25, cutaway: 4, pauseWide: 3 };

/** Analysis resolution in seconds. */
export const ACTIVITY_STEP = 0.1;

/**
 * Speech activity per track: one value per ACTIVITY_STEP from the timeline start, 0..1 (1 =
 * speaking). Built from transcript words, or from audio levels (see activityFromLevels).
 */
export type Activity = Map<string, Float32Array>;

/** Activity from transcript words (each word counts as speech over its span). */
export function activityFromWords(words: readonly TimelineWord[], trackIds: readonly string[], sampleRate: number, length: Frames): Activity {
  const n = Math.ceil(length / sampleRate / ACTIVITY_STEP) + 1;
  const out: Activity = new Map(trackIds.map((id) => [id, new Float32Array(n)]));
  for (const w of words) {
    const a = out.get(w.trackId);
    if (!a || w.filler || w.muted) continue;
    const i0 = Math.max(0, Math.floor(w.start / sampleRate / ACTIVITY_STEP));
    const i1 = Math.min(n - 1, Math.ceil(w.end / sampleRate / ACTIVITY_STEP));
    for (let i = i0; i <= i1; i++) a[i] = 1;
  }
  return out;
}

/**
 * Activity from levels (dB per step, −∞ for silence): a track counts as speaking where it is
 * within 20 dB of its own loud passages and louder than every other track by 6 dB (its own
 * voice, not the other person's bleed).
 */
export function activityFromLevels(levels: Map<string, Float32Array>): Activity {
  const out: Activity = new Map();
  const ids = [...levels.keys()];
  const n = Math.max(0, ...[...levels.values()].map((l) => l.length));
  const floor = new Map<string, number>();
  for (const [id, l] of levels) {
    const loud = [...l].filter((v) => v > -70).sort((a, b) => a - b);
    const p90 = loud.length ? loud[Math.floor(loud.length * 0.9)] : 0;
    floor.set(id, p90 - 20);
    out.set(id, new Float32Array(n));
  }
  for (let i = 0; i < n; i++) {
    for (const id of ids) {
      const v = levels.get(id)![i] ?? -Infinity;
      if (v < floor.get(id)!) continue;
      const louder = ids.every((o) => o === id || (levels.get(o)![i] ?? -Infinity) < v - 6);
      if (louder) out.get(id)![i] = 1;
    }
  }
  // close the little gaps between words
  for (const a of out.values()) fillGaps(a, Math.round(0.4 / ACTIVITY_STEP));
  return out;
}

function fillGaps(a: Float32Array, max: number): void {
  let last = -1;
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    if (last >= 0 && i - last - 1 <= max) for (let k = last + 1; k < i; k++) a[k] = 1;
    last = i;
  }
}

/** The camera for a speaker: the one showing them with the fewest other people (their close-up). */
export function closeUpOf(cameras: readonly Camera[], trackId: string): Camera | undefined {
  return cameras
    .filter((c) => c.speakers?.includes(trackId))
    .sort((a, b) => (a.speakers?.length ?? 0) - (b.speakers?.length ?? 0))[0];
}

/** The wide shot: the camera showing the most people (the first camera if none are set). */
export function wideOf(cameras: readonly Camera[]): Camera | undefined {
  return [...cameras].sort((a, b) => (b.speakers?.length ?? 0) - (a.speakers?.length ?? 0))[0];
}

/** Switches for [from, to) from speech activity. */
export function autoDirect(project: Project, activity: Activity, from: Frames, to: Frames, opts: AutoDirectOptions = AUTO_DIRECT_DEFAULTS): DirectorCut[] {
  const cams = project.cameras ?? [];
  if (!cams.length) return [];
  const sr = project.sampleRate;
  const wide = wideOf(cams)!;
  const ids = [...activity.keys()];
  const i0 = Math.floor(from / sr / ACTIVITY_STEP);
  const i1 = Math.ceil(to / sr / ACTIVITY_STEP);
  const stepF = (i: number) => Math.round(i * ACTIVITY_STEP * sr);
  // who speaks at each step: one track id, or null (nobody or several at once)
  const who: Array<string | null> = [];
  for (let i = i0; i < i1; i++) {
    const on = ids.filter((id) => (activity.get(id)![i] ?? 0) > 0.5);
    who.push(on.length === 1 ? on[0] : null);
  }
  // turns: a speaker counts once they talk minTurn; pauses longer than pauseWide go wide
  const minTurn = Math.round(opts.minTurn / ACTIVITY_STEP);
  const pauseWide = Math.round(opts.pauseWide / ACTIVITY_STEP);
  const raw: Array<{ i: number; camera: string }> = [];
  let current: string | null = null; // speaker in the picture
  let run: string | null = null;
  let runStart = 0;
  let quiet = 0;
  for (let k = 0; k < who.length; k++) {
    const w = who[k];
    if (w === run) {
      // nothing new
    } else {
      run = w;
      runStart = k;
    }
    quiet = w === null ? quiet + 1 : 0;
    if (w !== null && w !== current && k - runStart + 1 >= minTurn) {
      current = w;
      raw.push({ i: runStart, camera: (closeUpOf(cams, w) ?? wide).id });
    } else if (w === null && quiet === pauseWide && current !== null) {
      current = null;
      raw.push({ i: k - pauseWide + 1, camera: wide.id });
    }
  }
  if (!raw.length || raw[0].i > 0) raw.unshift({ i: 0, camera: wide.id });
  // cutaways to the wide shot in long close-ups
  const withCutaways: Array<{ i: number; camera: string }> = [];
  const maxClose = opts.maxCloseUp > 0 ? Math.round(opts.maxCloseUp / ACTIVITY_STEP) : 0;
  const cutaway = Math.round(opts.cutaway / ACTIVITY_STEP);
  raw.forEach((r, n) => {
    withCutaways.push(r);
    const end = n + 1 < raw.length ? raw[n + 1].i : who.length;
    if (!maxClose || r.camera === wide.id) return;
    for (let s = r.i + maxClose; s + cutaway + maxClose / 2 < end; s += maxClose + cutaway) {
      withCutaways.push({ i: s, camera: wide.id }, { i: s + cutaway, camera: r.camera });
    }
  });
  // no shot shorter than minShot: a short one gives way to the next
  const minShot = Math.round(opts.minShot / ACTIVITY_STEP);
  const out: Array<{ i: number; camera: string }> = [];
  for (const c of withCutaways) {
    const last = out[out.length - 1];
    if (last && c.i - last.i < minShot) {
      if (out.length === 1) last.camera = c.camera;
      else continue;
    } else if (!last || last.camera !== c.camera) out.push({ ...c });
  }
  return out.filter((c, n) => n === 0 || c.camera !== out[n - 1].camera).map((c) => ({ at: Math.max(from, stepF(i0 + c.i)), camera: c.camera }));
}

/**
 * Moves a switch made by hand to the nearest word start within `window` frames, so it falls
 * where a speaker begins rather than mid-word.
 */
export function snapToWords(at: Frames, words: readonly TimelineWord[], window: Frames): Frames {
  let best = at;
  let dist = window + 1;
  for (const w of words) {
    const d = Math.abs(w.start - at);
    if (d < dist) {
      dist = d;
      best = w.start;
    }
  }
  return dist <= window ? best : at;
}
