// Editing filter stacks of tracks and the master bus. Pure: returns a new project.
import type { Fx, FxType, Project } from '../../shared/types';
import { createFx } from './definitions';

/** A track id, or 'master' for the master bus. */
export type FxTarget = string;
export const MASTER: FxTarget = 'master';

export function fxList(project: Project, target: FxTarget): Fx[] {
  if (target === MASTER) return project.masterFx ?? [];
  return project.tracks.find((t) => t.id === target)?.fx ?? [];
}

function withList(project: Project, target: FxTarget, fn: (list: Fx[]) => Fx[]): Project {
  if (target === MASTER) return { ...project, masterFx: fn(project.masterFx ?? []) };
  return { ...project, tracks: project.tracks.map((t) => (t.id === target ? { ...t, fx: fn(t.fx ?? []) } : t)) };
}

export function addFx(project: Project, target: FxTarget, type: FxType, index?: number): { project: Project; fx: Fx } {
  const fx = createFx(type);
  const p = withList(project, target, (l) => {
    const next = [...l];
    next.splice(index ?? next.length, 0, fx);
    return next;
  });
  return { project: p, fx };
}

/** Inserts a ready-made filter (e.g. a described VST3 plug-in). */
export function insertFx(project: Project, target: FxTarget, fx: Fx, index?: number): Project {
  return withList(project, target, (l) => {
    const next = [...l];
    next.splice(index ?? next.length, 0, fx);
    return next;
  });
}

export function updateFx(project: Project, target: FxTarget, id: string, patch: Partial<Pick<Fx, 'enabled' | 'params'>>): Project {
  return withList(project, target, (l) => l.map((f) => (f.id === id ? { ...f, ...patch, params: { ...f.params, ...(patch.params ?? {}) } } : f)));
}

export function removeFx(project: Project, target: FxTarget, id: string): Project {
  return withList(project, target, (l) => l.filter((f) => f.id !== id));
}

/** Moves a filter to position `to` in its stack. */
export function moveFx(project: Project, target: FxTarget, id: string, to: number): Project {
  return withList(project, target, (l) => {
    const from = l.findIndex((f) => f.id === id);
    if (from < 0) return l;
    const next = [...l];
    const [fx] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(next.length, to)), 0, fx);
    return next;
  });
}
