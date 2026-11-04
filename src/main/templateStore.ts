// Template folders: template.json + sounds/ (copies of the soundboard jingles). One folder per template.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Project, SoundboardSlot } from '../shared/types';
import {
  normalizeTemplate,
  projectFromTemplate,
  projectToTemplate,
  summarizeTemplate,
  templateFolderName,
  type ProjectTemplate,
  type TemplateSummary,
} from '../core/template';
import { createProjectDir, saveProject } from './projectStore';

export const TEMPLATE_FILE = 'template.json';
const SOUNDS = 'sounds';

function templateDir(root: string, id: string): string {
  if (!id || id !== path.basename(id) || id === '.' || id === '..') throw new Error(`Invalid template name "${id}"`);
  return path.join(root, id);
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** Copies each slot's file into `destDir/sounds/` and points the slot at the copy ("sounds/<name>"). */
function copySounds(slots: SoundboardSlot[], fromDir: string, destDir: string): SoundboardSlot[] {
  const used = new Set<string>();
  return slots.map((slot) => {
    const src = path.resolve(fromDir, slot.file);
    if (!fs.existsSync(src)) return slot; // keep the reference; the soundboard reports the missing file
    const ext = path.extname(src);
    const stem = path.basename(src, ext).replace(/[^\p{L}\p{N}_ -]+/gu, '_') || 'jingle';
    let name = `${stem}${ext}`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${stem}-${i}${ext}`;
    used.add(name.toLowerCase());
    fs.mkdirSync(path.join(destDir, SOUNDS), { recursive: true });
    const dest = path.join(destDir, SOUNDS, name);
    if (path.resolve(dest) !== src) fs.copyFileSync(src, dest);
    return { ...slot, file: `${SOUNDS}/${name}` };
  });
}

/** Copies the episode cover into `destDir` (same relative path) so the template or new project has its own copy. */
function copyArtwork(rel: string | undefined, fromDir: string, destDir: string): string | undefined {
  if (!rel) return undefined;
  const src = path.resolve(fromDir, rel);
  if (!fs.existsSync(src)) return undefined;
  const name = `images/${path.basename(src)}`;
  fs.mkdirSync(path.join(destDir, 'images'), { recursive: true });
  const dest = path.join(destDir, name);
  if (path.resolve(dest) !== src) fs.copyFileSync(src, dest);
  return name;
}

function withArtwork<T extends { artwork?: string }>(meta: T, artwork: string | undefined): T {
  const { artwork: _a, ...rest } = meta;
  return (artwork ? { ...rest, artwork } : rest) as T;
}

export function listTemplates(root: string): TemplateSummary[] {
  if (!fs.existsSync(root)) return [];
  const out: TemplateSummary[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(summarizeTemplate(entry.name, loadTemplate(root, entry.name)));
    } catch {
      // not a template folder, or unreadable: skip it
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadTemplate(root: string, id: string): ProjectTemplate {
  const raw = JSON.parse(fs.readFileSync(path.join(templateDir(root, id), TEMPLATE_FILE), 'utf8')) as Partial<ProjectTemplate>;
  return normalizeTemplate(raw, id);
}

/**
 * Saves the setup of `project` (opened from `projectDir`) as a template named `name`.
 * A template with the same folder name is replaced.
 */
export function saveTemplate(root: string, project: Project, projectDir: string, name: string, inputDevice?: string): TemplateSummary {
  const clean = name.trim();
  if (!clean) throw new Error('Please give the template a name.');
  const id = templateFolderName(clean);
  const dir = templateDir(root, id);
  // Build in a fresh folder first so a failed copy never leaves a half-written template behind.
  const staging = `${dir}.saving`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    const template = projectToTemplate(project, clean, inputDevice);
    template.soundboard = copySounds(template.soundboard, projectDir, staging);
    template.metadata = withArtwork(template.metadata, copyArtwork(template.metadata.artwork, projectDir, staging));
    writeJsonAtomic(path.join(staging, TEMPLATE_FILE), template);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
    return summarizeTemplate(id, template);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

export function deleteTemplate(root: string, id: string): void {
  const dir = templateDir(root, id);
  if (!fs.existsSync(path.join(dir, TEMPLATE_FILE))) throw new Error(`There is no template "${id}".`);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Creates a new project folder under `projectsRoot` set up like the template; jingles are copied into it. */
export function createProjectFromTemplate(
  projectsRoot: string,
  templatesRoot: string,
  id: string,
  sampleRate: number,
  date = new Date(),
  name?: string,
): { dir: string; project: Project } {
  const template = loadTemplate(templatesRoot, id);
  const created = createProjectDir(projectsRoot, sampleRate, date, name);
  const dir = created.dir;
  const project = projectFromTemplate(template, created.project.name, sampleRate);
  project.soundboard = copySounds(project.soundboard, templateDir(templatesRoot, id), dir);
  project.metadata = withArtwork(project.metadata, copyArtwork(project.metadata.artwork, templateDir(templatesRoot, id), dir));
  saveProject(dir, project);
  return { dir, project };
}
