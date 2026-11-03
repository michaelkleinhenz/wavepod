// Clip volume envelopes (Reaper-style volume line): points with a gain in dB, positioned in
// source-file frames of the clip. Between points the gain is interpolated in dB.
import type { Clip, EnvelopePoint, Frames, Project } from '../shared/types';

/** At or below this value the envelope is silent. */
export const ENV_MIN_DB = -60;
/** Highest gain the volume line can be raised to. */
export const ENV_MAX_DB = 6;
/** Length of the ramps around a muted selection (Ctrl+Y), in seconds. */
export const ENV_MUTE_RAMP_SECONDS = 0.01;

export function clampDb(db: number): number {
  return Math.max(ENV_MIN_DB, Math.min(ENV_MAX_DB, db));
}

export function envAmp(db: number): number {
  return db <= ENV_MIN_DB ? 0 : Math.pow(10, db / 20);
}

export function ampToDb(amp: number): number {
  if (amp <= envAmp(ENV_MIN_DB + 1e-9)) return ENV_MIN_DB;
  return clampDb(20 * Math.log10(amp));
}

/** Index of the last point at or before `pos` (-1 if none). With equal positions, the later point wins. */
function segmentIndex(points: EnvelopePoint[], pos: Frames): number {
  let lo = 0;
  let hi = points.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].pos <= pos) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Envelope value at `pos` in dB (0 without points), interpolated in dB between points. */
export function envelopeDbAt(points: EnvelopePoint[] | undefined, pos: Frames): number {
  if (!points?.length) return 0;
  const i = segmentIndex(points, pos);
  if (i < 0) return points[0].db;
  if (i === points.length - 1) return points[i].db;
  const a = points[i];
  const b = points[i + 1];
  if (b.pos <= a.pos) return b.db;
  return a.db + ((b.db - a.db) * (pos - a.pos)) / (b.pos - a.pos);
}

/** Linear gain of the envelope at `pos` (1 without points). */
export function envelopeAmpAt(points: EnvelopePoint[] | undefined, pos: Frames): number {
  return envAmp(envelopeDbAt(points, pos));
}

/** True if the envelope never changes the signal. */
export function isUnityEnvelope(points: EnvelopePoint[] | undefined): boolean {
  return !points?.length || points.every((p) => p.db === 0);
}

/** Writes the envelope gain for frames [from, from + n) into out[0..n). */
export function fillEnvelope(points: EnvelopePoint[], from: Frames, n: number, out: Float32Array): void {
  let i = segmentIndex(points, from);
  for (let k = 0; k < n; k++) {
    const pos = from + k;
    while (i + 1 < points.length && points[i + 1].pos <= pos) i++;
    let db: number;
    if (i < 0) db = points[0].db;
    else if (i === points.length - 1) db = points[i].db;
    else {
      const a = points[i];
      const b = points[i + 1];
      db = b.pos <= a.pos ? b.db : a.db + ((b.db - a.db) * (pos - a.pos)) / (b.pos - a.pos);
    }
    out[k] = envAmp(db);
  }
}

/** Sorted copy (stable, so points sharing a position keep their order). */
export function sortPoints(points: EnvelopePoint[]): EnvelopePoint[] {
  return points
    .map((p) => ({ pos: Math.max(0, Math.round(p.pos)), db: clampDb(p.db) }))
    .map((p, i) => ({ p, i }))
    .sort((x, y) => x.p.pos - y.p.pos || x.i - y.i)
    .map((x) => x.p);
}

/** Adds a point; returns the new list and the new point's index. */
export function addPoint(points: EnvelopePoint[], pos: Frames, db: number): { points: EnvelopePoint[]; index: number } {
  const p = { pos: Math.max(0, Math.round(pos)), db: clampDb(db) };
  let index = points.findIndex((q) => q.pos > p.pos);
  if (index < 0) index = points.length;
  return { points: [...points.slice(0, index), p, ...points.slice(index)], index };
}

/**
 * Silences [start, end) with short ramps outside the range (Ctrl+Y). Points inside the
 * range and its ramps are replaced; the line before and after is kept as it was.
 */
export function muteRange(points: EnvelopePoint[], start: Frames, end: Frames, ramp: Frames): EnvelopePoint[] {
  if (end <= start) return points;
  const a = Math.max(0, start - ramp);
  const b = end + ramp;
  const before = envelopeDbAt(points, a);
  const after = envelopeDbAt(points, b);
  const out = points.filter((p) => p.pos < a || p.pos > b);
  const head = out.filter((p) => p.pos < a);
  const tail = out.filter((p) => p.pos > b);
  return [
    ...head,
    ...(a < start ? [{ pos: a, db: before }] : []),
    { pos: start, db: ENV_MIN_DB },
    { pos: end, db: ENV_MIN_DB },
    { pos: b, db: after },
    ...tail,
  ];
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Source-file frame of a timeline frame inside `clip`. */
export function toSource(clip: Clip, timeline: Frames): Frames {
  return clip.offset + (timeline - clip.start);
}

/** Replaces a clip's envelope points (sorted on the way in). */
export function setClipEnvelope(project: Project, clipId: string, points: EnvelopePoint[]): Project {
  const p = clone(project);
  for (const t of p.tracks) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) c.envelope = sortPoints(points);
  }
  return p;
}

/**
 * Mutes [start, end) on the given tracks (Ctrl+Y) by bending the volume line of every clip
 * the range or its ramps touch, and shows those lines.
 */
export function muteSelection(project: Project, trackIds: string[], start: Frames, end: Frames): Project {
  const p = clone(project);
  const ramp = Math.round(ENV_MUTE_RAMP_SECONDS * p.sampleRate);
  for (const t of p.tracks) {
    if (!trackIds.includes(t.id)) continue;
    for (const c of t.clips) {
      if (c.start + c.length <= start - ramp || c.start >= end + ramp) continue;
      // a range reaching past the clip is silent from the clip's edge, without a ramp outside it
      const from = Math.max(c.offset, toSource(c, start));
      const to = Math.min(c.offset + c.length, toSource(c, end));
      if (to <= from) continue;
      c.envelope = sortPoints(muteRange(c.envelope ?? [], from, to, ramp));
      c.showEnvelope = true;
    }
  }
  return p;
}

/**
 * Projects saved with the short-lived per-track volume lines: copies a track's line onto
 * each of its clips (converted to source frames).
 */
export function migrateTrackEnvelope(points: EnvelopePoint[] | undefined, clips: Clip[], show: boolean): void {
  if (!points?.length) return;
  for (const c of clips) {
    if (c.envelope?.length) continue;
    const inside = points.filter((q) => q.pos > c.start && q.pos < c.start + c.length);
    const edges = [c.start, c.start + c.length].map((pos) => ({ pos, db: envelopeDbAt(points, pos) }));
    const all = [edges[0], ...inside, edges[1]];
    if (all.every((q) => q.db === 0)) continue;
    c.envelope = all.map((q) => ({ pos: toSource(c, q.pos), db: q.db }));
    c.showEnvelope = show;
  }
}
