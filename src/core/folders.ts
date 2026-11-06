// Track folders: named groups of tracks (Dialogue, SFX, Atmo, Music, …) with group mute, solo and volume.
// A folder is not a bus: its members still mix straight into the master, the folder only adds its
// gain to theirs and takes part in mute/solo. Members always sit next to each other in project.tracks,
// so the order the timeline shows is the order everything else (export, MCP, menus) sees.
import type { Project, Track, TrackFolder } from '../shared/types';
import { uid } from '../shared/time';

export const FOLDER_COLORS = ['#64b5f6', '#ffa726', '#66bb6a', '#ab47bc', '#ef5350', '#26c6da', '#d4e157', '#8d6e63'];

/** The folders an audio drama usually needs, in mixing order. */
export const DRAMA_FOLDERS = ['Dialogue', 'SFX', 'Atmo', 'Music'];

export const FOLDER_GAIN_MIN = -24;
export const FOLDER_GAIN_MAX = 12;

export type TimelineRow = { kind: 'folder'; folder: TrackFolder; members: Track[] } | { kind: 'track'; track: Track; folder?: TrackFolder };

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const clampGain = (g: number) => Math.max(FOLDER_GAIN_MIN, Math.min(FOLDER_GAIN_MAX, g));

export function folderById(project: Project, id: string | undefined): TrackFolder | undefined {
  return id ? project.folders?.find((f) => f.id === id) : undefined;
}

export function folderOf(project: Project, track: Track | undefined): TrackFolder | undefined {
  return folderById(project, track?.folderId);
}

export function folderMembers(project: Project, folderId: string): Track[] {
  return project.tracks.filter((t) => t.folderId === folderId);
}

/** The group volume added to a track's own gain (0 outside a folder). */
export function folderGainOf(project: Project, track: Track): number {
  return folderOf(project, track)?.gain ?? 0;
}

/**
 * Whether a track plays, with folder mute and solo: a muted folder silences its tracks; a soloed
 * folder lets all its tracks through. When anything is soloed, a track plays if it or its folder is.
 */
export function audibleTracks(project: Project): Track[] {
  const folders = new Map((project.folders ?? []).map((f) => [f.id, f]));
  const anySolo = project.tracks.some((t) => t.solo) || (project.folders ?? []).some((f) => f.solo);
  return project.tracks.filter((t) => {
    const f = t.folderId ? folders.get(t.folderId) : undefined;
    if (t.mute || f?.mute) return false;
    return !anySolo || t.solo || !!f?.solo;
  });
}

/** Moves each folder's members together, where its first member is; everything else keeps its order. */
export function groupFolderTracks(tracks: Track[]): Track[] {
  const out: Track[] = [];
  const done = new Set<string>();
  for (const t of tracks) {
    if (!t.folderId) out.push(t);
    else if (!done.has(t.folderId)) {
      done.add(t.folderId);
      out.push(...tracks.filter((x) => x.folderId === t.folderId));
    }
  }
  return out;
}

/** Fills defaults, drops links to folders that don't exist and groups members (projects from older versions have none). */
export function normalizeFolders(project: Project): Project {
  const raw = Array.isArray(project.folders) ? project.folders : [];
  const seen = new Set<string>();
  const folders: TrackFolder[] = [];
  raw.forEach((f, i) => {
    if (!f || typeof f !== 'object') return;
    const id = typeof f.id === 'string' && f.id ? f.id : uid('fld');
    if (seen.has(id)) return;
    seen.add(id);
    folders.push({
      id,
      name: typeof f.name === 'string' && f.name ? f.name : `Folder ${i + 1}`,
      color: typeof f.color === 'string' && f.color ? f.color : FOLDER_COLORS[i % FOLDER_COLORS.length],
      mute: !!f.mute,
      solo: !!f.solo,
      gain: Number.isFinite(f.gain) ? clampGain(f.gain) : 0,
      ...(f.collapsed ? { collapsed: true } : {}),
    });
  });
  for (const t of project.tracks) if (t.folderId !== undefined && !seen.has(t.folderId)) delete t.folderId;
  if (folders.length) project.folders = folders;
  else delete project.folders;
  project.tracks = groupFolderTracks(project.tracks);
  return project;
}

