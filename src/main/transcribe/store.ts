// Transcripts on disk: one JSON file per media file in the episode's transcripts/ folder.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileTranscript } from '../../shared/types';
import { transcriptPath } from '../../core/transcript';

export function loadTranscript(projectDir: string, file: string): FileTranscript | null {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(projectDir, transcriptPath(file)), 'utf8')) as FileTranscript;
    return t?.version === 1 && Array.isArray(t.words) ? { ...t, file } : null;
  } catch {
    return null;
  }
}

export function saveTranscript(projectDir: string, t: FileTranscript): void {
  const dest = path.join(projectDir, transcriptPath(t.file));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t));
  fs.renameSync(tmp, dest);
}

export function deleteTranscript(projectDir: string, file: string): void {
  fs.rmSync(path.join(projectDir, transcriptPath(file)), { force: true });
}

/** The transcripts of the given media files that exist, by file. */
export function loadTranscripts(projectDir: string, files: Iterable<string>): Record<string, FileTranscript> {
  const out: Record<string, FileTranscript> = {};
  for (const f of new Set(files)) {
    const t = loadTranscript(projectDir, f);
    if (t) out[f] = t;
  }
  return out;
}
