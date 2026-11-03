// Ripple moves: drag a clip and everything after it moves along (Ctrl-drag: on its track,
// Ctrl+Shift-drag: on all tracks, with markers and mute regions).
import type { Frames, Project } from '../shared/types';

export type RippleScope = 'track' | 'all';

export interface RippleSet {
  /** Where the move starts: the earliest start of the grabbed clips. */
  pivot: Frames;
  clipIds: Set<string>;
  markerIds: Set<string>;
  /** Everything later moves, on all tracks (markers and regions too). */
  all: boolean;
  /** Per affected track: mute regions starting at or after this frame move along. */
  trackFrom: Map<string, Frames>;
}

/** Everything that moves when `clipIds` are ripple-dragged. */
export function rippleSet(project: Project, clipIds: Iterable<string>, scope: RippleScope): RippleSet {
  const ids = new Set(clipIds);
  const grabbed = project.tracks.flatMap((t) => t.clips.filter((c) => ids.has(c.id)).map((c) => ({ t, c })));
  const pivot = grabbed.length ? Math.min(...grabbed.map((g) => g.c.start)) : 0;
  const trackIds = new Set(scope === 'all' ? project.tracks.map((t) => t.id) : grabbed.map((g) => g.t.id));
  const clips = new Set(ids);
  const trackFrom = new Map<string, Frames>();
  for (const t of project.tracks) {
    if (!trackIds.has(t.id)) continue;
    // on a single track, the pivot is that track's earliest grabbed clip
    const from = scope === 'all' ? pivot : Math.min(...grabbed.filter((g) => g.t.id === t.id).map((g) => g.c.start));
    trackFrom.set(t.id, from);
    for (const c of t.clips) if (c.start >= from) clips.add(c.id);
  }
  const markerIds = new Set(scope === 'all' ? project.markers.filter((m) => m.position >= pivot).map((m) => m.id) : []);
  return { pivot, all: scope === 'all', clipIds: clips, markerIds, trackFrom };
}

/** The most a ripple set may move left: nothing goes before zero. */
export function rippleMinDelta(project: Project, set: RippleSet): Frames {
  let min = Infinity;
  for (const t of project.tracks) for (const c of t.clips) if (set.clipIds.has(c.id)) min = Math.min(min, c.start);
  for (const m of project.markers) if (set.markerIds.has(m.id)) min = Math.min(min, m.position);
  if (set.all) for (const r of project.regions ?? []) if (r.start >= set.pivot) min = Math.min(min, r.start);
  return Number.isFinite(min) ? -min : 0;
}

/** Moves a ripple set by `delta` frames (clamped so nothing goes before zero). */
export function rippleMove(project: Project, set: RippleSet, delta: Frames): Project {
  const d = Math.max(rippleMinDelta(project, set), Math.round(delta));
  const p = structuredClone(project);
  if (!d) return p;
  for (const t of p.tracks) {
    for (const c of t.clips) if (set.clipIds.has(c.id)) c.start += d;
    t.clips.sort((a, b) => a.start - b.start);
    const from = set.trackFrom.get(t.id);
    if (from !== undefined && t.muteRegions?.length) {
      t.muteRegions = t.muteRegions.map(([a, b]) => (a >= from ? [Math.max(0, a + d), Math.max(0, b + d)] : [a, b]));
    }
  }
  for (const m of p.markers) if (set.markerIds.has(m.id)) m.position += d;
  if (set.all) {
    // all tracks: regions from the pivot on move along
    for (const r of p.regions ?? []) {
      if (r.start < set.pivot) continue;
      r.start += d;
      r.end += d;
    }
  }
  p.markers.sort((a, b) => a.position - b.position);
  return p;
}