/** Adds a folder (at the end) and puts the given tracks into it. */
export function addFolder(project: Project, opts: Partial<TrackFolder> & { trackIds?: string[] } = {}): Project {
  const { trackIds = [], ...rest } = opts;
  let p = clone(project);
  const n = p.folders?.length ?? 0;
  const folder: TrackFolder = {
    id: uid('fld'),
    name: `Folder ${n + 1}`,
    color: FOLDER_COLORS[n % FOLDER_COLORS.length],
    mute: false,
    solo: false,
    gain: 0,
    ...rest,
  };
  folder.gain = clampGain(folder.gain);
  p.folders = [...(p.folders ?? []), folder];
  for (const t of project.tracks) if (trackIds.includes(t.id)) p = setTrackFolder(p, t.id, folder.id);
  return p;
}

/** Adds the usual audio drama folders that are not there yet (by name). */
export function addDramaFolders(project: Project): Project {
  let p = project;
  const have = new Set((project.folders ?? []).map((f) => f.name.trim().toLowerCase()));
  DRAMA_FOLDERS.forEach((name, i) => {
    if (!have.has(name.toLowerCase())) p = addFolder(p, { name, color: FOLDER_COLORS[i] });
  });
  return p;
}

export function updateFolder(project: Project, folderId: string, patch: Partial<Omit<TrackFolder, 'id'>>): Project {
  const p = clone(project);
  const f = p.folders?.find((x) => x.id === folderId);
  if (!f) return project;
  Object.assign(f, patch);
  f.gain = Number.isFinite(f.gain) ? clampGain(f.gain) : 0;
  if (!f.collapsed) delete f.collapsed;
  return p;
}

/** Removes a folder; its tracks stay where they are, outside any folder. */
export function removeFolder(project: Project, folderId: string): Project {
  if (!folderById(project, folderId)) return project;
  const p = clone(project);
  p.folders = p.folders!.filter((f) => f.id !== folderId);
  if (!p.folders.length) delete p.folders;
  for (const t of p.tracks) if (t.folderId === folderId) delete t.folderId;
  return p;
}

/**
 * Puts a track into a folder (after its last member) or takes it out (null: it goes right below the
 * folder it left). A folder without members takes the track where it is.
 */
export function setTrackFolder(project: Project, trackId: string, folderId: string | null): Project {
  const from = project.tracks.findIndex((t) => t.id === trackId);
  if (from < 0) return project;
  const cur = project.tracks[from].folderId ?? null;
  if (cur === folderId) return project;
  if (folderId && !folderById(project, folderId)) return project;
  const p = clone(project);
  const [t] = p.tracks.splice(from, 1);
  const anchor = folderId ?? cur;
  let last = -1;
  p.tracks.forEach((x, i) => {
    if (x.folderId === anchor) last = i;
  });
  if (folderId) t.folderId = folderId;
  else delete t.folderId;
  p.tracks.splice(last >= 0 ? last + 1 : from, 0, t);
  p.tracks = groupFolderTracks(p.tracks);
  return p;
}

/**
 * The rows of the timeline: each folder's row comes where its first member is, followed by its
 * members unless it is collapsed. Folders without tracks come last.
 */
export function timelineRows(project: Project): TimelineRow[] {
  const folders = new Map((project.folders ?? []).map((f) => [f.id, f]));
  const rows: TimelineRow[] = [];
  const done = new Set<string>();
  for (const t of project.tracks) {
    const f = t.folderId ? folders.get(t.folderId) : undefined;
    if (!f) {
      rows.push({ kind: 'track', track: t });
      continue;
    }
    if (done.has(f.id)) continue;
    done.add(f.id);
    const members = project.tracks.filter((x) => x.folderId === f.id);
    rows.push({ kind: 'folder', folder: f, members });
    if (!f.collapsed) for (const m of members) rows.push({ kind: 'track', track: m, folder: f });
  }
  for (const f of project.folders ?? []) if (!done.has(f.id)) rows.push({ kind: 'folder', folder: f, members: [] });
  return rows;
}
