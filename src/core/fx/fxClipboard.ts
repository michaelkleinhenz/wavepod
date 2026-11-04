// Copying filters between tracks (and the master bus): one filter, or a whole stack.
// The clipboard holds complete filters, including a VST3 plug-in's own state and its parameter
// list, so a paste needs no plug-in host. Pure: returns a new project.
import type { Fx, Project } from '../../shared/types';
import { uid } from '../../shared/time';
import { normalizeFx } from './definitions';
import { presetKey } from './presets';
import { fxList, replaceFx, withList, type FxTarget } from './stack';

export interface FxClipboard {
  /** 'filter': one filter was copied; 'stack': a track's whole stack (paste can replace a stack). */
  kind: 'filter' | 'stack';
  items: Fx[];
  /** Name of the track (or "Master") it was copied from, for labels. */
  from: string;
}

/** Deep copy, so later edits to the source do not leak into the clipboard (or back). */
function cloneFx(fx: Fx): Fx {
  return JSON.parse(JSON.stringify(fx)) as Fx;
}

export function copyFilter(fx: Fx, from: string): FxClipboard {
  return { kind: 'filter', items: [cloneFx(fx)], from };
}

export function copyStack(project: Project, target: FxTarget, from: string): FxClipboard | null {
  const list = fxList(project, target);
  return list.length ? { kind: 'stack', items: list.map(cloneFx), from } : null;
}

/** Fresh filters from the clipboard, each with a new id so they are independent of the originals. */
function freshCopies(clip: FxClipboard): Fx[] {
  return clip.items.flatMap((fx) => {
    const n = normalizeFx({ ...cloneFx(fx), id: uid('fx') });
    return n ? [n] : [];
  });
}

function setList(project: Project, target: FxTarget, list: Fx[]): Project {
  return withList(project, target, () => list);
}

/**
 * Pastes the clipboard's filters into a stack: appended at the end, inserted at `index`, or
 * replacing every filter the stack has.
 */
export function pasteFilters(project: Project, target: FxTarget, clip: FxClipboard, mode: 'append' | 'replace' | { index: number } = 'append'): Project {
  const copies = freshCopies(clip);
  if (!copies.length) return project;
  if (mode === 'replace') return setList(project, target, copies);
  const next = [...fxList(project, target)];
  const at = mode === 'append' ? next.length : Math.max(0, Math.min(next.length, mode.index));
  next.splice(at, 0, ...copies);
  return setList(project, target, next);
}

/** The copied filter whose settings can go onto `fx`: same built-in type, or the same VST3 plug-in. */
export function settingsSource(clip: FxClipboard | null, fx: Fx): Fx | null {
  if (!clip || clip.kind !== 'filter') return null;
  const src = clip.items[0];
  return src && src.id !== fx.id && presetKey(src) === presetKey(fx) ? src : null;
}

/**
 * Gives an existing filter the copied filter's settings (values, VST3 state, preset label), keeping
 * its place in the stack and whether it is bypassed.
 */
export function pasteSettings(project: Project, target: FxTarget, fxId: string, clip: FxClipboard): Project {
  const fx = fxList(project, target).find((f) => f.id === fxId);
  const src = fx && settingsSource(clip, fx);
  if (!fx || !src) return project;
  const copy = cloneFx(src);
  const next: Fx = { ...copy, id: fx.id, enabled: fx.enabled };
  // keep this filter's own plug-in reference (its path on this machine); the plug-in is the same
  if (fx.type === 'vst3' && fx.plugin) next.plugin = fx.plugin;
  if (!copy.preset) delete next.preset;
  return replaceFx(project, target, normalizeFx(next) ?? next);
}

/** Short description of what the clipboard holds, e.g. "Compressor" or "3 filters from Host". */
export function clipboardLabel(clip: FxClipboard, name: (fx: Fx) => string): string {
  if (clip.kind === 'filter') return name(clip.items[0]);
  const n = clip.items.length;
  return `${n} filter${n === 1 ? '' : 's'} from ${clip.from}`;
}
