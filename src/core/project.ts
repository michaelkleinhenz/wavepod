// Pure project-editing operations. They return a new project and never touch the input.
import type { Clip, EnvelopePoint, Frames, Fx, Marker, MarkerKind, Project, Track } from '../shared/types';
import { uid } from '../shared/time';
import type { Chapter } from './chapters';
import { insertIntoRegions, mergeRegions, rippleRegions } from './muteRegions';
import { normalizeFx } from './fx/definitions';
import { insertIntoRegionList, normalizeRegions, rippleDeleteRegions } from './regions';
import { migrateTrackEnvelope, sortPoints } from './envelope';
import { mapTrackAutomation, normalizeAutomation, shiftAutomation } from './automation';
import { clampRate } from './clipSound';
import { audibleTracks, groupFolderTracks, normalizeFolders } from './folders';

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

export { audibleTracks };

/** Length of the project in frames (end of the last clip or marker). */
/** Where the last clip on the timeline ends (playback stops there). */
export function clipsEnd(project: Project): number {
  let end = 0;
  for (const t of project.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.length);
  return end;
}

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
    pan: Number.isFinite(t.pan) ? Math.max(-1, Math.min(1, t.pan)) : 0,
    ...(normalizeAutomation(t.automation) ? { automation: normalizeAutomation(t.automation) } : {}),
    muteRegions: mergeRegions(t.muteRegions ?? []),
    fx: normalizeFxList(t.fx),
    ...(t.duck ? { duck: { enabled: !!t.duck.enabled, depth: Number.isFinite(t.duck.depth) ? Math.min(40, Math.max(1, Math.abs(t.duck.depth))) : 12 } } : {}),
    ...(t.automix ? { automix: { enabled: !!t.automix.enabled, depth: Number.isFinite(t.automix.depth) ? Math.min(60, Math.max(1, Math.abs(t.automix.depth))) : 18 } } : {}),
    ...(t.voice && typeof t.voice.id === 'string' && t.voice.id ? { voice: { id: t.voice.id, name: String(t.voice.name ?? ''), ...(t.voice.cloned ? { cloned: true } : {}) } } : {}),
    ...(typeof t.folderId === 'string' && t.folderId ? { folderId: t.folderId } : {}),
    clips: (t.clips ?? []).map((c) => ({
      ...c,
      gain: c.gain ?? 0,
      fadeIn: c.fadeIn ?? 0,
      fadeOut: c.fadeOut ?? 0,
      offset: c.offset ?? 0,
      sound: undefined,
      ...(c.fx !== undefined ? { fx: normalizeFxList(c.fx) } : {}),
      ...normalizeSound(c.sound),
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
  if (raw.regions !== undefined) p.regions = normalizeRegions(raw.regions);
  normalizeFolders(p);
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
  // a track made inside a folder joins the end of it
  if (opts.folderId) p.tracks = groupFolderTracks(p.tracks);
  return p;
}

/**
 * Ultraschall's "Prepare all tracks for editing": takes every track out of record so that pressing
 * R while cutting can't start a new take. Returns the same project when nothing was armed.
 */
export function prepareForEditing(project: Project): Project {
  if (!project.tracks.some((t) => t.armed)) return project;
  const p = clone(project);
  for (const t of p.tracks) t.armed = false;
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
    mapTrackAutomation(t, (pts) => shiftAutomation(pts, end, -len));
  }
  if (p.regions?.length) p.regions = rippleDeleteRegions(p.regions, start, end);
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
    mapTrackAutomation(t, (pts) => shiftAutomation(pts, position, length));
  }
  for (const m of p.markers) if (m.position >= position) m.position += length;
  if (p.regions?.length) p.regions = insertIntoRegionList(p.regions, position, length);
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

/**
 * Moves a chapter's content (title, link, image) to another chapter slot. The chapter start
 * times stay where they are; the content of the chapters in between shifts by one slot, like
 * reordering a list. For fixing chapter text typed in the wrong order.
 */
export function moveChapterContent(project: Project, fromId: string, toId: string): Project {
  const p = clone(project);
  const chapters = p.markers.filter((m) => m.kind === 'chapter').sort((a, b) => a.position - b.position);
  const from = chapters.findIndex((m) => m.id === fromId);
  const to = chapters.findIndex((m) => m.id === toId);
  if (from < 0 || to < 0 || from === to) return p;
  const contents = chapters.map((m) => ({ title: m.title, url: m.url, image: m.image }));
  const [moved] = contents.splice(from, 1);
  contents.splice(to, 0, moved);
  chapters.forEach((m, i) => {
    const c = contents[i];
    m.title = c.title;
    if (c.url) m.url = c.url;
    else delete m.url;
    if (c.image) m.image = c.image;
    else delete m.image;
  });
  return p;
}

/**
 * Fills the existing chapters, in time order, with titles, links and images (e.g. from a
 * "title;link;image" list). Start times stay; a line without a link clears the chapter's link,
 * a line without an image keeps the chapter's image. Chapters
 * beyond the list are left alone, lines beyond the chapters are not used.
 */
export function applyChapterContent(project: Project, content: Array<{ title: string; url?: string; image?: string }>): Project {
  const p = clone(project);
  const chapters = p.markers.filter((m) => m.kind === 'chapter').sort((a, b) => a.position - b.position);
  chapters.forEach((m, i) => {
    const c = content[i];
    if (!c) return;
    m.title = c.title;
    if (c.url) m.url = c.url;
    else delete m.url;
    if (c.image) m.image = c.image;
  });
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
    .map((m) => ({
      start: (m.position - offsetFrames) / project.sampleRate,
      title: m.title,
      ...(m.url ? { url: m.url } : {}),
      ...(m.image ? { image: m.image } : {}),
    }));
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
      ...(c.image ? { image: c.image } : {}),
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

export interface ChapterWarning {
  kind: 'no-start' | 'untitled';
  message: string;
  /** Marker the warning is about (untitled chapters). */
  markerId?: string;
}

/**
 * Problems podcatchers show to listeners: no chapter at the start of the episode (or of the
 * exported range) and chapters without a title. Nothing to report when there are no chapters.
 */
export function chapterWarnings(project: Project, rangeStart: Frames = 0, rangeEnd = Infinity): ChapterWarning[] {
  const chapters = project.markers.filter((m) => m.kind === 'chapter' && m.position >= rangeStart && m.position < rangeEnd);
  if (!chapters.length) return [];
  const out: ChapterWarning[] = [];
  // within 0.5 s of the start counts as "at the start"
  const first = Math.min(...chapters.map((m) => m.position));
  if (first - rangeStart > project.sampleRate / 2) {
    out.push({ kind: 'no-start', message: 'The first chapter does not start at 0:00, so podcatchers show no chapter before it.' });
  }
  for (const m of chapters.sort((a, b) => a.position - b.position)) {
    if (!m.title.trim()) {
      const t = (m.position - rangeStart) / project.sampleRate;
      out.push({ kind: 'untitled', markerId: m.id, message: `The chapter at ${formatClock(t)} has no title.` });
    }
  }
  return out;
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/** Keeps a clip's reverse / varispeed / loop settings when they make sense, else drops them. */
function normalizeSound(s: Clip['sound']): Pick<Clip, 'sound'> | Record<string, never> {
  if (!s || typeof s !== 'object') return {};
  const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!ok(s.start) || !ok(s.length) || !ok(s.base) || s.length <= 0) return {};
  const rate = ok(s.rate) ? clampRate(s.rate!) : 1;
  if (!s.reverse && !s.loop && rate === 1 && s.start === s.base) return {};
  return {
    sound: {
      ...(s.reverse ? { reverse: true } : {}),
      ...(rate !== 1 ? { rate } : {}),
      ...(s.loop ? { loop: true } : {}),
      start: s.start,
      length: s.length,
      base: s.base,
    },
  };
}
