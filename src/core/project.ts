// Pure project-editing operations. They return a new project and never touch the input.
import type { Clip, EnvelopePoint, Fx, Marker, MarkerKind, Project, Track } from '../shared/types';
import { uid } from '../shared/time';
import type { Chapter } from './chapters';
import { insertIntoRegions, mergeRegions, rippleRegions } from './muteRegions';
import { normalizeFx } from './fx/definitions';
import { migrateTrackEnvelope, sortPoints } from './envelope';

function normalizeFxList(list: unknown): Fx[] {
  return Array.isArray(list) ? list.map((f) => normalizeFx(f as Partial<Fx>)).filter((f): f is Fx => !!f) : [];
}

export const TRACK_COLORS = ['#4fc3f7', '#ffb74d', '#81c784', '#e57373', '#ba68c8', '#fff176', '#4db6ac', '#f06292'];

export function createProject(name = 'Untitled episode', sampleRate = 48000): Project {
  return {
    version: 1,
    name,
    sampleRate,
    bitDepth: 24,
    masterGain: 0,
    tracks: [],
    markers: [],
    soundboard: [],
    metadata: { title: name, podcast: '', author: '', episode: '', description: '', year: String(new Date().getFullYear()) },
  };
}

export function audibleTracks(project: Project): Track[] {
  const anySolo = project.tracks.some((t) => t.solo);
  return project.tracks.filter((t) => !t.mute && (!anySolo || t.solo));
}

