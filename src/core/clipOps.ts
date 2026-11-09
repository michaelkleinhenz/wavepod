// Edits on a set of clips, used by the clip right-click menu. Each returns a new project.
import type { Clip, Frames, Project } from '../shared/types';
import { uid } from '../shared/time';
import { copyClips, pasteClipboard } from './clipboard';
import { loopClipTo, resetClipSound, setClipLoop, setClipRate, setClipReverse } from './clipSound';
import { clipsEnd } from './project';

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

/** Longest clip name kept (characters). */
export const MAX_CLIP_NAME = 120;

/** Names the clips; an empty name goes back to showing the file name. */
export function renameClips(project: Project, ids: ReadonlySet<string>, name: string): Project {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, MAX_CLIP_NAME);
  return mapClips(project, ids, (c) => {
    if (clean) c.name = clean;
    else delete c.name;
    return c;
  });
}

/** Every clip on the track the clip is on. */
export function clipsOnSameTrack(project: Project, clipId: string): Set<string> {
  const t = project.tracks.find((x) => x.clips.some((c) => c.id === clipId));
  return new Set(t?.clips.map((c) => c.id) ?? []);
}

// ------------------------------------------------------------------ sound design

/** Plays the clips backwards (or forwards again). */
export function reverseClips(project: Project, ids: ReadonlySet<string>, on: boolean): Project {
  return mapClips(project, ids, (c) => setClipReverse(c, on));
}

/** Varispeed: plays the clips `rate` times as fast, pitch following. */
export function setClipsRate(project: Project, ids: ReadonlySet<string>, rate: number): Project {
  return mapClips(project, ids, (c) => setClipRate(c, rate));
}

/** Turns looping on (drag the right edge to repeat) or off. */
export function loopClips(project: Project, ids: ReadonlySet<string>, on: boolean): Project {
  return mapClips(project, ids, (c) => setClipLoop(c, on));
}

/** Plays the clips as recorded again (no reverse, speed or loop). */
export function resetClipsSound(project: Project, ids: ReadonlySet<string>): Project {
  return mapClips(project, ids, (c) => resetClipSound(c));
}

/**
 * Loops each clip until the next clip on its track starts, or to the end of the episode (the last
 * clip on any track) when nothing follows it.
 */
export function loopClipsToNext(project: Project, ids: ReadonlySet<string>): Project {
  const end = clipsEnd(project);
  const tracks = project.tracks.map((t) => {
    if (!t.clips.some((c) => ids.has(c.id))) return t;
    return {
      ...t,
      clips: t.clips.map((c) => {
        if (!ids.has(c.id)) return c;
        const next = t.clips.filter((o) => o.id !== c.id && o.start > c.start).reduce((m, o) => Math.min(m, o.start), Infinity);
        return loopClipTo(c, Number.isFinite(next) ? next : Math.max(end, c.start + c.length));
      }),
    };
  });
  return { ...project, tracks };
}

/** Loops each clip over the time range [a, b): it moves to start at `a` and repeats until `b`. */
export function loopClipsOver(project: Project, ids: ReadonlySet<string>, range: [Frames, Frames]): Project {
  const [a, b] = range[0] <= range[1] ? range : [range[1], range[0]];
  if (b - a < 1) return project;
  return mapClips(project, ids, (c) => {
    const looped = setClipLoop(c, true);
    if (!looped.sound?.loop) return c;
    const len = Math.round(b - a);
    const half = Math.floor(len / 2);
    return { ...looped, start: Math.round(a), length: len, fadeIn: Math.min(looped.fadeIn, half), fadeOut: Math.min(looped.fadeOut, half) };
  });
}
