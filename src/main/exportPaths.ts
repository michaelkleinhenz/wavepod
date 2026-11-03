import * as fs from 'node:fs';
import * as path from 'node:path';

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Folder the export save dialog should open in. Native file choosers (notably GTK on Linux)
 * show an error when the default path's folder does not exist, so this always returns an
 * existing folder: the project's `export` subfolder (created on demand), else the project
 * folder itself, else the first existing fallback (e.g. Music, then home).
 */
export function exportDialogDir(projectDir: string, fallbacks: string[]): string {
  const exportDir = path.join(projectDir, 'export');
  if (isDir(projectDir)) {
    try {
      fs.mkdirSync(exportDir, { recursive: true });
    } catch {
      // Read-only project folder: fall through to the project folder.
    }
    return isDir(exportDir) ? exportDir : projectDir;
  }
  return fallbacks.find(isDir) ?? process.cwd();
}
