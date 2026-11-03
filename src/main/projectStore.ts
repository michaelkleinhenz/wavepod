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

/** Creates a fresh, uniquely named project folder under `root`. */
export function createProjectDir(root: string, sampleRate: number, date = new Date()): { dir: string; project: Project } {
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `Episode ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}${p(date.getMinutes())}`;
  let dir = path.join(root, base);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${base} (${i})`);
  const project = createProject(path.basename(dir), sampleRate);
  saveProject(dir, project);
  return { dir, project };
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
