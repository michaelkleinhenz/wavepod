// Edits on a set of clips, used by the clip right-click menu. Each returns a new project.
import type { Clip, Frames, Project } from '../shared/types';
import { uid } from '../shared/time';
import { copyClips, pasteClipboard } from './clipboard';

/** The clips a right-click acts on: the whole selection when the clicked clip is part of it, else just that clip. */
export function clipMenuTargets(selected: ReadonlySet<string>, clickedId: string): Set<string> {
  return selected.has(clickedId) ? new Set(selected) : new Set([clickedId]);
}

/** The target clips, in timeline order. */
export function targetClips(project: Project, ids: ReadonlySet<string>): Clip[] {
  return project.tracks.flatMap((t) => t.clips.filter((c) => ids.has(c.id))).sort((a, b) => a.start - b.start);
}

function mapClips(project: Project, ids: ReadonlySet<string>, fn: (c: Clip) => Clip): Project {
  let changed = false;
  const tracks = project.tracks.map((t) => {
    if (!t.clips.some((c) => ids.has(c.id))) return t;
    changed = true;
    return { ...t, clips: t.clips.map((c) => (ids.has(c.id) ? fn({ ...c }) : c)) };
  });
  return changed ? { ...project, tracks } : project;
}

/**
 * Splits the given clips at `position` (other clips there stay whole). Returns the new project and
 * the ids of both halves, so the selection can keep covering what was selected.
 */
export function splitClipsAt(project: Project, ids: ReadonlySet<string>, position: Frames): { project: Project; clipIds: string[] } {
  const pos = Math.round(position);
  const rights: string[] = [];
  let changed = false;
  const tracks = project.tracks.map((t) => {
    if (!t.clips.some((c) => ids.has(c.id) && pos > c.start && pos < c.start + c.length)) return t;
    changed = true;
    const clips: Clip[] = [];
    for (const c of t.clips) {
      if (!ids.has(c.id) || pos <= c.start || pos >= c.start + c.length) {
        clips.push(c);
        continue;
      }
      const leftLen = pos - c.start;
      const right: Clip = { ...c, id: uid('clp'), start: pos, offset: c.offset + leftLen, length: c.length - leftLen, fadeIn: 0 };
      clips.push({ ...c, length: leftLen, fadeOut: 0 }, right);
      rights.push(right.id);
    }
    return { ...t, clips };
  });
  return { project: changed ? { ...project, tracks } : project, clipIds: [...ids, ...rights] };
}

/** True when `position` lies inside one of the clips (so splitting there does something). */
export function canSplitAt(project: Project, ids: ReadonlySet<string>, position: Frames): boolean {
  return targetClips(project, ids).some((c) => position > c.start && position < c.start + c.length);
}

/** Copies the clips and places the copy right after them, on the same tracks. Returns the copies' ids. */
export function duplicateClips(project: Project, ids: ReadonlySet<string>): { project: Project; clipIds: string[] } {
  const data = copyClips(project, new Set(ids));
  if (!data) return { project, clipIds: [] };
  const from = Math.min(...targetClips(project, ids).map((c) => c.start));
  return pasteClipboard(project, data, from + data.length, false);
}

/** Sets the clip gain (dB) of the clips. */
export function setClipGain(project: Project, ids: ReadonlySet<string>, db: number): Project {
  const gain = Math.round(Math.max(-60, Math.min(24, db)) * 10) / 10;
  return mapClips(project, ids, (c) => ({ ...c, gain }));
}

/** Short fades at both ends (`frames` long, at most half the clip). */
export function addClipFades(project: Project, ids: ReadonlySet<string>, frames: Frames): Project {
  return mapClips(project, ids, (c) => ({ ...c, fadeIn: Math.min(frames, Math.floor(c.length / 2)), fadeOut: Math.min(frames, Math.floor(c.length / 2)) }));
}

export function removeClipFades(project: Project, ids: ReadonlySet<string>): Project {
  return mapClips(project, ids, (c) => ({ ...c, fadeIn: 0, fadeOut: 0 }));
}

/** Shows or hides the volume line on the clips. */
export function showClipEnvelopes(project: Project, ids: ReadonlySet<string>, show: boolean): Project {
  return mapClips(project, ids, (c) => ({ ...c, showEnvelope: show }));
}

/** Removes every volume point from the clips (flat at 0 dB again). */
export function resetClipEnvelopes(project: Project, ids: ReadonlySet<string>): Project {
  return mapClips(project, ids, (c) => {
    delete c.envelope;
    return c;
  });
}

/** Colours the clips; undefined takes the colour off. */
export function colorClips(project: Project, ids: ReadonlySet<string>, color: string | undefined): Project {
  return mapClips(project, ids, (c) => {
    if (color) c.color = color;
    else delete c.color;
    return c;
  });
}

/** Every clip on the track the clip is on. */
export function clipsOnSameTrack(project: Project, clipId: string): Set<string> {
  const t = project.tracks.find((x) => x.clips.some((c) => c.id === clipId));
  return new Set(t?.clips.map((c) => c.id) ?? []);
}
