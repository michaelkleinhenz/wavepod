// Track automation: volume and pan lines over the timeline, with breakpoints in timeline frames.
// Volume is in dB (interpolated in dB, applied after the track's filters together with its
// gain); pan is -1 (left) .. 1 (right), interpolated linearly, and replaces the track's pan
// while the lane has points. Ripple edits move the points along with the audio.
import type { AutomationLane, AutomationPoint, Frames, Project, Track } from '../shared/types';
import { ENV_MAX_DB, ENV_MIN_DB, envAmp } from './envelope';

export const AUTOMATION_LANES: AutomationLane[] = ['volume', 'pan'];

export function clampLaneValue(lane: AutomationLane, v: number): number {
  return lane === 'pan' ? Math.max(-1, Math.min(1, v)) : Math.max(ENV_MIN_DB, Math.min(ENV_MAX_DB, v));
}

/** Index of the last point at or before `pos` (-1 if none). With equal positions, the later point wins. */
function segmentIndex(points: AutomationPoint[], pos: Frames): number {
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

function interp(points: AutomationPoint[], i: number, pos: Frames): number {
  if (i < 0) return points[0].value;
  if (i === points.length - 1) return points[i].value;
  const a = points[i];
  const b = points[i + 1];
  if (b.pos <= a.pos) return b.value;
  return a.value + ((b.value - a.value) * (pos - a.pos)) / (b.pos - a.pos);
}

/** The lane's value at `pos` (`fallback` without points); the first/last value holds outside the points. */
export function automationValueAt(points: AutomationPoint[] | undefined, pos: Frames, fallback = 0): number {
  if (!points?.length) return fallback;
  return interp(points, segmentIndex(points, pos), pos);
}

/** Writes the lane's values for frames [from, from + n) into out[0..n). */
export function fillAutomation(points: AutomationPoint[], from: Frames, n: number, out: Float32Array, map?: (v: number) => number): void {
  let i = segmentIndex(points, from);
  for (let k = 0; k < n; k++) {
    const pos = from + k;
    while (i + 1 < points.length && points[i + 1].pos <= pos) i++;
    const v = interp(points, i, pos);
    out[k] = map ? map(v) : v;
  }
}

/** Linear gain of a volume value in dB. */
export const volumeAmp = envAmp;

export function hasAutomation(track: Track, lane: AutomationLane): boolean {
  return !!track.automation?.[lane]?.length;
}

/** Sorted, clamped copy (stable, so points sharing a position keep their order). */
export function sortAutomation(lane: AutomationLane, points: AutomationPoint[]): AutomationPoint[] {
  return points
    .filter((p) => Number.isFinite(p?.pos) && Number.isFinite(p?.value))
    .map((p, i) => ({ p: { pos: Math.max(0, Math.round(p.pos)), value: clampLaneValue(lane, p.value) }, i }))
    .sort((x, y) => x.p.pos - y.p.pos || x.i - y.i)
    .map((x) => x.p);
}

/** Adds a point; returns the new list and the new point's index. */
export function addAutomationPoint(lane: AutomationLane, points: AutomationPoint[], pos: Frames, value: number): { points: AutomationPoint[]; index: number } {
  const p = { pos: Math.max(0, Math.round(pos)), value: clampLaneValue(lane, value) };
  let index = points.findIndex((q) => q.pos > p.pos);
  if (index < 0) index = points.length;
  return { points: [...points.slice(0, index), p, ...points.slice(index)], index };
}

/** Drops points that change nothing: inside a flat stretch, or repeating the first/last value at the ends. */
export function simplifyAutomation(points: AutomationPoint[]): AutomationPoint[] {
  const out = points.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const prev = out[i - 1];
    const next = out[i + 1];
    const v = out[i].value;
    const flatBefore = !prev || prev.value === v;
    const flatAfter = !next || next.value === v;
    if (flatBefore && flatAfter && (prev || next)) out.splice(i, 1);
  }
  return out;
}

