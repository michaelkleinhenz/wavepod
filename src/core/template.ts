// Project templates: a project's setup (tracks, input channels, filter stacks, soundboard) without any recorded material.
import type { BitDepth, EpisodeMetadata, Fx, Project, SoundboardSlot, Track } from '../shared/types';
import { uid } from '../shared/time';
import { createProject, normalizeProject } from './project';

/** A track as a template keeps it: everything except its clips (with their volume lines) and mute regions. */
export type TemplateTrack = Omit<Track, 'clips' | 'muteRegions'>;

export interface ProjectTemplate {
  version: 1;
  name: string;
  /** ISO date of the last save. */
  savedAt: string;
  /** Input device the channel mapping was made for, as a hint for the user. */
  inputDevice?: string;
  bitDepth: BitDepth;
  masterGain: number;
  masterFx: Fx[];
  tracks: TemplateTrack[];
  /** Slot files are relative to the template folder ("sounds/…") or absolute. */
  soundboard: SoundboardSlot[];
  /** Show-level metadata that stays the same from episode to episode. */
  metadata: Pick<EpisodeMetadata, 'podcast' | 'author' | 'artwork' | 'category'>;
}

export interface TemplateSummary {
  /** Folder name of the template. */
  id: string;
  name: string;
  savedAt: string;
  inputDevice?: string;
  trackCount: number;
  filterCount: number;
  slotCount: number;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Captures a project's setup as a template. Recorded audio, markers and timeline edits are left out. */
export function projectToTemplate(project: Project, name: string, inputDevice?: string, savedAt = new Date()): ProjectTemplate {
  const p = clone(project);
  return {
    version: 1,
    name,
    savedAt: savedAt.toISOString(),
    ...(inputDevice ? { inputDevice } : {}),
    bitDepth: p.bitDepth,
    masterGain: p.masterGain,
    masterFx: p.masterFx ?? [],
    tracks: p.tracks.map((t) => {
      // envelope/showEnvelope: per-track volume lines of an early version, now per clip
      const { clips: _c, muteRegions: _m, envelope: _e, showEnvelope: _s, ...rest } = t as Track & { envelope?: unknown; showEnvelope?: unknown };
      return { ...rest, solo: false };
    }),
    soundboard: p.soundboard,
    metadata: {
      podcast: p.metadata.podcast,
      author: p.metadata.author,
      ...(p.metadata.artwork ? { artwork: p.metadata.artwork } : {}),
      ...(p.metadata.category ? { category: p.metadata.category } : {}),
    },
  };
}

/** Fills defaults for templates saved by older versions or hand-edited files. */
export function normalizeTemplate(raw: Partial<ProjectTemplate>, fallbackName = 'Template'): ProjectTemplate {
  // Reuse the project normaliser for tracks, filters and the soundboard so both stay in step.
  const p = normalizeProject({
    bitDepth: raw.bitDepth,
    masterGain: raw.masterGain,
    masterFx: raw.masterFx,
    tracks: (Array.isArray(raw.tracks) ? raw.tracks : []).map((t) => ({ ...t, clips: [] }) as Track),
    soundboard: Array.isArray(raw.soundboard) ? raw.soundboard : [],
  });
  const t = projectToTemplate(p, typeof raw.name === 'string' && raw.name.trim() ? raw.name : fallbackName, raw.inputDevice);
  t.savedAt = typeof raw.savedAt === 'string' ? raw.savedAt : new Date(0).toISOString();
  t.metadata = {
    podcast: raw.metadata?.podcast ?? '',
    author: raw.metadata?.author ?? '',
    ...(typeof raw.metadata?.artwork === 'string' && raw.metadata.artwork ? { artwork: raw.metadata.artwork } : {}),
    ...(typeof raw.metadata?.category === 'string' && raw.metadata.category ? { category: raw.metadata.category } : {}),
  };
  t.soundboard = t.soundboard.filter((s) => s && typeof s.file === 'string');
  return t;
}

/**
 * Builds a new, empty project from a template. Filters get fresh ids so a VST3 instance of the
 * template's source project is never mixed up with the new one; track and slot ids are kept.
 */
export function projectFromTemplate(template: ProjectTemplate, name: string, sampleRate: number): Project {
  const t = clone(template);
  const base = createProject(name, sampleRate);
  const freshFx = (list: Fx[] | undefined) => (list ?? []).map((f) => ({ ...f, id: uid('fx') }));
  return normalizeProject({
    ...base,
    bitDepth: t.bitDepth,
    masterGain: t.masterGain,
    masterFx: freshFx(t.masterFx),
    tracks: t.tracks.map((tr) => ({ ...tr, fx: freshFx(tr.fx), clips: [] })),
    soundboard: t.soundboard,
    metadata: {
      ...base.metadata,
      podcast: t.metadata.podcast,
      author: t.metadata.author,
      ...(t.metadata.artwork ? { artwork: t.metadata.artwork } : {}),
      ...(t.metadata.category ? { category: t.metadata.category } : {}),
    },
  });
}

export function summarizeTemplate(id: string, t: ProjectTemplate): TemplateSummary {
  return {
    id,
    name: t.name,
    savedAt: t.savedAt,
    ...(t.inputDevice ? { inputDevice: t.inputDevice } : {}),
    trackCount: t.tracks.length,
    filterCount: t.masterFx.length + t.tracks.reduce((n, tr) => n + (tr.fx?.length ?? 0), 0),
    slotCount: t.soundboard.length,
  };
}

/** A folder name for a template name: keeps letters, digits, spaces, dashes and underscores. */
export function templateFolderName(name: string): string {
  return name.trim().replace(/[^\p{L}\p{N}_ -]+/gu, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 80) || 'Template';
}
