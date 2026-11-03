// Project folders: project.json + media/. Saved atomically.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Project } from '../shared/types';
import { createProject, normalizeProject } from '../core/project';

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
