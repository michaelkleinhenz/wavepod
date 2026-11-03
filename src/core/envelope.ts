// Track volume envelopes (Reaper-style volume line): points in timeline frames with a gain in dB.
// Between points the linear gain is interpolated, so a ramp down to the floor is a plain fade.
import type { EnvelopePoint, Frames, Project } from '../shared/types';

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

/** Linear gain of the envelope at `pos` (1 without points). */
export function envelopeAmpAt(points: EnvelopePoint[] | undefined, pos: Frames): number {
  if (!points?.length) return 1;
  const i = segmentIndex(points, pos);
  if (i < 0) return envAmp(points[0].db);
  if (i === points.length - 1) return envAmp(points[i].db);
  const a = points[i];
  const b = points[i + 1];
  const ga = envAmp(a.db);
  const gb = envAmp(b.db);
  if (b.pos <= a.pos) return gb;
  return ga + ((gb - ga) * (pos - a.pos)) / (b.pos - a.pos);
}

/** Envelope value at `pos` in dB. */
export function envelopeDbAt(points: EnvelopePoint[] | undefined, pos: Frames): number {
  return ampToDb(envelopeAmpAt(points, pos));
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
    if (i < 0) out[k] = envAmp(points[0].db);
    else if (i === points.length - 1) out[k] = envAmp(points[i].db);
    else {
      const a = points[i];
      const b = points[i + 1];
      const ga = envAmp(a.db);
      out[k] = b.pos <= a.pos ? envAmp(b.db) : ga + ((envAmp(b.db) - ga) * (pos - a.pos)) / (b.pos - a.pos);
    }
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

/** Envelope after removing [start, end) from the timeline and closing the gap. */
export function rippleEnvelope(points: EnvelopePoint[], start: Frames, end: Frames): EnvelopePoint[] {
  if (!points.length || end <= start) return points;
  const len = end - start;
  const vStart = envelopeDbAt(points, start);
  const vEnd = envelopeDbAt(points, end);
  const head = points.filter((p) => p.pos < start);
  const tail = points.filter((p) => p.pos > end).map((p) => ({ pos: p.pos - len, db: p.db }));
  const join = vStart === vEnd ? [{ pos: start, db: vStart }] : [{ pos: start, db: vStart }, { pos: start, db: vEnd }];
  return [...head, ...join, ...tail];
}

/** Envelope after inserting `length` frames at `position` (the line stays flat across the gap). */
export function insertIntoEnvelope(points: EnvelopePoint[], position: Frames, length: Frames): EnvelopePoint[] {
  if (!points.length || length <= 0) return points;
  const v = envelopeDbAt(points, position);
  const head = points.filter((p) => p.pos < position);
  const tail = points.filter((p) => p.pos > position).map((p) => ({ pos: p.pos + length, db: p.db }));
  return [...head, { pos: position, db: v }, { pos: position + length, db: v }, ...tail];
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Replaces a track's envelope points (sorted on the way in). */
export function setEnvelope(project: Project, trackId: string, points: EnvelopePoint[]): Project {
  const p = clone(project);
  const t = p.tracks.find((x) => x.id === trackId);
  if (t) t.envelope = sortPoints(points);
  return p;
}

/** Mutes [start, end) on the given tracks via their volume lines and shows the lines. */
export function muteSelection(project: Project, trackIds: string[], start: Frames, end: Frames): Project {
  const p = clone(project);
  const ramp = Math.round(ENV_MUTE_RAMP_SECONDS * p.sampleRate);
  for (const t of p.tracks) {
    if (!trackIds.includes(t.id)) continue;
    t.envelope = muteRange(t.envelope ?? [], start, end, ramp);
    t.showEnvelope = true;
  }
  return p;
}
