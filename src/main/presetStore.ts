// The user's filter presets: Presets/<filter or plug-in name>/<preset name>.json, next to Templates.
// Files are matched to filters by their content (type, plug-in class id), not by folder name,
// so presets can be copied between machines or renamed by hand.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Fx } from '../shared/types';
import { fxDefinition } from '../core/fx/definitions';
import { normalizePreset, presetKey, presetKeyOf, type FxPreset, type FxPresetEntry } from '../core/fx/presets';

const USER_PREFIX = 'user:';

/** A file or folder name from a display name. */
function safeName(name: string, fallback: string): string {
  return name.trim().replace(/[^\p{L}\p{N}_ ()+-]+/gu, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 80) || fallback;
}

function groupFolder(preset: FxPreset): string {
  return safeName(preset.type === 'vst3' ? (preset.plugin?.name ?? 'VST3') : fxDefinition(preset.type).name, 'Filter');
}

/** The file of a user preset id ("user:<folder>/<file stem>"); throws for anything outside `root`. */
function presetFile(root: string, id: string): string {
  if (!id.startsWith(USER_PREFIX)) throw new Error(`"${id}" is not one of your presets.`);
  const parts = id.slice(USER_PREFIX.length).split('/');
  if (parts.length !== 2 || parts.some((p) => !p || p !== path.basename(p) || p === '.' || p === '..')) throw new Error(`Invalid preset "${id}".`);
  return path.join(root, parts[0], `${parts[1]}.json`);
}

function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

interface Stored {
  id: string;
  file: string;
  preset: FxPreset;
}

function readAll(root: string): Stored[] {
  if (!fs.existsSync(root)) return [];
  const out: Stored[] = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(root, dir.name), { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith('.json')) continue;
      const file = path.join(root, dir.name, f.name);
      try {
        const stem = f.name.slice(0, -5);
        const preset = normalizePreset(JSON.parse(fs.readFileSync(file, 'utf8')), stem);
        if (preset) out.push({ id: `${USER_PREFIX}${dir.name}/${stem}`, file, preset });
      } catch {
        // not a preset, or unreadable: skip it
      }
    }
  }
  return out;
}

/** The user's presets for this filter, by name. */
export function listUserPresets(root: string, fx: Pick<Fx, 'type' | 'plugin'>): FxPresetEntry[] {
  const key = presetKey(fx);
  return readAll(root)
    .filter((s) => presetKeyOf(s.preset) === key)
    .map((s) => ({ id: s.id, name: s.preset.name, source: 'user' as const }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function loadUserPreset(root: string, id: string): FxPreset {
  const file = presetFile(root, id);
  if (!fs.existsSync(file)) throw new Error('That preset no longer exists.');
  const preset = normalizePreset(JSON.parse(fs.readFileSync(file, 'utf8')), path.basename(file, '.json'));
  if (!preset) throw new Error('That preset file could not be read.');
  return preset;
}

/** Where a preset goes: the file of a preset with the same name for the same filter, else a free file name. */
function destination(root: string, preset: FxPreset, all: Stored[], except?: string): { id: string; file: string; replaces: Stored | null } {
  const key = presetKeyOf(preset);
  const same = all.find((s) => s.id !== except && presetKeyOf(s.preset) === key && s.preset.name.toLowerCase() === preset.name.toLowerCase());
  if (same) return { id: same.id, file: same.file, replaces: same };
  const folder = groupFolder(preset);
  const stem = safeName(preset.name, 'Preset');
  const taken = new Set(all.filter((s) => s.id !== except).map((s) => s.file.toLowerCase()));
  let name = stem;
  for (let i = 2; taken.has(path.join(root, folder, `${name}.json`).toLowerCase()); i++) name = `${stem}-${i}`;
  return { id: `${USER_PREFIX}${folder}/${name}`, file: path.join(root, folder, `${name}.json`), replaces: null };
}

/** Saves a preset; one with the same name for the same filter is replaced. */
export function saveUserPreset(root: string, preset: FxPreset): FxPresetEntry & { replaced: boolean } {
  const clean = normalizePreset(preset);
  if (!clean) throw new Error('This filter cannot be saved as a preset.');
  const dest = destination(root, clean, readAll(root));
  writeJsonAtomic(dest.file, clean);
  return { id: dest.id, name: clean.name, source: 'user', replaced: !!dest.replaces };
}

export function renameUserPreset(root: string, id: string, name: string): FxPresetEntry {
  const clean = name.trim();
  if (!clean) throw new Error('Please give the preset a name.');
  const file = presetFile(root, id);
  const preset = { ...loadUserPreset(root, id), name: clean };
  const all = readAll(root);
  const dest = destination(root, preset, all, id);
  if (dest.replaces) throw new Error(`There already is a preset called "${dest.replaces.preset.name}".`);
  writeJsonAtomic(file, preset);
  if (path.resolve(dest.file) !== path.resolve(file)) {
    fs.mkdirSync(path.dirname(dest.file), { recursive: true });
    // a rename also works for case-only changes on case-insensitive file systems
    fs.renameSync(file, dest.file);
  }
  return { id: dest.id, name: clean, source: 'user' };
}

export function deleteUserPreset(root: string, id: string): void {
  const file = presetFile(root, id);
  if (!fs.existsSync(file)) throw new Error('That preset no longer exists.');
  fs.rmSync(file);
  // drop the folder once its last preset is gone
  const dir = path.dirname(file);
  if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
}
