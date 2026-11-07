// Project folders: project.json + media/. Saved atomically.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Project } from '../shared/types';
import { createProject, normalizeProject } from '../core/project';
import { imageMime } from '../core/id3';

export const PROJECT_FILE = 'project.json';

export function loadProject(dir: string): Project {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, PROJECT_FILE), 'utf8')) as Partial<Project>;
  return normalizeProject(raw);
}

export function saveProject(dir: string, project: Project): void {
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  const file = path.join(dir, PROJECT_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(project, null, 2));
  fs.renameSync(tmp, file);
}

export function isProjectDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, PROJECT_FILE));
}

/** The name a new episode gets unless the user types another one, e.g. "Episode 2026-11-04 1715". */
export function defaultEpisodeName(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Episode ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}${p(date.getMinutes())}`;
}

/** A folder name for an episode name: drops characters that aren't allowed in file names on Windows, macOS or Linux. */
export function episodeFolderName(name: string): string {
  return (
    name
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
      .replace(/^[ .]+|[ .]+$/g, '')
      .slice(0, 120) || 'Episode'
  );
}

/** A folder under `root` for `name` that doesn't exist yet: "Name", "Name (2)", "Name (3)", … */
export function freeProjectDir(root: string, name: string): string {
  const base = episodeFolderName(name);
  let dir = path.join(root, base);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${base} (${i})`);
  return dir;
}

/** Creates a fresh, uniquely named project folder under `root`, named after the episode. */
export function createProjectDir(root: string, sampleRate: number, date = new Date(), name?: string): { dir: string; project: Project } {
  const wanted = name?.trim() || defaultEpisodeName(date);
  const dir = freeProjectDir(root, wanted);
  // the episode keeps the name as typed; only the folder needs a suffix when the name is taken
  const project = createProject(name?.trim() ? wanted : path.basename(dir), sampleRate);
  saveProject(dir, project);
  return { dir, project };
}

/** Files of a project folder that a copy leaves out: the recording journal belongs to the original. */
function copyFilter(src: string): boolean {
  const base = path.basename(src);
  return base !== 'recording-in-progress.json' && !base.endsWith('.tmp');
}

/**
 * Save As: copies the project folder (media, images, backups) to a new folder named `name` next to
 * it, then saves `project` there under the new name. Files are cloned where the file system can
 * (copy-on-write), otherwise copied. The original folder is left as it is.
 */
export async function copyProjectDir(dir: string, project: Project, name: string): Promise<{ dir: string; project: Project }> {
  const target = freeProjectDir(path.dirname(dir), name);
  try {
    await fs.promises.cp(dir, target, { recursive: true, filter: copyFilter, mode: fs.constants.COPYFILE_FICLONE, errorOnExist: true, force: false });
    const copy: Project = { ...project, name: name.trim() };
    saveProject(target, copy);
    return { dir: target, project: copy };
  } catch (e) {
    // don't leave half a copy behind
    await fs.promises.rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

/**
 * Copies a JPEG or PNG into `<projectDir>/images/` (unless it is already inside the project
 * folder) and returns its path relative to the project folder.
 */
export function importImage(projectDir: string, src: string): string {
  const data = fs.readFileSync(src);
  if (!imageMime(data)) throw new Error('Please choose a JPEG or PNG image.');
  const abs = path.resolve(src);
  const rel = path.relative(projectDir, abs);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  const ext = path.extname(abs).toLowerCase() || (imageMime(data) === 'image/png' ? '.png' : '.jpg');
  const stem = path.basename(abs, path.extname(abs)).replace(/[^\p{L}\p{N}_ -]+/gu, '_') || 'image';
  fs.mkdirSync(path.join(projectDir, 'images'), { recursive: true });
  let name = `images/${stem}${ext}`;
  for (let i = 2; fs.existsSync(path.join(projectDir, name)); i++) name = `images/${stem}-${i}${ext}`;
  fs.writeFileSync(path.join(projectDir, name), data);
  return name;
}

export const BACKUP_DIR = 'backup';
export const BACKUP_KEEP = 20;

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Backups of a project, newest first (absolute paths). */
export function listBackups(dir: string): string[] {
  const b = path.join(dir, BACKUP_DIR);
  if (!fs.existsSync(b)) return [];
  return fs
    .readdirSync(b)
    .filter((f) => /^project-.*\.json$/.test(f))
    .sort()
    .reverse()
    .map((f) => path.join(b, f));
}

/**
 * Writes `backup/project-<date>[-<reason>].json` and deletes all but the newest `keep` backups.
 * Returns the backup's path.
 */
export function backupProject(dir: string, project: Project, reason = '', date = new Date(), keep = BACKUP_KEEP): string {
  const b = path.join(dir, BACKUP_DIR);
  fs.mkdirSync(b, { recursive: true });
  let file = path.join(b, `project-${stamp(date)}${reason ? `-${reason}` : ''}.json`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(b, `project-${stamp(date)}${reason ? `-${reason}` : ''}-${i}.json`);
  fs.writeFileSync(file, JSON.stringify(project, null, 2));
  for (const old of listBackups(dir).slice(keep)) fs.rmSync(old, { force: true });
  return file;
}

/** Reads a backup file as a project (with defaults filled in). */
export function loadBackup(file: string): Project {
  return normalizeProject(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Project>);
}

/** Episode folders directly inside `root` (the WavePod folder), most recently saved first. */
export function listProjects(root: string, limit = 30): Array<{ name: string; dir: string; modified: number }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ name: string; dir: string; modified: number }> = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const file = path.join(dir, PROJECT_FILE);
    let modified: number;
    try {
      modified = fs.statSync(file).mtimeMs;
    } catch {
      continue; // not an episode folder (Templates, Presets, …)
    }
    let name = e.name;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: unknown };
      if (typeof raw.name === 'string' && raw.name.trim()) name = raw.name;
    } catch {
      /* damaged: still listed under its folder name, opening it offers the backup */
    }
    out.push({ name, dir, modified });
  }
  return out.sort((a, b) => b.modified - a.modified).slice(0, limit);
}

/** True if the project has nothing in it yet worth keeping: no recorded or imported audio, chapters or jingles. */
export function isUntouchedProject(project: Project): boolean {
  return (
    project.tracks.every((t) => !t.clips.length) &&
    !project.markers.length &&
    !project.soundboard.length
  );
}

/** True if `dir` has a project.json that can't be read as a project (damaged, cut short, not JSON). */
export function isDamagedProject(dir: string): boolean {
  if (!isProjectDir(dir)) return false;
  try {
    loadProject(dir);
    return false;
  } catch {
    return true;
  }
}

/**
 * Replaces a damaged project.json with the newest backup that can be read. The damaged file is kept
 * as `damaged-project-<date>.json` in the backup folder (not listed as a backup). Returns the backup used, or null when there
 * is none (nothing is changed then).
 */
export function restoreNewestBackup(dir: string, date = new Date()): string | null {
  for (const file of listBackups(dir)) {
    let project: Project;
    try {
      project = loadBackup(file);
    } catch {
      continue;
    }
    const current = path.join(dir, PROJECT_FILE);
    if (fs.existsSync(current)) {
      let keep = path.join(dir, BACKUP_DIR, `damaged-project-${stamp(date)}.json`);
      for (let i = 2; fs.existsSync(keep); i++) keep = path.join(dir, BACKUP_DIR, `damaged-project-${stamp(date)}-${i}.json`);
      fs.renameSync(current, keep);
    }
    saveProject(dir, project);
    return file;
  }
  return null;
}
