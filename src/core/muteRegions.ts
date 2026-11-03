// Mute regions ("cough buttons"): time ranges in which a track is silenced without cutting its audio.
// Regions are stored per track in timeline frames, sorted and non-overlapping.
import type { Frames, MuteRegion, Project, Track } from '../shared/types';

/** Length of the gain ramp at each region edge, in seconds (avoids clicks). */
export const MUTE_RAMP_SECONDS = 0.01;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Sorts regions and merges overlapping or touching ones; drops empty ones. */
export function mergeRegions(regions: MuteRegion[]): MuteRegion[] {
  const sorted = regions
    .map(([a, b]): MuteRegion => [Math.max(0, Math.round(Math.min(a, b))), Math.max(0, Math.round(Math.max(a, b)))])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: MuteRegion[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

function withRegions(project: Project, trackId: string, fn: (regions: MuteRegion[]) => MuteRegion[]): Project {
  const p = clone(project);
  const t = p.tracks.find((x) => x.id === trackId);
  if (t) t.muteRegions = mergeRegions(fn(t.muteRegions ?? []));
  return p;
}

export function addMuteRegion(project: Project, trackId: string, start: Frames, end: Frames): Project {
  return withRegions(project, trackId, (r) => [...r, [start, end]]);
}

export function removeMuteRegion(project: Project, trackId: string, index: number): Project {
  return withRegions(project, trackId, (r) => r.filter((_, i) => i !== index));
}

export function updateMuteRegion(project: Project, trackId: string, index: number, start: Frames, end: Frames): Project {
  return withRegions(project, trackId, (r) => r.map((x, i): MuteRegion => (i === index ? [start, end] : x)));
}

/** Regions after removing [start, end) from the timeline and closing the gap. */
export function rippleRegions(regions: MuteRegion[], start: Frames, end: Frames): MuteRegion[] {
  const len = end - start;
  const shift = (v: Frames) => (v <= start ? v : v >= end ? v - len : start);
  return mergeRegions(regions.map(([a, b]): MuteRegion => [shift(a), shift(b)]));
}

/** Regions after inserting `length` frames of silence at `position`. */
export function insertIntoRegions(regions: MuteRegion[], position: Frames, length: Frames): MuteRegion[] {
  const out: MuteRegion[] = [];
  for (const [a, b] of regions) {
    if (b <= position) out.push([a, b]);
    else if (a >= position) out.push([a + length, b + length]);
    else out.push([a, position], [position + length, b + length]);
  }
  return out;
}

/**
 * Gain of a track at timeline frame `pos`: 1 outside regions, 0 inside, with a short
 * ramp just inside each region edge so muting never clicks.
 */
export function muteGainAt(regions: MuteRegion[] | undefined, pos: Frames, ramp: Frames): number {
  if (!regions?.length) return 1;
  for (const [a, b] of regions) {
    if (pos < a) return 1;
    if (pos >= b) continue;
    const r = Math.min(ramp, Math.floor((b - a) / 2));
    if (r <= 0) return 0;
    if (pos < a + r) return 1 - (pos - a) / r;
    if (pos >= b - r) return (pos - (b - r)) / r;
    return 0;
  }
  return 1;
}

/** True if any region of the track touches [from, to). */
export function regionsOverlap(track: Track, from: Frames, to: Frames): boolean {
  return !!track.muteRegions?.some(([a, b]) => a < to && b > from);
}
