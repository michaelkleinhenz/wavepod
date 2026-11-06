// Sound effects library: a folder of audio files (with subfolders), searched by file and folder
// names. Pure helpers; main/soundLibrary.ts scans the folder, the renderer shows the panel.
import type { Clip } from '../shared/types';

export const LIBRARY_EXTENSIONS = ['wav', 'wave', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'aif', 'aiff', 'aifc', 'webm'];
/** A scan stops after this many files (and says so). */
export const MAX_LIBRARY_FILES = 200_000;

export interface LibraryEntry {
  /** Path inside the library folder, with "/" separators. */
  path: string;
  size: number;
}

export interface SoundLibraryInfo {
  /** The library folder, '' when none is set. */
  folder: string;
  files: LibraryEntry[];
  /** More files than MAX_LIBRARY_FILES: the rest were left out. */
  truncated: boolean;
  /** Why the folder could not be read. */
  error?: string;
}

export function isLibraryAudio(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && LIBRARY_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

/** Lower case, no accents, word separators as spaces ("Tür_knarrt-02.wav" → "tur knarrt 02 wav"). */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function libraryFileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The name without folder and extension. */
export function libraryTitle(path: string): string {
  const name = libraryFileName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function libraryFolderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

interface Indexed {
  entry: LibraryEntry;
  name: string;
  folder: string;
}

const indexCache = new WeakMap<LibraryEntry[], Indexed[]>();

function indexOf(entries: LibraryEntry[]): Indexed[] {
  let idx = indexCache.get(entries);
  if (!idx) {
    idx = entries.map((entry) => ({ entry, name: ` ${normalizeName(libraryTitle(entry.path))}`, folder: ` ${normalizeName(libraryFolderOf(entry.path))}` }));
    indexCache.set(entries, idx);
  }
  return idx;
}

/**
 * Files whose name or folder contains every word of the query (in any order; word beginnings,
 * so "door" finds "Door_Creak" and "doorbell" but not "indoor"). Best matches first: words in the
 * file name over words only in the folder, whole words over beginnings, then shorter names.
 * An empty query lists everything in folder order.
 */
export function searchLibrary(entries: LibraryEntry[], query: string, limit = Infinity): { results: LibraryEntry[]; total: number } {
  const words = normalizeName(query).split(' ').filter(Boolean);
  const idx = indexOf(entries);
  if (!words.length) return { results: entries.slice(0, limit), total: entries.length };
  const scored: Array<{ e: LibraryEntry; score: number; len: number; i: number }> = [];
  for (let i = 0; i < idx.length; i++) {
    const { entry, name, folder } = idx[i];
    let score = 0;
    let ok = true;
    for (const w of words) {
      const inName = name.indexOf(` ${w}`);
      if (inName >= 0) {
        const end = inName + 1 + w.length;
        score += end === name.length || name[end] === ' ' ? 4 : 3;
        continue;
      }
      if (folder.includes(` ${w}`)) {
        score += 1;
        continue;
      }
      ok = false;
      break;
    }
    if (ok) scored.push({ e: entry, score, len: name.length, i });
  }
  scored.sort((a, b) => b.score - a.score || a.len - b.len || a.i - b.i);
  return { results: scored.slice(0, limit).map((s) => s.e), total: scored.length };
}

/** The ranges of `text` (in code points) that start one of the query's words, for highlighting. */
export function matchRanges(text: string, query: string): Array<[number, number]> {
  const words = normalizeName(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const out: Array<[number, number]> = [];
  // compare character by character on a folded copy of the same length
  const chars = Array.from(text);
  const f = chars.map((c) => (normalizeName(c) || ' ')[0]).join('');
  for (const w of words) {
    for (let i = 0; i <= f.length - w.length; i++) {
      if ((i === 0 || f[i - 1] === ' ') && f.startsWith(w, i)) {
        out.push([i, i + w.length]);
        break;
      }
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/**
 * Clips that repeat a sound to fill [start, end): each repeat overlaps the one before by
 * `crossfade` frames with matching fades (an ambience bed without gaps or clicks). The last one is
 * cut at the end with a short fade out.
 */
export function fillClips(opts: { file: string; length: number; start: number; end: number; crossfade: number; id: () => string }): Clip[] {
  const { file, length, start, end, id } = opts;
  if (length <= 0 || end <= start) return [];
  const xf = Math.max(0, Math.min(opts.crossfade, Math.floor(length / 3)));
  const edge = Math.min(xf, Math.round(length / 20));
  const clips: Clip[] = [];
  let at = start;
  while (at < end) {
    const len = Math.min(length, end - at);
    const first = clips.length === 0;
    const last = at + length >= end;
    clips.push({
      id: id(),
      file,
      start: at,
      offset: 0,
      length: len,
      gain: 0,
      fadeIn: first ? Math.min(edge, len) : Math.min(xf, len),
      fadeOut: last ? Math.min(Math.max(edge, xf), len) : Math.min(xf, len),
    });
    if (last) break;
    at += length - xf;
  }
  return clips;
}