/** Length of the project in frames (end of the last clip or marker). */
export function projectLength(project: Project): number {
  let end = 0;
  for (const t of project.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.length);
  for (const m of project.markers) end = Math.max(end, m.position);
  return end;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Fills defaults for projects saved by older versions or hand-edited files. */
export function normalizeProject(raw: Partial<Project>): Project {
  const base = createProject(raw.name, raw.sampleRate);
  const p: Project = { ...base, ...clone(raw), version: 1 } as Project;
  p.metadata = { ...base.metadata, ...(raw.metadata ?? {}) };
  p.tracks = (p.tracks ?? []).map((t, i) => ({
    id: t.id ?? uid('trk'),
    ...(t.kind === 'soundboard' ? { kind: 'soundboard' as const } : {}),
    name: t.name ?? `Track ${i + 1}`,
    color: t.color ?? TRACK_COLORS[i % TRACK_COLORS.length],
    inputChannels: t.inputChannels ?? [],
    armed: !!t.armed,
    mute: !!t.mute,
    solo: !!t.solo,
    gain: t.gain ?? 0,
    pan: t.pan ?? 0,
    muteRegions: mergeRegions(t.muteRegions ?? []),
    fx: normalizeFxList(t.fx),
    clips: (t.clips ?? []).map((c) => ({
      ...c,
      gain: c.gain ?? 0,
      fadeIn: c.fadeIn ?? 0,
      fadeOut: c.fadeOut ?? 0,
      offset: c.offset ?? 0,
      ...(Array.isArray(c.envelope) ? { envelope: sortPoints(c.envelope.filter((e) => Number.isFinite(e?.pos) && Number.isFinite(e?.db))) } : {}),
    })),
  }));
  // per-track volume lines (one early version) become per-clip ones
  (raw.tracks ?? []).forEach((t, i) => {
    const legacy = t as { envelope?: EnvelopePoint[]; showEnvelope?: boolean };
    if (p.tracks[i]) migrateTrackEnvelope(legacy.envelope, p.tracks[i].clips, !!legacy.showEnvelope);
  });
  p.markers = (p.markers ?? []).map((m) => ({ ...m, id: m.id ?? uid('mrk'), kind: m.kind ?? 'chapter', title: m.title ?? '' }));
  p.soundboard = p.soundboard ?? [];
  p.masterFx = normalizeFxList(p.masterFx);
  return p;
}

export function addTrack(project: Project, opts: Partial<Track> = {}): Project {
  const p = clone(project);
  const i = p.tracks.length;
  p.tracks.push({
    id: uid('trk'),
    name: `Track ${i + 1}`,
    color: TRACK_COLORS[i % TRACK_COLORS.length],
    inputChannels: [],
    armed: false,
    mute: false,
    solo: false,
    gain: 0,
    pan: 0,
    clips: [],
    ...opts,
  });
  return p;
}

export function updateTrack(project: Project, trackId: string, patch: Partial<Track>): Project {
  const p = clone(project);
  const t = p.tracks.find((x) => x.id === trackId);
  if (t) Object.assign(t, patch);
  return p;
}

export function removeTrack(project: Project, trackId: string): Project {
  const p = clone(project);
  p.tracks = p.tracks.filter((t) => t.id !== trackId);
  return p;
}

export function findClip(project: Project, clipId: string): { track: Track; clip: Clip } | null {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

export function addClip(project: Project, trackId: string, clip: Clip): Project {
  const p = clone(project);
  const t = p.tracks.find((x) => x.id === trackId);
  if (t) {
    t.clips.push(clip);
    t.clips.sort((a, b) => a.start - b.start);
  }
  return p;
}

export function updateClip(project: Project, clipId: string, patch: Partial<Clip>): Project {
  const p = clone(project);
  const found = findClip(p, clipId);
  if (found) Object.assign(found.clip, patch);
  return p;
}

export function moveClip(project: Project, clipId: string, newStart: number, toTrackId?: string): Project {
  const p = clone(project);
  const found = findClip(p, clipId);
  if (!found) return p;
  found.clip.start = Math.max(0, Math.round(newStart));
  if (toTrackId && toTrackId !== found.track.id) {
    const dest = p.tracks.find((t) => t.id === toTrackId);
    if (dest) {
      found.track.clips = found.track.clips.filter((c) => c.id !== clipId);
      dest.clips.push(found.clip);
    }
  }
  for (const t of p.tracks) t.clips.sort((a, b) => a.start - b.start);
  return p;
}

export function deleteClips(project: Project, clipIds: string[]): Project {
  const ids = new Set(clipIds);
  const p = clone(project);
  for (const t of p.tracks) t.clips = t.clips.filter((c) => !ids.has(c.id));
  return p;
}

/** Splits every clip that spans `position` (on the given tracks, or all tracks). */
export function splitAt(project: Project, position: number, trackIds?: string[]): Project {
  const p = clone(project);
  for (const t of p.tracks) {
    if (trackIds && !trackIds.includes(t.id)) continue;
    const next: Clip[] = [];
    for (const c of t.clips) {
      if (position > c.start && position < c.start + c.length) {
        const leftLen = position - c.start;
        next.push({ ...c, length: leftLen, fadeOut: 0 });
        next.push({
          ...c,
          id: uid('clp'),
          start: position,
          offset: c.offset + leftLen,
          length: c.length - leftLen,
          fadeIn: 0,
        });
      } else {
        next.push(c);
      }
    }
    t.clips = next;
  }
  return p;
}

/**
 * Removes the time range [start, end) from all tracks and markers and closes the
 * gap (Ultraschall-style ripple cut across the whole project).
 */
export function rippleDelete(project: Project, start: number, end: number): Project {
  if (end <= start) return clone(project);
  const len = end - start;
  let p = splitAt(splitAt(project, start), end);
  p = clone(p);
  for (const t of p.tracks) {
    t.clips = t.clips
      .filter((c) => !(c.start >= start && c.start + c.length <= end))
      .map((c) => (c.start >= end ? { ...c, start: c.start - len } : c));
    if (t.muteRegions?.length) t.muteRegions = rippleRegions(t.muteRegions, start, end);
  }
  p.markers = p.markers
    .filter((m) => m.position < start || m.position >= end)
    .map((m) => (m.position >= end ? { ...m, position: m.position - len } : m));
  return p;
}

/** Inserts silence at `position` on all tracks, shifting later material right. */
export function insertSilence(project: Project, position: number, length: number): Project {
  let p = splitAt(project, position);
  p = clone(p);
  for (const t of p.tracks) {
    for (const c of t.clips) if (c.start >= position) c.start += length;
    if (t.muteRegions?.length) t.muteRegions = insertIntoRegions(t.muteRegions, position, length);
  }
  for (const m of p.markers) if (m.position >= position) m.position += length;
  return p;
}

export function addMarker(project: Project, position: number, kind: MarkerKind = 'chapter', title?: string): { project: Project; marker: Marker } {
  const p = clone(project);
  const count = p.markers.filter((m) => m.kind === kind).length;
  const marker: Marker = {
    id: uid('mrk'),
    kind,
    position: Math.max(0, Math.round(position)),
    title: title ?? (kind === 'chapter' ? `Chapter ${count + 1}` : `Edit ${count + 1}`),
  };
  p.markers.push(marker);
  p.markers.sort((a, b) => a.position - b.position);
  return { project: p, marker };
}

export function updateMarker(project: Project, markerId: string, patch: Partial<Marker>): Project {
  const p = clone(project);
  const m = p.markers.find((x) => x.id === markerId);
  if (m) Object.assign(m, patch);
  p.markers.sort((a, b) => a.position - b.position);
  return p;
}

export function removeMarker(project: Project, markerId: string): Project {
  const p = clone(project);
  p.markers = p.markers.filter((m) => m.id !== markerId);
  return p;
}

export function markersToChapters(project: Project, offsetFrames = 0): Chapter[] {
  return project.markers
    .filter((m) => m.kind === 'chapter' && m.position >= offsetFrames)
    .map((m) => ({ start: (m.position - offsetFrames) / project.sampleRate, title: m.title, ...(m.url ? { url: m.url } : {}) }));
}

export function chaptersToMarkers(project: Project, chapters: Chapter[], replace = true): Project {
  const p = clone(project);
  if (replace) p.markers = p.markers.filter((m) => m.kind !== 'chapter');
  for (const c of chapters) {
    p.markers.push({
      id: uid('mrk'),
      kind: 'chapter',
      position: Math.round(c.start * p.sampleRate),
      title: c.title,
      ...(c.url ? { url: c.url } : {}),
    });
  }
  p.markers.sort((a, b) => a.position - b.position);
  return p;
}

/** Snapshot-based undo history. */
export class History {
  private past: string[] = [];
  private future: string[] = [];
  constructor(private limit = 200) {}

  push(previous: Project): void {
    this.past.push(JSON.stringify(previous));
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: Project): Project | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(JSON.stringify(current));
    return JSON.parse(prev) as Project;
  }

  redo(current: Project): Project | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(JSON.stringify(current));
    return JSON.parse(next) as Project;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}
