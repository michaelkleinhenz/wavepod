// Regions: named time spans (e.g. the parts of a long recording session) that can be exported as
// separate files. Stored in Project.regions, sorted by start.
import type { Frames, Project, Region } from '../shared/types';
import { uid } from '../shared/time';

function sorted(regions: Region[]): Region[] {
  return regions.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function addRegion(project: Project, start: Frames, end: Frames, title?: string): { project: Project; region: Region } {
  const p = structuredClone(project);
  const a = Math.max(0, Math.round(Math.min(start, end)));
  const b = Math.max(0, Math.round(Math.max(start, end)));
  const list = p.regions ?? [];
  const region: Region = { id: uid('rgn'), start: a, end: b, title: title ?? `Part ${list.length + 1}` };
  p.regions = sorted([...list, region]);
  return { project: p, region };
}

export function updateRegion(project: Project, id: string, patch: Partial<Omit<Region, 'id'>>): Project {
  const p = structuredClone(project);
  const r = p.regions?.find((x) => x.id === id);
  if (r) {
    Object.assign(r, patch);
    if (r.end < r.start) [r.start, r.end] = [r.end, r.start];
    sorted(p.regions!);
  }
  return p;
}

export const MAX_REGION_TITLE = 120;

/** Renames a region (whitespace tidied, capped); an empty title falls back to "Part n" by its position. */
export function renameRegion(project: Project, id: string, title: string): Project {
  const list = project.regions ?? [];
  const index = list.findIndex((r) => r.id === id);
  if (index < 0) return project;
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, MAX_REGION_TITLE);
  return updateRegion(project, id, { title: clean || `Part ${index + 1}` });
}

export function removeRegion(project: Project, id: string): Project {
  const p = structuredClone(project);
  p.regions = (p.regions ?? []).filter((r) => r.id !== id);
  return p;
}

/** Regions after removing [start, end) and closing the gap; regions inside it disappear. */
export function rippleDeleteRegions(regions: Region[], start: Frames, end: Frames): Region[] {
  const len = end - start;
  const f = (x: Frames) => (x < start ? x : x >= end ? x - len : start);
  return regions.map((r) => ({ ...r, start: f(r.start), end: f(r.end) })).filter((r) => r.end > r.start);
}

/** Regions after inserting `length` frames at `position`; a region spanning it grows. */
export function insertIntoRegionList(regions: Region[], position: Frames, length: Frames): Region[] {
  const f = (x: Frames) => (x >= position ? x + length : x);
  return regions.map((r) => ({ ...r, start: r.start >= position ? r.start + length : r.start, end: f(r.end) }));
}

/** Drops broken entries of hand-edited or older projects. */
export function normalizeRegions(raw: unknown): Region[] {
  if (!Array.isArray(raw)) return [];
  const out: Region[] = [];
  for (const r of raw as Array<Partial<Region>>) {
    if (!r || !Number.isFinite(r.start) || !Number.isFinite(r.end)) continue;
    const a = Math.max(0, Math.round(Math.min(r.start!, r.end!)));
    const b = Math.max(0, Math.round(Math.max(r.start!, r.end!)));
    if (b > a) out.push({ id: typeof r.id === 'string' ? r.id : uid('rgn'), start: a, end: b, title: typeof r.title === 'string' ? r.title : '' });
  }
  return sorted(out);
}

/** The output path (without extension) of region `index` (0-based): "<base> - 01 Title". */
export function regionOutputBase(base: string, index: number, title: string): string {
  const safe = title.replace(/[\\/:*?"<>|]+/g, '_').trim();
  return `${base} - ${String(index + 1).padStart(2, '0')}${safe ? ` ${safe}` : ''}`;
}
