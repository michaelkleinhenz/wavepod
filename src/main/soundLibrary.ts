// Scans the sound effects library folder (and its subfolders) for audio files.
import fs from 'node:fs';
import path from 'node:path';
import { MAX_LIBRARY_FILES, isLibraryAudio, type LibraryEntry, type SoundLibraryInfo } from '../core/soundLibrary';

/** Walks the folder without following symbolic links to folders (no loops); hidden entries are skipped. */
export async function scanLibrary(folder: string): Promise<SoundLibraryInfo> {
  if (!folder) return { folder: '', files: [], truncated: false };
  const files: LibraryEntry[] = [];
  let truncated = false;
  try {
    await fs.promises.access(folder);
  } catch {
    return { folder, files, truncated, error: 'The folder does not exist or cannot be read.' };
  }
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subfolder: skip it
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const subdirs: fs.Dirent[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) subdirs.push(e);
      else if ((e.isFile() || e.isSymbolicLink()) && isLibraryAudio(e.name)) {
        if (files.length >= MAX_LIBRARY_FILES) {
          truncated = true;
          return;
        }
        let size = 0;
        try {
          size = (await fs.promises.stat(path.join(dir, e.name))).size;
        } catch {
          continue; // dangling link
        }
        files.push({ path: rel ? `${rel}/${e.name}` : e.name, size });
      }
    }
    for (const d of subdirs) {
      if (truncated) return;
      await walk(path.join(dir, d.name), rel ? `${rel}/${d.name}` : d.name);
    }
  };
  await walk(folder, '');
  return { folder, files, truncated };
}

/** The absolute path of a library file; refuses paths that leave the folder. */
export function libraryFilePath(folder: string, rel: string): string {
  const abs = path.resolve(folder, rel);
  const root = path.resolve(folder);
  if (!folder || (abs !== root && !abs.startsWith(root + path.sep))) throw new Error('That file is not in the sound library.');
  return abs;
}
