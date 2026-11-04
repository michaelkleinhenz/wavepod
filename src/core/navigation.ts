// Navigation targets for checking cuts: clip edges and markers, before or after a position.
import type { MarkerKind, Project } from '../shared/types';

/** Start and end of every clip on every track, sorted, without duplicates. */
export function clipEdges(project: Project): number[] {
  const set = new Set<number>();
  for (const t of project.tracks) {
    for (const c of t.clips) {
      set.add(c.start);
      set.add(c.start + c.length);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/** Marker positions (optionally of one kind), sorted. */
export function markerPositions(project: Project, kind?: MarkerKind): number[] {
  return [...new Set(project.markers.filter((m) => !kind || m.kind === kind).map((m) => m.position))].sort((a, b) => a - b);
}

/**
 * The next position after `pos` (dir 1) or the previous one before it (dir -1).
 * `slack` frames around `pos` count as "here", so pressing again moves on.
 */
export function stepTo(positions: number[], pos: number, dir: 1 | -1, slack = 0): number | null {
  if (dir > 0) return positions.find((p) => p > pos + slack) ?? null;
  for (let i = positions.length - 1; i >= 0; i--) if (positions[i] < pos - slack) return positions[i];
  return null;
}

/** Frames to view for "zoom to selection": the time range, or the span of the selected clips. */
export function selectionSpan(project: Project, range: [number, number] | null, clipIds: Set<string>): [number, number] | null {
  if (range && range[1] > range[0]) return range;
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (!clipIds.has(c.id)) continue;
      lo = Math.min(lo, c.start);
      hi = Math.max(hi, c.start + c.length);
    }
  }
  return hi > lo ? [lo, hi] : null;
}

/**
 * Clips touched by a marquee: every clip on tracks `fromTrack`..`toTrack` (either order)
 * that overlaps the frames `a`..`b` (either order).
 */
export function clipsInRect(project: Project, fromTrack: number, toTrack: number, a: number, b: number): Set<string> {
  const t0 = Math.max(0, Math.min(fromTrack, toTrack));
  const t1 = Math.min(project.tracks.length - 1, Math.max(fromTrack, toTrack));
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const ids = new Set<string>();
  for (let ti = t0; ti <= t1; ti++) {
    for (const c of project.tracks[ti].clips) if (c.start <= hi && c.start + c.length >= lo) ids.add(c.id);
  }
  return ids;
}

/** Every clip in the project, e.g. for Ctrl+A. */
export function allClipIds(project: Project): Set<string> {
  return new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
}
