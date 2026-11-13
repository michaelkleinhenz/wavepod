// What an export writes: the part of the episode (whole, selection, one region, every region),
// the file name and folder, and the files that will appear, so the dialog can list them and
// ask before replacing any.
import type { ExportSettings, Frames, Project, Region } from '../shared/types';
import { CHAPTER_FORMATS } from './chapters';
import { markersToChapters, projectLength } from './project';
import { regionOutputBase } from './regions';
import { STEM_GROUPS, stemFilePath } from './stems';

/** Which part of the episode to export. */
export type ExportRange =
  | { kind: 'all' }
  | { kind: 'selection' }
  | { kind: 'region'; regionId: string }
  | { kind: 'regions' };

/** One file set to render: the path without extension and the frames it covers (none: the whole episode). */
export interface ExportJob {
  outputBase: string;
  start?: Frames;
  end?: Frames;
  /** The region's title, for the progress line of a per-region export. */
  region?: string;
}

/** A track name made safe for a stem's file name. */
export function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'track';
}

/** A title made into a file name: "Episode 12: Tools" becomes "Episode 12 - Tools"; other characters no file system takes become "_". */
export function cleanFileName(name: string): string {
  return name
    .replace(/\s*:\s+/g, ' - ')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The name the dialog proposes: the episode's title, plus the region's for a single region. */
export function defaultExportName(project: Project, range: ExportRange): string {
  const episode = cleanFileName(project.metadata.title || project.name) || 'Episode';
  if (range.kind === 'region') {
    const r = project.regions?.find((x) => x.id === range.regionId);
    const title = r ? cleanFileName(r.title) : '';
    if (title) return `${episode} - ${title}`;
  }
  return episode;
}

/** Joins a folder and a file name with the folder's own separator (renderer code has no path module). */
export function joinExportPath(folder: string, name: string): string {
  if (!folder) return name;
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return folder.endsWith(sep) ? `${folder}${name}` : `${folder}${sep}${name}`;
}

/** The last part of a path, for showing file names. */
export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** The range still applies to the episode (a selection exists, the region wasn't deleted, there are regions). */
export function rangeAvailable(range: ExportRange, project: Project, selection: [Frames, Frames] | null): boolean {
  switch (range.kind) {
    case 'all':
      return true;
    case 'selection':
      return !!selection && selection[1] > selection[0];
    case 'region':
      return !!project.regions?.some((r) => r.id === range.regionId);
    case 'regions':
      return (project.regions?.length ?? 0) > 0;
  }
}

/** The frames a range covers ([start, end)); for every region, from the first start to the last end. */
export function rangeSpan(range: ExportRange, project: Project, selection: [Frames, Frames] | null): [Frames, Frames] {
  const whole: [Frames, Frames] = [0, projectLength(project)];
  if (!rangeAvailable(range, project, selection)) return whole;
  switch (range.kind) {
    case 'selection':
      return selection!;
    case 'region': {
      const r = project.regions!.find((x) => x.id === range.regionId)!;
      return [r.start, r.end];
    }
    case 'regions': {
      const list = project.regions!;
      return [Math.min(...list.map((r) => r.start)), Math.max(...list.map((r) => r.end))];
    }
    default:
      return whole;
  }
}

/** The renders an export runs: one, or one per region (each named "<name> - 01 Title"). */
export function exportJobs(range: ExportRange, project: Project, selection: [Frames, Frames] | null, base: string): ExportJob[] {
  if (!rangeAvailable(range, project, selection)) return [{ outputBase: base }];
  switch (range.kind) {
    case 'selection':
      return [{ outputBase: base, start: selection![0], end: selection![1] }];
    case 'region': {
      const r = project.regions!.find((x) => x.id === range.regionId)!;
      return [{ outputBase: base, start: r.start, end: r.end, region: r.title }];
    }
    case 'regions':
      return project.regions!.map((r: Region, i) => ({ outputBase: regionOutputBase(base, i, r.title), start: r.start, end: r.end, region: r.title }));
    default:
      return [{ outputBase: base }];
  }
}

/**
 * The files one job writes, in the exporter's order and naming: the mix in each format, the stems,
 * the chapter files (only when there are chapters in the range). Chapter images are left out.
 */
export function plannedFiles(project: Project, settings: ExportSettings, job: ExportJob): string[] {
  const base = job.outputBase;
  const out: string[] = [];
  for (const f of ['wav', 'flac', 'opus', 'mp3'] as const) if (settings.formats.includes(f)) out.push(`${base}.${f}`);
  if (settings.stems) {
    const ext = settings.stemFormat === 'flac' ? 'flac' : 'wav';
    if (settings.stemMode === 'dme') {
      for (const g of STEM_GROUPS) out.push(stemFilePath(base, g.id, ext));
      if (settings.stemMe) out.push(stemFilePath(base, 'me', ext));
    } else {
      project.tracks
        .filter((t) => t.clips.length > 0)
        .forEach((t, i) => out.push(`${base}-${String(i + 1).padStart(2, '0')}-${safeName(t.name)}.${ext}`));
    }
  }
  if (settings.video && project.cameras?.length) out.push(`${base}.mp4`);
  if (settings.chapterFiles) {
    const start = job.start ?? 0;
    const end = job.end ?? projectLength(project);
    const chapters = markersToChapters(project, start).filter((c) => c.start < (end - start) / project.sampleRate);
    if (chapters.length) for (const fmt of CHAPTER_FORMATS) out.push(`${base}.${fmt.ext}`);
  }
  return out;
}
