// Small JSON files that must survive a crash or power cut mid-write (the app settings): written to a
// temp file, flushed to disk and renamed over the old one, which is kept as `<file>.bak`. Reading
// falls back to that copy when the file itself is missing or damaged.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { syncDir, syncFd } from './wav';

export function writeJsonSafely(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    syncFd(fd);
  } finally {
    fs.closeSync(fd);
  }
  // the last good version stays next to it, in case this one turns out damaged
  if (readable(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(tmp, file);
  syncDir(path.dirname(file));
}

function readable(file: string): boolean {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads `file`, or its `.bak` copy when the file is missing or isn't valid JSON. `from` says which
 * one it was ('none' when neither could be read).
 */
export function readJsonSafely(file: string): { data: unknown; from: 'file' | 'backup' | 'none' } {
  for (const [f, from] of [[file, 'file'], [`${file}.bak`, 'backup']] as const) {
    try {
      return { data: JSON.parse(fs.readFileSync(f, 'utf8')), from };
    } catch {
      /* try the next one */
    }
  }
  return { data: null, from: 'none' };
}