/**
 * Moves every point at or after `from` by `delta` frames, the way ripple edits move the audio.
 * Moving right holds the value at `from` across the gap; moving left replaces the points the
 * moved material lands on, with a step where the two parts meet.
 */
export function shiftAutomation(points: AutomationPoint[], from: Frames, delta: Frames): AutomationPoint[] {
  if (!points.length || !delta) return points.slice();
  const d = Math.round(delta);
  const target = Math.max(0, from + d);
  const atFrom = automationValueAt(points, from);
  const right = points.filter((p) => p.pos >= from).map((p) => ({ pos: Math.max(0, p.pos + d), value: p.value }));
  let out: AutomationPoint[];
  if (d > 0) {
    const left = points.filter((p) => p.pos < from);
    out = [...left, { pos: from, value: atFrom }, { pos: target, value: atFrom }, ...right];
  } else {
    const left = points.filter((p) => p.pos < target);
    out = [...left, { pos: target, value: automationValueAt(points, target) }, { pos: target, value: atFrom }, ...right];
  }
  return simplifyAutomation(out);
}

/** Applies `fn` to both lanes of a track (in place). */
export function mapTrackAutomation(track: Track, fn: (points: AutomationPoint[]) => AutomationPoint[]): void {
  const a = track.automation;
  if (!a) return;
  for (const lane of AUTOMATION_LANES) {
    const pts = a[lane];
    if (pts?.length) a[lane] = fn(pts);
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Replaces one lane of a track (sorted on the way in; an empty list clears it). */
export function setTrackAutomation(project: Project, trackId: string, lane: AutomationLane, points: AutomationPoint[]): Project {
  const p = clone(project);
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return p;
  const sorted = sortAutomation(lane, points);
  const a = { ...(t.automation ?? {}) };
  if (sorted.length) a[lane] = sorted;
  else delete a[lane];
  t.automation = a;
  return p;
}

/** Shows one lane on a track's row (null: back to the clips). */
export function showTrackAutomation(project: Project, trackId: string, lane: AutomationLane | null): Project {
  const p = clone(project);
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return p;
  const a = { ...(t.automation ?? {}) };
  if (lane) a.shown = lane;
  else delete a.shown;
  t.automation = a;
  return p;
}

/** Cleans automation read from a project file. */
export function normalizeAutomation(raw: unknown): Track['automation'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: NonNullable<Track['automation']> = {};
  for (const lane of AUTOMATION_LANES) {
    if (!Array.isArray(r[lane])) continue;
    const pts = sortAutomation(lane, r[lane] as AutomationPoint[]);
    if (pts.length) out[lane] = pts;
  }
  if (r.shown === 'volume' || r.shown === 'pan') out.shown = r.shown;
  return Object.keys(out).length ? out : undefined;
}

/** Pan as shown to people: "C", "L 40", "R 25". */
export function formatPan(v: number): string {
  const n = Math.round(Math.abs(v) * 100);
  if (n === 0) return 'C';
  return `${v < 0 ? 'L' : 'R'} ${n}`;
}

/** Reads a typed pan: "C", "L 40", "R25", "-40" or "40" (percent). Null when it isn't one. */
export function parsePan(text: string): number | null {
  const t = text.trim().toUpperCase().replace(/%$/, '').trim();
  if (t === 'C' || t === 'CENTER' || t === 'CENTRE' || t === 'M') return 0;
  const m = /^([LR])\s*(\d+(?:[.,]\d+)?)$|^([+-]?\d+(?:[.,]\d+)?)\s*([LR])?$/.exec(t);
  if (!m) return null;
  let n: number;
  if (m[1]) n = Number(m[2].replace(',', '.')) * (m[1] === 'L' ? -1 : 1);
  else {
    n = Number(m[3].replace(',', '.'));
    if (m[4] === 'L') n = -Math.abs(n);
    if (m[4] === 'R') n = Math.abs(n);
  }
  if (!Number.isFinite(n)) return null;
  return Math.max(-1, Math.min(1, Math.round(n) / 100));
}
