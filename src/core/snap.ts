// Snapping of dragged edges to nearby positions (clip starts/ends on other tracks, markers, playhead).
import type { Frames, Project } from '../shared/types';

export interface SnapResult {
  /** Frames to add to every candidate so the snapping one lands on the target. */
  delta: Frames;
  /** Position snapped to. */
  target: Frames;
}

/**
 * Finds the target closest to any of the candidate positions, within `threshold` frames.
 * Returns null if nothing is close enough.
 */
export function snap(candidates: Frames[], targets: Frames[], threshold: Frames): SnapResult | null {
  let best: SnapResult | null = null;
  let bestDist = threshold;
  for (const c of candidates) {
    for (const t of targets) {
      const d = Math.abs(t - c);
      if (d <= bestDist && (!best || d < bestDist)) {
        best = { delta: t - c, target: t };
        bestDist = d;
      }
    }
  }
  return best;
}

/** Clip edges (except of the excluded clips), markers and extra positions, deduplicated. */
export function snapTargets(project: Project, excludeClipIds: ReadonlySet<string> = new Set(), extra: Frames[] = []): Frames[] {
  const out = new Set<Frames>(extra);
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (excludeClipIds.has(c.id)) continue;
      out.add(c.start);
      out.add(c.start + c.length);
    }
  }
  for (const m of project.markers) out.add(m.position);
  return [...out];
}
