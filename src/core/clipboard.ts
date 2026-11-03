// Clipboard for the timeline: clips or a time range (across tracks), pasted at the playhead,
// either on top of what is there or as a ripple insert that moves everything after it.
import type { Clip, Frames, MuteRegion, Project } from '../shared/types';
import { uid } from '../shared/time';
import { insertSilence } from './project';
import { addMuteRegion } from './muteRegions';

export interface ClipboardItem {
  trackId: string;
  /** Index of the track when copied, used when the track no longer exists. */
  trackIndex: number;
  /** Clip with `start` relative to the start of the copied span. */
  clip: Clip;
}

export interface ClipboardData {
  length: Frames;
  items: ClipboardItem[];
  /** Mute regions inside a copied range, relative to its start. */
  muteRegions: Array<{ trackId: string; trackIndex: number; region: MuteRegion }>;
}

/** The part of a clip that lies in [start, end), or null. Fades only stay where the clip really starts or ends. */
function sliceClip(c: Clip, start: Frames, end: Frames): Clip | null {
  const a = Math.max(c.start, start);
  const b = Math.min(c.start + c.length, end);
  if (b <= a) return null;
  return {
    ...c,
    start: a,
    offset: c.offset + (a - c.start),
    length: b - a,
    fadeIn: a === c.start ? Math.min(c.fadeIn, b - a) : 0,
    fadeOut: b === c.start + c.length ? Math.min(c.fadeOut, b - a) : 0,
  };
}

/** Copies the time range [start, end) of the given tracks. */
export function copyRange(project: Project, start: Frames, end: Frames, trackIds: string[]): ClipboardData | null {
  if (end <= start) return null;
  const items: ClipboardItem[] = [];
  const muteRegions: ClipboardData['muteRegions'] = [];
  project.tracks.forEach((t, trackIndex) => {
    if (!trackIds.includes(t.id)) return;
    for (const c of t.clips) {
      const s = sliceClip(c, start, end);
      if (s) items.push({ trackId: t.id, trackIndex, clip: { ...s, start: s.start - start } });
    }
    for (const [a, b] of t.muteRegions ?? []) {
      const ra = Math.max(a, start);
      const rb = Math.min(b, end);
      if (rb > ra) muteRegions.push({ trackId: t.id, trackIndex, region: [ra - start, rb - start] });
    }
  });
  return { length: end - start, items, muteRegions };
}

/** Copies whole clips; the span runs from the first clip's start to the last clip's end. */
export function copyClips(project: Project, clipIds: Set<string>): ClipboardData | null {
  const found: Array<{ trackId: string; trackIndex: number; clip: Clip }> = [];
  project.tracks.forEach((t, trackIndex) => {
    for (const c of t.clips) if (clipIds.has(c.id)) found.push({ trackId: t.id, trackIndex, clip: c });
  });
  if (!found.length) return null;
  const from = Math.min(...found.map((f) => f.clip.start));
  const to = Math.max(...found.map((f) => f.clip.start + f.clip.length));
  return {
    length: to - from,
    items: found.map((f) => ({ ...f, clip: { ...f.clip, start: f.clip.start - from } })),
    muteRegions: [],
  };
}

/**
 * Pastes at `at`. With `ripple`, everything from `at` on (all tracks, markers) first moves right by
 * the copied length, so the paste goes into a gap. Returns the new project and the pasted clip ids.
 */
export function pasteClipboard(project: Project, data: ClipboardData, at: Frames, ripple: boolean): { project: Project; clipIds: string[] } {
  let p = ripple ? insertSilence(project, at, data.length) : (JSON.parse(JSON.stringify(project)) as Project);
  const target = (trackId: string, trackIndex: number) => p.tracks.find((t) => t.id === trackId) ?? p.tracks[trackIndex];
  const clipIds: string[] = [];
  for (const item of data.items) {
    const t = target(item.trackId, item.trackIndex);
    if (!t) continue;
    const id = uid('clp');
    t.clips.push({ ...JSON.parse(JSON.stringify(item.clip)), id, start: at + item.clip.start });
    t.clips.sort((a, b) => a.start - b.start);
    clipIds.push(id);
  }
  for (const m of data.muteRegions) {
    const t = target(m.trackId, m.trackIndex);
    if (t) p = addMuteRegion(p, t.id, at + m.region[0], at + m.region[1]);
  }
  return { project: p, clipIds };
}
