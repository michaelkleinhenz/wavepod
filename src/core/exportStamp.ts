// Which exported MP3 is still the episode as it is now. After a whole-episode MP3 export the main
// process writes a stamp next to the project (last-export.json): the file, its size and time, and a
// fingerprint of everything that goes into the mix and its tags. File › Upload to LetsCast.fm uploads
// that MP3 instead of rendering again while the stamp still matches.
import type { EpisodeMetadata, Project } from '../shared/types';

export const EXPORT_STAMP_FILE = 'last-export.json';

/** The last whole-episode MP3 export of a project. */
export interface ExportStamp {
  /** Absolute path of the MP3. */
  path: string;
  size: number;
  mtimeMs: number;
  /** projectFingerprint() of the episode when it was exported. */
  fingerprint: string;
  /** When it was written (ms since 1970). */
  at: number;
}

/** What WavePod knows about an exported MP3 when the upload dialog opens. */
export interface ExportedMp3 {
  path: string;
  /** When it was exported (ms since 1970). */
  at: number;
  /** The episode has not changed since, and the file is the one WavePod wrote. */
  current: boolean;
  /** Why it is not current, for the user. */
  reason?: string;
}

/** Host-only details: sent to LetsCast.fm, never written into the file. */
const HOST_ONLY: Array<keyof EpisodeMetadata> = ['showNotes', 'subtitle', 'keywords', 'episodeType', 'publishDate', 'siteUrl', 'youtubeId', 'explicit', 'hidden', 'hideOnPlatforms'];

/**
 * A short hash of the parts of the episode that change the exported MP3: tracks, clips, levels,
 * filters, automation, markers (chapters) and the tags. Things that only matter in the app (colours,
 * armed tracks, the script, the soundboard, show notes, export settings) are left out, so they don't
 * make an export look out of date.
 */
export function projectFingerprint(project: Project): string {
  const metadata: Partial<EpisodeMetadata> = { ...project.metadata };
  for (const k of HOST_ONLY) delete metadata[k];
  const relevant = {
    sampleRate: project.sampleRate,
    masterGain: project.masterGain,
    masterFx: project.masterFx ?? [],
    tracks: project.tracks.map(({ color: _c, armed: _a, inputChannels: _i, showTakes: _s, voice: _v, remote: _r, ...t }) => t),
    folders: (project.folders ?? []).map(({ color: _c, collapsed: _k, ...f }) => f),
    markers: project.markers,
    metadata,
  };
  return hash(stableJson(relevant));
}

/** Whether a stamp still describes `file` (its size and time now) for the episode as it is. */
export function checkStamp(stamp: ExportStamp, project: Project, file: { size: number; mtimeMs: number } | null): ExportedMp3 {
  const base = { path: stamp.path, at: stamp.at };
  if (!file) return { ...base, current: false, reason: 'The exported MP3 is not there any more.' };
  if (file.size !== stamp.size || Math.abs(file.mtimeMs - stamp.mtimeMs) > 1) return { ...base, current: false, reason: 'The MP3 was changed or replaced after the export.' };
  if (stamp.fingerprint !== projectFingerprint(project)) return { ...base, current: false, reason: 'The episode was changed after the export.' };
  return { ...base, current: true };
}

/** Reads a stamp from JSON; null when it is not one. */
export function parseStamp(raw: unknown): ExportStamp | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.path !== 'string' || !/\.mp3$/i.test(s.path)) return null;
  if (typeof s.size !== 'number' || typeof s.mtimeMs !== 'number' || typeof s.fingerprint !== 'string') return null;
  return { path: s.path, size: s.size, mtimeMs: s.mtimeMs, fingerprint: s.fingerprint, at: typeof s.at === 'number' ? s.at : s.mtimeMs };
}

/** JSON with object keys sorted, so the same content always gives the same text. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableJson(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Two 32-bit FNV-1a hashes with different seeds, as hex: plenty to notice a change. */
function hash(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
